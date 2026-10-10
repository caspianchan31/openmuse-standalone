// Standalone: a persistent AgentRunner for the SSE runtime, backed by ChatStore.
// Implements only the async run/connect/isRunning/stop contract (not LocalThreadEndpointRunner,
// whose synchronous methods a database cannot satisfy); thread listing lives in thread-routes.ts.
// Semantics follow the runtime's InMemoryAgentRunner (1.70.1), plus: the thread lock lives in the
// database, a running run is journaled, and the terminal event is sent only after the run is saved.
import { randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  compactEvents,
  EventType,
  type Message,
  type RunStartedEvent,
} from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  finalizeRunEvents,
} from "@copilotkit/runtime/v2";
import { type Observable, ReplaySubject } from "rxjs";
import { backgroundFailure } from "../log.ts";
import type { BeginResult, ChatStore, DeadLocks, RunStatus } from "./chat-store.ts";
import {
  messageIdsOf,
  persistedRunEvents,
  replayedRun,
  startedEvent,
  withRunIdentity,
} from "./events.ts";
import {
  type ClaimResult,
  type LocalRunnerOptions,
  type StandaloneRunControl,
  threadLockedCode,
} from "./types.ts";

export const lockedMessage = "This conversation is still replying. Try again when it finishes.";
export const persistenceFailedMessage =
  "This reply could not be saved. It may be missing after a reload.";
export const persistenceFailedCode = "persistence_failed";
const restartingMessage = "The server is restarting.";
const crashedMessage = "The server stopped before this reply finished.";
const startFailedMessage = "This conversation could not be started. Try again.";
const journalBatch = 64;

interface ActiveRun {
  threadId: string;
  runId: string;
  agent: AbstractAgent;
  subject: ReplaySubject<BaseEvent>;
  newMessages: Message[];
  /** Every event of the run, in order (finalizeRunEvents appends to it). */
  events: BaseEvent[];
  /** The terminal event and anything after it, sent once the run is saved. */
  held: BaseEvent[];
  /** Events not yet written to the journal. */
  pending: BaseEvent[];
  journalSeq: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  flushChain: Promise<void>;
  stopRequested: boolean;
  /** Interrupted by close(): saved as "interrupted". */
  closing: boolean;
  finalized: boolean;
  done: Promise<void>;
  markDone: () => void;
}

/** A claim this process took whose run has not begun yet. */
interface PendingClaim {
  runId: string;
  begun: Promise<void>;
  settle: () => void;
}

interface Begun {
  run: ActiveRun;
  historic: Set<string>;
  stopRequested: boolean;
}

function runError(message: string, code?: string): BaseEvent {
  return { type: EventType.RUN_ERROR, message, ...(code ? { code } : {}) } as BaseEvent;
}

