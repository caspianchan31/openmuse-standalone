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
import type { BeginResult, ChatStore, RunStatus } from "./chat-store.ts";
import { messageIdsOf, persistedRunEvents, startedEvent, withRunIdentity } from "./events.ts";
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
const closeCapMs = 5000;

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

function messageIdOf(event: BaseEvent): string | undefined {
  const id = (event as { messageId?: unknown }).messageId;
  return typeof id === "string" ? id : undefined;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export class LocalAgentRunner extends AgentRunner implements StandaloneRunControl {
  readonly instanceId: string;
  /** Backoff before each retry of a failed close statement (3 retries). Tests shorten it. */
  closeRetryDelaysMs = [500, 1000, 2000];
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly sweepMs: number;
  private readonly flushMs: number;
  private readonly active = new Map<string, ActiveRun>();
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
    // Capture the live run first: it is excluded from the stored history read below, and its
    // ReplaySubject replays it from the start, so nothing is lost or sent twice.
    const local = this.active.get(request.threadId);
    void this.replay(request.threadId, local, subject).catch((error) => {
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
    if (row.claimed) return { ok: true };
    if (row.owner !== null && row.owner !== input.owner) return { ok: false, reason: "forbidden" };
    return { ok: false, reason: "locked" };
  }

  async release(threadId: string, runId: string): Promise<void> {
    await this.store.releaseClaim(threadId, runId);
  }

  // ---- Lifecycle ----

  /** Recovers stale runs once, then starts the heartbeat and sweep timers (unref'd). */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    // Locks under this instance id belong to a previous process: nothing of ours runs yet.
    await this.sweep(this.instanceId);
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
    await Promise.race([Promise.all(this.starting), delay(closeCapMs)]);
    const runs = [...this.active.values()];
    for (const run of runs) {
      run.closing = true;
      run.stopRequested = false;
      try {
        run.agent.abortRun();
      } catch (error) {
        backgroundFailure("standalone chat abort", error);
      }
    }
    await Promise.all(
      runs.map(async (run) => {
        await Promise.race([run.done, delay(closeCapMs)]);
        // An agent that ignores abort is finalized without it; its later events are dropped.
        if (!run.finalized)
          await Promise.race([this.finalize(run, restartingMessage), delay(closeCapMs)]);
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
    try {
      run.agent.abortRun();
    } catch (error) {
      backgroundFailure("standalone chat abort", error);
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
   * lock is left to go stale, so a sweep closes the run from its journal.
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

  private async closeWithRetry(input: Parameters<ChatStore["closeRun"]>[0]): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.store.closeRun(input);
        return true;
      } catch (error) {
        backgroundFailure("standalone chat save", error);
        const wait = this.closeRetryDelaysMs[attempt];
        if (wait === undefined) return false;
        await delay(wait);
      }
    }
  }

  // ---- Connect ----

  private async replay(
    threadId: string,
    captured: ActiveRun | undefined,
    subject: ReplaySubject<BaseEvent>,
  ) {
    const runs = await this.store.closedRunEvents(threadId, captured?.runId);
    const emitted = new Set<string>();
    for (const event of compactEvents(runs.flat())) {
      subject.next(event);
      const id = messageIdOf(event);
      if (id) emitted.add(id);
    }
    // A run that began after the capture is tailed too, unless the history read already saw it.
    const live = captured ?? this.active.get(threadId);
    const stored = (run: ActiveRun) =>
      runs.some((events) => events.some((e) => (e as { runId?: unknown }).runId === run.runId));
    if (live && (live === captured || !stored(live))) {
      live.subject.subscribe({
        next: (event) => {
          const id = messageIdOf(event);
          if (id && emitted.has(id)) return;
          subject.next(event);
        },
        complete: () => subject.complete(),
        error: (error) => subject.error(error),
      });
      return;
    }
    // A run held by another process: send what its journal holds (no cross-process live tail).
    const journal = live ? null : await this.store.runningJournal(threadId);
    if (journal && journal.length > 0) {
      for (const event of compactEvents(journal)) {
        const id = messageIdOf(event);
        if (id && emitted.has(id)) continue;
        subject.next(event);
      }
    }
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

  /** Recovers stale locks and applies retention. Never throws. */
  async sweep(deadInstance?: string): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      try {
        const stale = await this.store.staleRuns(this.staleAfterMs, deadInstance);
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