function isTerminal(event: BaseEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export class LocalAgentRunner extends AgentRunner implements StandaloneRunControl {
  readonly instanceId: string;
  /** Backoff before each retry of a failed close statement (3 retries). Tests shorten it. */
  closeRetryDelaysMs = [500, 1000, 2000];
  /** Longest wait for one shutdown step, and for a connect waiting on a claimed run to begin. */
  closeCapMs = 5000;
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly sweepMs: number;
  private readonly flushMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly claimed = new Map<string, PendingClaim>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private started = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly starting = new Set<Promise<void>>();
  private beating = false;
  private sweeping?: Promise<void>;

  constructor(
    readonly store: ChatStore,
    readonly options: LocalRunnerOptions = {},
  ) {
    super();
    this.instanceId = options.instanceId ?? randomUUID();
    this.heartbeatMs = options.heartbeatMs ?? 5000;
    this.staleAfterMs = options.staleAfterMs ?? 30000;
    this.sweepMs = options.sweepMs ?? 15000;
    this.flushMs = options.flushMs ?? 250;
  }

  // ---- AgentRunner ----

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    void this.execute(request, subject).catch((error) => {
      // execute handles its own failures; this is a last resort so a stream never hangs.
      backgroundFailure("standalone chat run", error);
      subject.next(runError(startFailedMessage));
      subject.complete();
    });
    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    void this.replay(request.threadId, subject).catch((error) => {
      backgroundFailure("standalone chat connect", error);
      subject.error(error);
    });
    return subject.asObservable();
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    if (this.active.has(request.threadId)) return true;
    return this.store.isLocked(request.threadId);
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const local = this.active.get(request.threadId);
    if (local) {
      if (request.runId !== undefined && request.runId !== local.runId) return false;
      if (local.stopRequested || local.finalized || local.closing) return false;
      this.abort(local);
      return true;
    }
    // Held by another instance (or claimed and about to begin): it honours the flag on its next
    // heartbeat, or right after it begins.
    return this.store.requestStop(request.threadId, request.runId);
  }

  // ---- StandaloneRunControl ----

  async claim(input: {
    owner: string;
    threadId: string;
    agentId: string;
    runId: string;
  }): Promise<ClaimResult> {
    const attempt = () =>
      this.store.claimRun({
        ...input,
        instanceId: this.instanceId,
        staleAfterMs: this.staleAfterMs,
      });
    let row = await attempt();
    for (let retry = 0; !row.claimed && retry < 2; retry++) {
      if (row.owner !== null && row.owner !== input.owner) break;
      if (row.owner === null) {
        // Inserted concurrently after this statement's snapshot: look again.
        row = await attempt();
        continue;
      }
      if (!row.stale || !row.holder || this.isLocalRun(input.threadId, row.holder)) break;
      // Take over a dead lock only after saving what its journal holds.
      await this.recover(input.threadId, row.holder, this.staleAfterMs);
      row = await attempt();
    }
    if (row.claimed) {
      this.trackClaim(input.threadId, input.runId);
      return { ok: true };
    }
    if (row.owner !== null && row.owner !== input.owner) return { ok: false, reason: "forbidden" };
    return { ok: false, reason: "locked" };
  }

  async release(threadId: string, runId: string): Promise<void> {
    this.settleClaim(threadId, runId);
    await this.store.releaseClaim(threadId, runId);
  }

  /** Remembers a claim until its run begins, so a connect in between waits for the run. */
  private trackClaim(threadId: string, runId: string) {
    let resolve = () => {};
    const entry: PendingClaim = {
      runId,
      begun: new Promise<void>((done) => {
        resolve = done;
      }),
      settle: () => {
        if (this.claimed.get(threadId) === entry) this.claimed.delete(threadId);
        resolve();
      },
    };
    this.claimed.get(threadId)?.settle();
    this.claimed.set(threadId, entry);
    // A claim whose run never begins and is never released (its request failed in between) is
    // forgotten once its lock would be stale.
    setTimeout(entry.settle, this.staleAfterMs).unref();
  }

  private settleClaim(threadId: string, runId: string) {
    const entry = this.claimed.get(threadId);
    if (entry?.runId === runId) entry.settle();
  }

  // ---- Lifecycle ----

  /** Recovers stale runs once, then starts the heartbeat and sweep timers (unref'd). */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    // Nothing of ours runs yet, so locks under this instance id belong to a previous process; when
    // no other process can use the database (embedded PGlite), every lock does.
    await this.sweep(this.options.exclusive ? { all: true } : { instanceId: this.instanceId });
    const heartbeat = setInterval(() => void this.heartbeat(), this.heartbeatMs);
    const sweep = setInterval(() => void this.sweep(), this.sweepMs);
    heartbeat.unref();
    sweep.unref();
    this.timers.push(heartbeat, sweep);
  }

  /** Stops timers and saves in-flight local runs as interrupted, ending their SSE streams. */
  async close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const claim of [...this.claimed.values()]) claim.settle();
    await Promise.race([Promise.all(this.starting), delay(this.closeCapMs)]);
    const runs = [...this.active.values()];
    for (const run of runs) {
      run.closing = true;
      run.stopRequested = false;
      this.cancel(run);
    }
    await Promise.all(
      runs.map(async (run) => {
        await Promise.race([run.done, delay(this.closeCapMs)]);
        // An agent that ignores abort is finalized without it; its later events are dropped.
        if (!run.finalized)
          await Promise.race([this.finalize(run, restartingMessage), delay(this.closeCapMs)]);
      }),
    );
    if (this.sweeping) await this.sweeping;
    try {
      await this.store.releaseInstanceClaims(this.instanceId);
    } catch (error) {
      backgroundFailure("standalone chat release claims", error);
    }
  }

  // ---- Run ----

  private async execute(request: AgentRunnerRunRequest, subject: ReplaySubject<BaseEvent>) {
    // close() waits for runs that are still starting, so none slips past a shutdown.
    let started = () => {};
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    this.starting.add(starting);
    let begun: Begun | undefined;
    try {
      begun = await this.begin(request, subject);
    } finally {
      this.starting.delete(starting);
      started();
      this.settleClaim(request.threadId, request.input.runId);
    }
    if (!begun) return;
    const { run, historic } = begun;
    if (this.closed) {
      run.closing = true;
      return this.finalize(run, restartingMessage);
    }
    let interruption: string | undefined;
    try {
      const running = run.agent.runAgent(request.input, {
        onEvent: ({ event }) => {
          this.onEvent(run, event, historic, request.input);
        },
      });
      if (begun.stopRequested) this.abort(run);
      await running;
    } catch (error) {
      interruption = error instanceof Error ? error.message : String(error);
    }
    await this.finalize(run, interruption);
  }

  /** Takes the thread for the run and registers it, or ends the stream with a RUN_ERROR. */
  private async begin(
    request: AgentRunnerRunRequest,
    subject: ReplaySubject<BaseEvent>,
  ): Promise<Begun | undefined> {
    const { threadId, agent, input } = request;
    const runId = input.runId;
    const refuse = (event: BaseEvent) => {
      subject.next(event);
      subject.complete();
      return undefined;
    };
    if (this.closed) {
      await this.store.releaseClaim(threadId, runId).catch(() => undefined);
      return refuse(runError(restartingMessage));
    }
    let historic: Set<string>;
    let newMessages: Message[];
    let result: BeginResult;
    try {
      historic = new Set(await this.store.historicMessageIds(threadId));
      newMessages = (input.messages ?? []).filter((message) => !historic.has(message.id));
      const attempt = () =>
        this.store.beginRun({
          threadId,
          runId,
          instanceId: this.instanceId,
          started: startedEvent({ threadId, runId, newMessages }),
          staleAfterMs: this.staleAfterMs,
        });
      result = await attempt();
      if (
        result.status === "locked" &&
        result.stale &&
        result.holder &&
        !this.isLocalRun(threadId, result.holder)
      ) {
        await this.recover(threadId, result.holder, this.staleAfterMs);
        result = await attempt();
      }
    } catch (error) {
      backgroundFailure("standalone chat begin", error);
      await this.store.releaseClaim(threadId, runId).catch(() => undefined);
      return refuse(runError(startFailedMessage));
    }
    if (result.status === "locked") return refuse(runError(lockedMessage, threadLockedCode));
    if (result.status === "missing") return refuse(runError("This conversation was not found."));
    if (result.status === "duplicate") {
      await this.store.releaseClaim(threadId, runId).catch(() => undefined);
      return refuse(runError("This reply was already sent."));
    }
    let markDone = () => {};
    const run: ActiveRun = {
      threadId,
      runId,
      agent,
      subject,
      newMessages,
      events: [],
      held: [],
      pending: [],
      journalSeq: 0,
      flushChain: Promise.resolve(),
      stopRequested: false,
      closing: false,
      finalized: false,
      done: new Promise<void>((resolve) => {
        markDone = resolve;
      }),
      markDone: () => markDone(),
    };
    this.active.set(threadId, run);
    return { run, historic, stopRequested: result.stopRequested };
  }

  private onEvent(
    run: ActiveRun,
    event: BaseEvent,
    historic: Set<string>,
    input: AgentRunnerRunRequest["input"],
  ) {
    if (run.finalized) return;
    // A stop or shutdown that came before the agent's stream was set up could not detach it yet.
    if (run.stopRequested || run.closing) this.detach(run);
    if (event.type === EventType.RUN_STARTED) {
      // As InMemoryAgentRunner: a RUN_STARTED without input carries the request input with only
      // the messages new to the thread.
      const started = event as RunStartedEvent;
      if (!started.input) {
        started.input = {
          ...input,
          ...(input.messages
            ? { messages: input.messages.filter((message) => !historic.has(message.id)) }
            : {}),
        };
      }
    }
    run.events.push(event);
    if (run.held.length > 0 || isTerminal(event)) run.held.push(event);
    else run.subject.next(event);
    run.pending.push(event);
    this.scheduleFlush(run);
  }

  private abort(run: ActiveRun) {
    run.stopRequested = true;
    this.cancel(run);
  }

  /**
   * Ends the agent's run: abortRun for agents that implement it, then detaches the run, which
   * unsubscribes from the agent's stream. AbstractAgent.abortRun is a no-op, and ConversationAgent
   * cancels its model stream only when unsubscribed. runAgent then resolves and the run finalizes.
   */
  private cancel(run: ActiveRun) {
    try {
      run.agent.abortRun();
    } catch (error) {
      backgroundFailure("standalone chat abort", error);
    }
    this.detach(run);
  }

  private detach(run: ActiveRun) {
    try {
      void run.agent.detachActiveRun().catch((error: unknown) => {
        backgroundFailure("standalone chat detach", error);
      });
    } catch (error) {
      backgroundFailure("standalone chat detach", error);
    }
  }

  private scheduleFlush(run: ActiveRun) {
    if (run.pending.length >= journalBatch) {
      if (run.flushTimer) clearTimeout(run.flushTimer);
      run.flushTimer = undefined;
      this.flush(run);
      return;
    }
    if (run.flushTimer) return;
    run.flushTimer = setTimeout(() => {
      run.flushTimer = undefined;
      this.flush(run);
    }, this.flushMs);
    run.flushTimer.unref();
  }

  /** Writes pending events to the journal; serialised per run, a failure retries with the next batch. */
  private flush(run: ActiveRun): Promise<void> {
    run.flushChain = run.flushChain.then(async () => {
      if (run.pending.length === 0) return;
      const batch = run.pending.splice(0);
      try {
        await this.store.appendJournal(run.runId, run.journalSeq, batch);
        run.journalSeq += batch.length;
      } catch (error) {
        run.pending.unshift(...batch);
        backgroundFailure("standalone chat journal", error);
      }
    });
    return run.flushChain;
  }

  /**
   * Saves the run (one close statement, retried) and only then sends the held terminal event and
   * ends the stream. If the save keeps failing, the stream ends with persistence_failed and the
   * lock is left to go stale, so a sweep closes the run from its journal. If another process had
   * already recovered the run from its journal (its lock went stale), the stored reply is that
   * shorter one, so the stream ends with persistence_failed too.
   */
  private async finalize(run: ActiveRun, interruption?: string): Promise<void> {
    if (run.finalized) return;
    run.finalized = true;
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = undefined;
    await run.flushChain;
    const message = run.closing ? restartingMessage : interruption;
    const appended = finalizeRunEvents(run.events, {
      stopRequested: run.stopRequested,
      ...(message !== undefined ? { interruptionMessage: message } : {}),
    }).map((event) => withRunIdentity(event, run.threadId, run.runId));
    // finalizeRunEvents appended to run.events in place; keep the identity-filled copies.
    run.events.splice(run.events.length - appended.length, appended.length, ...appended);
    const status: Exclude<RunStatus, "running"> = run.closing
      ? "interrupted"
      : run.stopRequested
        ? "stopped"
        : run.events.find(isTerminal)?.type === EventType.RUN_ERROR
          ? "error"
          : "finished";
    const events = persistedRunEvents(run.events, run);
    const saved = await this.closeWithRetry({
      threadId: run.threadId,
      runId: run.runId,
      status,
      events,
      messageIds: messageIdsOf(events),
    });
    if (saved) {
      for (const event of [...run.held, ...appended]) run.subject.next(event);
    } else {
      // Keep the journal complete for the sweep that will recover this run.
      run.pending.push(...appended);
      await this.flush(run);
      for (const event of appended) if (!isTerminal(event)) run.subject.next(event);
      run.subject.next(runError(persistenceFailedMessage, persistenceFailedCode));
    }
    run.subject.complete();
    if (this.active.get(run.threadId) === run) this.active.delete(run.threadId);
    run.markDone();
  }

  /** True once this run's events are saved; false when they were not (failed, or closed elsewhere). */
  private async closeWithRetry(input: Parameters<ChatStore["closeRun"]>[0]): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.store.closeRun(input)).closed;
      } catch (error) {
        backgroundFailure("standalone chat save", error);
        const wait = this.closeRetryDelaysMs[attempt];
        if (wait === undefined) return false;
        await delay(wait);
      }
    }
  }

  // ---- Connect ----

  private async replay(threadId: string, subject: ReplaySubject<BaseEvent>) {
    // A run this process claimed but has not begun yet (one statement away): wait for it, so the
    // connect tails it instead of finding the thread idle.
    const pending = this.claimed.get(threadId);
    if (pending) await Promise.race([pending.begun, delay(this.closeCapMs)]);
    // Capture the live run before the history read: it is excluded from that read, and its
    // ReplaySubject replays it from the start, so nothing is lost or sent twice.
    const captured = this.active.get(threadId);
    const runs = await this.store.closedRunEvents(threadId, captured?.runId);
    for (const event of compactEvents(runs.flatMap(replayedRun))) subject.next(event);
    // A run that began after the capture is tailed too, unless the history read already saw it.
    const live = captured ?? this.active.get(threadId);
    const stored = (run: ActiveRun) =>
      runs.some((events) => events.some((e) => (e as { runId?: unknown }).runId === run.runId));
    if (live && (live === captured || !stored(live))) {
      live.subject.subscribe({
        next: (event) => subject.next(event),
        complete: () => subject.complete(),
        error: (error) => subject.error(error),
      });
      return;
    }
    // A run held by another process: send what its journal holds (no cross-process live tail).
    const journal = live ? null : await this.store.runningJournal(threadId);
    if (journal) for (const event of compactEvents(journal)) subject.next(event);
    subject.complete();
  }

  // ---- Background ----

  private isLocalRun(threadId: string, runId: string): boolean {
    return this.active.get(threadId)?.runId === runId;
  }

  private async heartbeat(): Promise<void> {
    if (this.beating || this.closed) return;
    this.beating = true;
    try {
      // Runs stay heartbeated while they save; one whose save failed has left `active` already.
      const runs = [...this.active.values()];
      const rows = await this.store.heartbeat(
        this.instanceId,
        runs.map((run) => run.runId),
      );
      for (const row of rows) {
        if (!row.stopRequested) continue;
        const run = this.active.get(row.threadId);
        if (run && run.runId === row.runId && !run.stopRequested && !run.finalized) this.abort(run);
      }
    } catch (error) {
      backgroundFailure("standalone chat heartbeat", error);
    } finally {
      this.beating = false;
    }
  }

  /** Recovers stale locks (and every lock of a dead holder) and applies retention. Never throws. */
  async sweep(dead?: DeadLocks): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      try {
        const stale = await this.store.staleRuns(this.staleAfterMs, dead);
        for (const lock of stale) {
          if (this.isLocalRun(lock.threadId, lock.runId)) continue;
          try {
            await this.recover(
              lock.threadId,
              lock.runId,
              lock.guarded ? this.staleAfterMs : undefined,
            );
          } catch (error) {
            backgroundFailure("standalone chat recovery", error);
          }
        }
      } catch (error) {
        backgroundFailure("standalone chat sweep", error);
      }
      if (this.options.retentionDays !== undefined) {
        try {
          await this.store.purgeRuns(this.options.retentionDays);
        } catch (error) {
          backgroundFailure("standalone chat retention", error);
        }
      }
    })().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  /**
   * Closes a dead run from its journal as "interrupted" (an interruption message is appended),
   * or just releases a claim whose run never began. staleAfterMs guards against a live holder.
   */
  private async recover(threadId: string, runId: string, staleAfterMs?: number): Promise<void> {
    const running = await this.store.runningRun(threadId, runId);
    if (!running) {
      await this.store.closeRun({
        threadId,
        runId,
        status: "interrupted",
        events: [],
        messageIds: [],
        staleAfterMs,
      });
      return;
    }
    const journal = running.journal;
    finalizeRunEvents(journal, { interruptionMessage: crashedMessage });
    const stored = (running.started as RunStartedEvent | null)?.input?.messages;
    const newMessages = Array.isArray(stored) ? stored : [];
    const events = persistedRunEvents(journal, { threadId, runId, newMessages });
    await this.store.closeRun({
      threadId,
      runId,
      status: "interrupted",
      events,
      messageIds: messageIdsOf(events),
      staleAfterMs,
    });
  }
}
