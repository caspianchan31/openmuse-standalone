import assert from "node:assert/strict";
import { after, afterEach, before, type TestContext, test } from "node:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import type { Store } from "../apps/server/src/db.ts";
import { ChatStore } from "../apps/server/src/standalone/chat-store.ts";
import {
  messagesFromEvents,
  stateFromEvents,
  toWireMessages,
} from "../apps/server/src/standalone/events.ts";
import { createStandaloneChat } from "../apps/server/src/standalone/index.ts";
import {
  historyUnavailableMessage,
  LocalAgentRunner,
  lockedMessage,
  persistenceFailedCode,
} from "../apps/server/src/standalone/runner.ts";
import {
  historyUnavailableCode,
  type LocalRunnerOptions,
} from "../apps/server/src/standalone/types.ts";
import { createChatTestStore } from "./helpers/chat-database.ts";

type Step = { event: Record<string, unknown> } | { gate: Promise<void> } | { fail: string };

/** A scripted agent: emits its steps, waits at gates, and ends with AbortError when aborted. */
class FakeAgent extends AbstractAgent {
  aborts = 0;
  /** Times the runner unsubscribed from (or completed) a run's stream. */
  teardowns = 0;
  private stopCurrent?: () => void;
  private abortEarly = false;

  constructor(public script: (input: RunAgentInput) => Step[]) {
    super({ agentId: "default" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let stopped = false;
      const abort = () => {
        if (stopped) return;
        stopped = true;
        const error = new Error("aborted");
        error.name = "AbortError";
        subscriber.error(error);
      };
      this.stopCurrent = abort;
      if (this.abortEarly) {
        abort();
        return;
      }
      void (async () => {
        for (const step of this.script(input)) {
          if (stopped) return;
          if ("gate" in step) {
            await step.gate;
            continue;
          }
          if ("fail" in step) {
            stopped = true;
            subscriber.error(new Error(step.fail));
            return;
          }
          subscriber.next(step.event as unknown as BaseEvent);
          await Promise.resolve();
        }
        if (!stopped) subscriber.complete();
      })();
      return () => {
        stopped = true;
        this.teardowns++;
      };
    });
  }

  override abortRun() {
    this.aborts++;
    if (this.stopCurrent) this.stopCurrent();
    else this.abortEarly = true;
  }

  override clone(): FakeAgent {
    const copy = super.clone() as FakeAgent;
    copy.script = this.script;
    copy.aborts = 0;
    copy.teardowns = 0;
    return copy;
  }
}

/** Like ConversationAgent: abortRun is AbstractAgent's no-op; only unsubscribing ends its stream. */
class DeafAgent extends FakeAgent {
  override abortRun() {
    this.aborts++;
  }
}

/** Ignores abortRun and detachActiveRun alike: only shutdown's cap ends its run. */
class StuckAgent extends DeafAgent {
  override async detachActiveRun() {}
}

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

const started = (input: RunAgentInput): Step => ({
  event: { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
});
const finished = (input: RunAgentInput): Step => ({
  event: { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
});
const textStart = (id: string): Step => ({
  event: { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
});
const textDelta = (id: string, delta: string): Step => ({
  event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta },
});
const textEnd = (id: string): Step => ({
  event: { type: EventType.TEXT_MESSAGE_END, messageId: id },
});

/** A reply agent: one assistant message from the deltas, optionally pausing before the last one. */
function replyAgent(messageId: string, deltas: string[], pause?: Promise<void>) {
  return new FakeAgent((input) => [
    started(input),
    textStart(messageId),
    ...deltas.slice(0, -1).map((delta) => textDelta(messageId, delta)),
    ...(pause ? [{ gate: pause }] : []),
    textDelta(messageId, deltas.at(-1) ?? "."),
    textEnd(messageId),
    finished(input),
  ]);
}

const user = (id: string, content: string): Message => ({ id, role: "user", content });

/** What the runtime's run handler does before calling runner.run. */
function request(agent: AbstractAgent, threadId: string, runId: string, messages: Message[] = []) {
  const input: RunAgentInput = {
    threadId,
    runId,
    messages,
    state: {},
    tools: [{ name: "lookup", description: "Look something up", parameters: { type: "object" } }],
    context: [{ description: "timezone", value: "UTC" }],
    forwardedProps: { clientOnly: true },
  };
  agent.setMessages(messages);
  agent.setState({});
  agent.threadId = threadId;
  return { threadId, agent, input };
}

function collect(observable: Observable<BaseEvent>) {
  const events: BaseEvent[] = [];
  const state = { done: false };
  const finished = new Promise<BaseEvent[]>((resolve, reject) => {
    observable.subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => {
        state.done = true;
        resolve(events);
      },
    });
  });
  return { events, finished, state };
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The promise's value, or a failure after timeoutMs, so a regression fails instead of hanging. */
async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const field = (event: BaseEvent | undefined, name: string) =>
  (event as Record<string, unknown> | undefined)?.[name];
const types = (events: BaseEvent[]) => events.map((event) => event.type);
const hasDelta = (events: BaseEvent[], delta: string) =>
  events.some((event) => field(event, "delta") === delta);
const isTerminalEvent = (event: BaseEvent) =>
  event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;

let db: Store;
let chats: ChatStore;
const runners: LocalAgentRunner[] = [];

function make(options: LocalRunnerOptions = {}) {
  const runner = new LocalAgentRunner(chats, { flushMs: 5, ...options });
  runner.closeRetryDelaysMs = [5, 5, 5];
  runners.push(runner);
  return runner;
}

async function runRow(runId: string) {
  const rows = await db.sql<{ status: string; events: BaseEvent[]; message_ids: string[] }>(
    "SELECT status, events, message_ids FROM chat_runs WHERE run_id=$1",
    [runId],
  );
  return rows[0];
}

async function journalCount(runId: string) {
  const rows = await db.sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM chat_events WHERE run_id=$1",
    [runId],
  );
  return rows[0]?.n ?? 0;
}

before(async () => {
  db = await createChatTestStore();
  chats = await ChatStore.open(db);
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
});

after(async () => {
  await db.close();
});

test("a run is persisted and replayed by a new runner instance after a restart", async () => {
  await chats.ensureThread("alice", "t-restart", "default");
  const first = make();
  const live = await collect(
    first.run(request(replyAgent("a1", ["Hel", "lo"]), "t-restart", "r1", [user("u1", "Hi")])),
  ).finished;
  assert.deepEqual(types(live), [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
  ]);
  await first.close();

  const restarted = make();
  await restarted.start();
  const replay = await collect(restarted.connect({ threadId: "t-restart" })).finished;
  assert.deepEqual(types(replay), [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
  ]);
  assert.equal(field(replay[2], "delta"), "Hello");
  assert.deepEqual(toWireMessages(messagesFromEvents(replay)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Hello" },
  ]);
  assert.equal(await restarted.isRunning({ threadId: "t-restart" }), false);
  const row = await runRow("r1");
  assert.equal(row?.status, "finished");
  assert.deepEqual(row?.message_ids, ["u1", "a1"]);
  assert.equal(await journalCount("r1"), 0);
  const listed = await chats.listThreads("alice", { agentId: "default" });
  assert.ok(listed.threads.some((thread) => thread.id === "t-restart"));
});

test("unsubscribing the SSE stream never stops the run", async () => {
  await chats.ensureThread("alice", "t-unsub", "default");
  const runner = make();
  const pause = gate();
  const subscription = runner
    .run(request(replyAgent("a1", ["Hel", "lo"], pause.promise), "t-unsub", "unsub-1"))
    .subscribe(() => {});
  await waitFor(async () => (await runRow("unsub-1")) !== undefined, "run begin");
  subscription.unsubscribe();
  pause.open();
  await waitFor(async () => (await runRow("unsub-1"))?.status === "finished", "run saved");
  assert.equal(await chats.isLocked("t-unsub"), false);
});

test("the terminal event waits for the save; a failed save is visible and the sweep recovers it", async (t) => {
  const original = db.sql.bind(db);
  let closeCalls = 0;
  let closeGate: Promise<void> | undefined;
  let failClose = false;
  t.mock.method(console, "error", () => {});
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (text.includes("chat:close")) {
      closeCalls++;
      if (closeGate) await closeGate;
      if (failClose) throw Object.assign(new Error("database unavailable"), { code: "57P01" });
    }
    return original(text, params);
  });

  // Delayed save: everything but RUN_FINISHED is streamed; RUN_FINISHED follows the save.
  await chats.ensureThread("alice", "t-held", "default");
  const saving = gate();
  closeGate = saving.promise;
  const runner = make();
  const held = collect(runner.run(request(replyAgent("a1", ["Hel", "lo"]), "t-held", "held-1")));
  await waitFor(() => closeCalls > 0, "close statement");
  assert.ok(held.events.some((event) => event.type === EventType.TEXT_MESSAGE_END));
  assert.ok(!held.events.some((event) => event.type === EventType.RUN_FINISHED));
  assert.equal(held.state.done, false);
  saving.open();
  const heldEvents = await held.finished;
  assert.equal(heldEvents.at(-1)?.type, EventType.RUN_FINISHED);
  closeGate = undefined;

  // Failed save: persistence_failed instead of RUN_FINISHED, the lock stays until the sweep.
  failClose = true;
  await chats.ensureThread("alice", "t-fail", "default");
  const recovering = make({ heartbeatMs: 20, staleAfterMs: 150, sweepMs: 25 });
  await recovering.start();
  const failed = await collect(
    recovering.run(
      request(replyAgent("a2", ["Sav", "ed?"]), "t-fail", "fail-1", [user("u2", "Q")]),
    ),
  ).finished;
  const last = failed.at(-1);
  assert.equal(last?.type, EventType.RUN_ERROR);
  assert.equal(field(last, "code"), persistenceFailedCode);
  assert.ok(!failed.some((event) => event.type === EventType.RUN_FINISHED));
  assert.equal(await chats.isLocked("t-fail"), true);
  assert.equal((await runRow("fail-1"))?.status, "running");

  failClose = false;
  await waitFor(async () => !(await chats.isLocked("t-fail")), "sweep recovery");
  const row = await runRow("fail-1");
  assert.equal(row?.status, "interrupted");
  assert.equal(await journalCount("fail-1"), 0);
  assert.deepEqual(toWireMessages(messagesFromEvents(row?.events ?? [])), [
    { id: "u2", role: "user", content: "Q" },
    { id: "a2", role: "assistant", content: "Saved?" },
  ]);
});

test("claim: locked, forbidden, release before begin; release is a no-op once the run began", async () => {
  const runner = make();
  const claim = (owner: string, runId: string) =>
    runner.claim({ owner, threadId: "t-claim", agentId: "default", runId });
  assert.deepEqual(await claim("alice", "c1"), { ok: true });
  assert.deepEqual(await claim("alice", "c2"), { ok: false, reason: "locked" });
  assert.deepEqual(await claim("bob", "c3"), { ok: false, reason: "forbidden" });
  assert.equal(await runner.isRunning({ threadId: "t-claim" }), true);
  await runner.release("t-claim", "c1");
  assert.equal(await runner.isRunning({ threadId: "t-claim" }), false);

  assert.deepEqual(await claim("alice", "c4"), { ok: true });
  const pause = gate();
  const run = collect(
    runner.run(request(replyAgent("a1", ["one", "two"], pause.promise), "t-claim", "c4")),
  );
  await waitFor(() => hasDelta(run.events, "one"), "run begin");
  await runner.release("t-claim", "c4");
  assert.equal(await chats.isLocked("t-claim"), true);
  assert.equal(await runner.isRunning({ threadId: "t-claim" }), true);
  pause.open();
  assert.equal((await run.finished).at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(await chats.isLocked("t-claim"), false);

  // A runId that already ran cannot run again; its claim is released.
  assert.deepEqual(await claim("alice", "c4"), { ok: true });
  const again = await collect(runner.run(request(replyAgent("a9", ["x"]), "t-claim", "c4")))
    .finished;
  assert.deepEqual(types(again), [EventType.RUN_ERROR]);
  assert.equal(await chats.isLocked("t-claim"), false);
});

test("a concurrent run gets agent_thread_locked and completes; the first run is unaffected", async () => {
  await chats.ensureThread("alice", "t-busy", "default");
  const runner = make();
  const other = make();
  const pause = gate();
  const first = collect(
    runner.run(request(replyAgent("a1", ["one", "two"], pause.promise), "t-busy", "busy-1")),
  );
  await waitFor(() => hasDelta(first.events, "one"), "first run");
  for (const target of [runner, other]) {
    const refused = await collect(
      target.run(request(replyAgent("a2", ["x"]), "t-busy", `busy-${target === runner ? 2 : 3}`)),
    ).finished;
    assert.deepEqual(types(refused), [EventType.RUN_ERROR]);
    assert.equal(field(refused[0], "code"), "agent_thread_locked");
    assert.equal(field(refused[0], "message"), lockedMessage);
  }
  assert.equal(first.state.done, false);
  pause.open();
  assert.equal((await first.finished).at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(await runRow("busy-2"), undefined);
  assert.equal(await runRow("busy-3"), undefined);
});

test("connect mid-run sends history, the current run from its start, then live events", async () => {
  await chats.ensureThread("alice", "t-connect", "default");
  const runner = make();
  await collect(
    runner.run(request(replyAgent("a1", ["Hello"]), "t-connect", "con-1", [user("u1", "Hi")])),
  ).finished;
  const pause = gate();
  const second = collect(
    runner.run(
      request(replyAgent("a2", ["Wor", "ld"], pause.promise), "t-connect", "con-2", [
        user("u1", "Hi"),
        { id: "a1", role: "assistant", content: "Hello" },
        user("u2", "And?"),
      ]),
    ),
  );
  await waitFor(() => hasDelta(second.events, "Wor"), "second run streaming");
  const connection = collect(runner.connect({ threadId: "t-connect" }));
  await waitFor(() => hasDelta(connection.events, "Wor"), "connect catches up");
  assert.equal(connection.state.done, false);
  pause.open();
  const events = await connection.finished;
  assert.deepEqual(types(events), [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
  ]);
  const starts = events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_START)
    .map((event) => field(event, "messageId"));
  assert.deepEqual(starts, ["a1", "a2"]);
  assert.deepEqual(toWireMessages(messagesFromEvents(events)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Hello" },
    { id: "u2", role: "user", content: "And?" },
    { id: "a2", role: "assistant", content: "World" },
  ]);

  // Idle: history only, then the stream ends. Missing thread: an empty stream.
  const idle = await collect(runner.connect({ threadId: "t-connect" })).finished;
  assert.equal(idle.filter((event) => event.type === EventType.RUN_STARTED).length, 2);
  assert.deepEqual(await collect(runner.connect({ threadId: "t-nowhere" })).finished, []);
});

test("stop: a local run aborts and is saved as stopped", async () => {
  await chats.ensureThread("alice", "t-stop", "default");
  const runner = make();
  const pause = gate();
  const agent = replyAgent("a1", ["Hel", "lo"], pause.promise);
  const run = collect(runner.run(request(agent, "t-stop", "stop-1")));
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  assert.equal(await runner.stop({ threadId: "t-stop", runId: "other-run" }), false);
  assert.equal(await runner.stop({ threadId: "t-stop" }), true);
  const events = await run.finished;
  assert.equal(agent.aborts, 1);
  assert.deepEqual(types(events).slice(-2), [EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]);
  assert.equal(field(events.at(-1), "threadId"), "t-stop");
  assert.equal(field(events.at(-1), "runId"), "stop-1");
  assert.equal((await runRow("stop-1"))?.status, "stopped");
  assert.equal(await chats.isLocked("t-stop"), false);
  assert.equal(await runner.stop({ threadId: "t-stop" }), false);
  pause.open();
});

test("stop: another instance's run stops through stop_requested on its heartbeat", async () => {
  await chats.ensureThread("alice", "t-xstop", "default");
  const owner = make({ heartbeatMs: 15 });
  await owner.start();
  const elsewhere = make();
  const pause = gate();
  const agent = replyAgent("a1", ["Hel", "lo"], pause.promise);
  const run = collect(owner.run(request(agent, "t-xstop", "xstop-1")));
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  assert.equal(await elsewhere.stop({ threadId: "t-xstop", runId: "nope" }), false);
  assert.equal(await elsewhere.stop({ threadId: "t-xstop" }), true);
  const events = await within(run.finished, "the heartbeat to stop the run");
  assert.equal(agent.aborts, 1);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await runRow("xstop-1"))?.status, "stopped");
  assert.equal(await elsewhere.stop({ threadId: "t-xstop" }), false);
  pause.open();
});

test("crash recovery closes a dead instance's run from its journal and releases unbegun claims", async () => {
  await chats.ensureThread("alice", "t-crash", "default");
  // Instance A never starts its timers: once its run is journaled it behaves like a dead process.
  const dead = make();
  const pause = gate();
  const run = collect(
    dead.run(
      request(replyAgent("a1", ["part", "ial"], pause.promise), "t-crash", "crash-1", [
        user("u1", "Tell me"),
      ]),
    ),
  );
  await waitFor(async () => (await journalCount("crash-1")) >= 3, "journal");
  assert.deepEqual(
    await dead.claim({
      owner: "alice",
      threadId: "t-crash-claim",
      agentId: "default",
      runId: "cc-1",
    }),
    { ok: true },
  );

  const survivor = make({ staleAfterMs: 60, sweepMs: 20, heartbeatMs: 20 });
  // Before recovery, another instance's connect sends what the journal holds and ends.
  const journaled = await collect(survivor.connect({ threadId: "t-crash" })).finished;
  assert.deepEqual(types(journaled), [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
  ]);
  assert.equal(field(journaled[2], "delta"), "part");
  await survivor.start();
  await waitFor(
    async () => !(await chats.isLocked("t-crash")) && !(await chats.isLocked("t-crash-claim")),
    "recovery",
  );
  const row = await runRow("crash-1");
  assert.equal(row?.status, "interrupted");
  assert.equal(await journalCount("crash-1"), 0);
  const stored = row?.events ?? [];
  assert.equal(stored[0]?.type, EventType.RUN_STARTED);
  assert.deepEqual(field(stored[0], "input"), {
    threadId: "t-crash",
    runId: "crash-1",
    messages: [{ id: "u1", role: "user", content: "Tell me" }],
    tools: [],
    context: [],
  });
  assert.equal(stored.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal(field(stored.at(-1), "message"), "The server stopped before this reply finished.");
  assert.ok(stored.some((event) => event.type === EventType.TEXT_MESSAGE_END));
  assert.deepEqual(toWireMessages(messagesFromEvents(stored)), [
    { id: "u1", role: "user", content: "Tell me" },
    { id: "a1", role: "assistant", content: "part" },
  ]);
  // Replay ends the recovered turn with RUN_FINISHED: the stored RUN_ERROR is not re-reported.
  const replay = await collect(survivor.connect({ threadId: "t-crash" })).finished;
  assert.ok(!replay.some((event) => event.type === EventType.RUN_ERROR));
  assert.equal(replay.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(field(replay.at(-1), "threadId"), "t-crash");
  assert.equal(field(replay.at(-1), "runId"), "crash-1");

  // The "dead" run finishing late changes nothing that was recovered, and its client is told the
  // reply it saw was not saved (the stored one is the shorter recovered reply).
  pause.open();
  const late = await run.finished;
  assert.ok(hasDelta(late, "ial"));
  assert.ok(!late.some((event) => event.type === EventType.RUN_FINISHED));
  assert.equal(late.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal(field(late.at(-1), "code"), persistenceFailedCode);
  const after = await runRow("crash-1");
  assert.equal(after?.status, "interrupted");
  assert.deepEqual(toWireMessages(messagesFromEvents(after?.events ?? [])).at(-1), {
    id: "a1",
    role: "assistant",
    content: "part",
  });
});

test("retention purges old closed runs and never touches running runs", async () => {
  await chats.ensureThread("alice", "t-old", "default");
  await chats.ensureThread("alice", "t-live", "default");
  const runner = make({ retentionDays: 1 });
  await collect(runner.run(request(replyAgent("a1", ["old"]), "t-old", "old-1"))).finished;
  await collect(runner.run(request(replyAgent("a2", ["new"]), "t-old", "old-2"))).finished;
  await db.sql(
    "UPDATE chat_runs SET finished_at=now() - interval '3 days', created_at=now() - interval '3 days' WHERE run_id='old-1'",
  );
  const pause = gate();
  const live = collect(
    runner.run(request(replyAgent("a3", ["a", "b"], pause.promise), "t-live", "live-1")),
  );
  await waitFor(() => hasDelta(live.events, "a"), "live run");
  await db.sql("UPDATE chat_runs SET created_at=now() - interval '3 days' WHERE run_id='live-1'");
  await runner.sweep();
  assert.equal(await runRow("old-1"), undefined);
  assert.equal((await runRow("old-2"))?.status, "finished");
  assert.equal((await runRow("live-1"))?.status, "running");
  assert.equal(await chats.threadOwner("t-old"), "alice");
  pause.open();
  await live.finished;
  assert.equal((await runRow("live-1"))?.status, "finished");
});

test("RUN_STARTED input is stored with only new messages; tools, context and props are dropped", async (t) => {
  await chats.ensureThread("alice", "t-input", "default");
  const runner = make();
  await collect(
    runner.run(request(replyAgent("a1", ["Hello"]), "t-input", "in-1", [user("u1", "Hi")])),
  ).finished;
  const history = [user("u1", "Hi"), { id: "a1", role: "assistant", content: "Hello" } as Message];
  const live = await collect(
    runner.run(
      request(replyAgent("a2", ["Sure"]), "t-input", "in-2", [...history, user("u2", "More")]),
    ),
  ).finished;
  const liveInput = field(live[0], "input") as RunAgentInput;
  assert.deepEqual(
    liveInput.messages.map((message) => message.id),
    ["u2"],
  );
  assert.equal(liveInput.tools.length, 1, "the live stream keeps the request input, as upstream");
  const stored = (await runRow("in-2"))?.events ?? [];
  assert.deepEqual(field(stored[0], "input"), {
    threadId: "t-input",
    runId: "in-2",
    messages: [{ id: "u2", role: "user", content: "More" }],
    tools: [],
    context: [],
  });

  // An agent's own RUN_STARTED input is reduced the same way.
  const ownInput = new FakeAgent((input) => [
    { event: { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId, input } },
    finished(input),
  ]);
  await collect(runner.run(request(ownInput, "t-input", "in-3", [...history, user("u3", "Last")])))
    .finished;
  assert.deepEqual(
    (field((await runRow("in-3"))?.events[0], "input") as RunAgentInput).messages.map((m) => m.id),
    ["u3"],
  );

  // A run that fails before any event keeps the user's message.
  t.mock.method(console, "error", () => {});
  const broken = new FakeAgent(() => [{ fail: "model unavailable" }]);
  const failed = await collect(
    runner.run(request(broken, "t-input", "in-4", [user("u4", "Still there?")])),
  ).finished;
  assert.deepEqual(types(failed), [EventType.RUN_ERROR]);
  const row = await runRow("in-4");
  assert.equal(row?.status, "error");
  assert.deepEqual(types(row?.events ?? []), [EventType.RUN_STARTED, EventType.RUN_ERROR]);
  assert.deepEqual(
    (field(row?.events[0], "input") as RunAgentInput).messages.map((m) => m.id),
    ["u4"],
  );
  assert.equal(await chats.isLocked("t-input"), false);
});

test("a run through an agent clone streams, persists and stops the clone", async () => {
  await chats.ensureThread("alice", "t-clone", "default");
  const runner = make();
  const pause = gate();
  const base = replyAgent("a1", ["Hel", "lo"], pause.promise);
  const clone = base.clone();
  const run = collect(runner.run(request(clone, "t-clone", "clone-1", [user("u1", "Hi")])));
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  assert.equal(await runner.stop({ threadId: "t-clone" }), true);
  await run.finished;
  assert.equal(clone.aborts, 1);
  assert.equal(base.aborts, 0);
  const row = await runRow("clone-1");
  assert.equal(row?.status, "stopped");
  assert.deepEqual(row?.message_ids, ["u1", "a1"]);
  pause.open();
});

test("close() saves in-flight runs as interrupted, ends their streams, and is idempotent", async () => {
  await chats.ensureThread("alice", "t-close", "default");
  const runner = make();
  const pause = gate();
  const agent = replyAgent("a1", ["Hel", "lo"], pause.promise);
  const run = collect(runner.run(request(agent, "t-close", "close-1")));
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  await runner.close();
  assert.equal(run.state.done, true);
  const events = await run.finished;
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal(field(events.at(-1), "message"), "The server is restarting.");
  assert.equal(agent.aborts, 1);
  assert.equal((await runRow("close-1"))?.status, "interrupted");
  assert.equal(await chats.isLocked("t-close"), false);
  await runner.close();
  const after = await collect(runner.run(request(replyAgent("a2", ["x"]), "t-close", "close-2")))
    .finished;
  assert.deepEqual(types(after), [EventType.RUN_ERROR]);
  assert.equal(field(after[0], "message"), "The server is restarting.");
  // Refused before it began: nothing was stored for it.
  assert.equal(await runRow("close-2"), undefined);
  assert.equal(await chats.isLocked("t-close"), false);
  pause.open();
});

test("close() also ends a run that is still starting", async (t) => {
  await chats.ensureThread("alice", "t-close-start", "default");
  const original = db.sql.bind(db);
  const beginGate = gate();
  let begins = 0;
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (text.includes("chat:begin")) {
      begins++;
      await beginGate.promise;
    }
    return original(text, params);
  });
  const runner = make();
  const agent = replyAgent("a1", ["never"]);
  const run = collect(runner.run(request(agent, "t-close-start", "cs-1", [user("u1", "Hi")])));
  await waitFor(() => begins > 0, "begin statement");
  const closing = runner.close();
  beginGate.open();
  await closing;
  const events = await run.finished;
  assert.deepEqual(types(events), [EventType.RUN_ERROR]);
  assert.equal(field(events[0], "message"), "The server is restarting.");
  const row = await runRow("cs-1");
  assert.equal(row?.status, "interrupted");
  assert.deepEqual(row?.message_ids, ["u1"]);
  assert.equal(await chats.isLocked("t-close-start"), false);
});

test("the journal flushes by batch size before the flush timer fires", async () => {
  await chats.ensureThread("alice", "t-batch", "default");
  const runner = make({ flushMs: 60_000 });
  const pause = gate();
  const deltas = Array.from({ length: 70 }, (_, index) => `d${index} `);
  const run = collect(
    runner.run(request(replyAgent("a1", [...deltas, "end"], pause.promise), "t-batch", "batch-1")),
  );
  await waitFor(async () => (await journalCount("batch-1")) >= 64, "batched journal");
  assert.ok((await journalCount("batch-1")) < 72);
  pause.open();
  const events = await run.finished;
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(await journalCount("batch-1"), 0);
  const stored = (await runRow("batch-1"))?.events ?? [];
  assert.deepEqual(types(stored), [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
  ]);
  assert.equal(field(stored[2], "delta"), `${deltas.join("")}end`);
});

test("stop ends a reply whose agent ignores abortRun, as ConversationAgent does", async () => {
  await chats.ensureThread("alice", "t-deaf", "default");
  const runner = make();
  const pause = gate();
  const agent = new DeafAgent((input) => [
    started(input),
    textStart("a1"),
    textDelta("a1", "Hel"),
    { gate: pause.promise },
    textDelta("a1", "lo, and much more"),
    textEnd("a1"),
    finished(input),
  ]);
  const run = collect(runner.run(request(agent, "t-deaf", "deaf-1", [user("u1", "Hi")])));
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  assert.equal(await runner.stop({ threadId: "t-deaf" }), true);
  // The stream ends while the agent would still be producing: the runner unsubscribed from it.
  const events = await within(run.finished, "the stopped run to end");
  assert.equal(agent.aborts, 1);
  assert.ok(agent.teardowns >= 1, "the agent's stream was unsubscribed");
  assert.deepEqual(types(events).slice(-2), [EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]);
  const row = await runRow("deaf-1");
  assert.equal(row?.status, "stopped");
  assert.deepEqual(toWireMessages(messagesFromEvents(row?.events ?? [])), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Hel" },
  ]);
  assert.equal(await chats.isLocked("t-deaf"), false);
  pause.open();

  // A stop requested before the run began (through the lock row) also ends such an agent.
  assert.deepEqual(
    await runner.claim({ owner: "alice", threadId: "t-deaf", agentId: "default", runId: "deaf-2" }),
    { ok: true },
  );
  assert.equal(await chats.requestStop("t-deaf", "deaf-2"), true);
  const pending = gate();
  const early = new DeafAgent((input) => [
    started(input),
    { gate: pending.promise },
    finished(input),
  ]);
  const stoppedEarly = await within(
    collect(runner.run(request(early, "t-deaf", "deaf-2"))).finished,
    "the run stopped before it began to end",
  );
  assert.equal(stoppedEarly.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await runRow("deaf-2"))?.status, "stopped");
  pending.open();
});

test("close() ends a reply whose agent ignores abortRun without waiting for the cap", async () => {
  await chats.ensureThread("alice", "t-deaf-close", "default");
  const runner = make();
  runner.closeCapMs = 10_000;
  const pause = gate();
  const agent = new DeafAgent((input) => [
    started(input),
    textStart("a1"),
    textDelta("a1", "Hel"),
    { gate: pause.promise },
    textEnd("a1"),
    finished(input),
  ]);
  const run = collect(runner.run(request(agent, "t-deaf-close", "deaf-close-1")));
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  await within(runner.close(), "close without the cap");
  const events = await run.finished;
  assert.equal(field(events.at(-1), "message"), "The server is restarting.");
  assert.equal((await runRow("deaf-close-1"))?.status, "interrupted");
  assert.equal(await chats.isLocked("t-deaf-close"), false);
  pause.open();
});

test("close() still saves a reply whose agent ignores abort and detach, after the cap", async () => {
  await chats.ensureThread("alice", "t-stuck", "default");
  const runner = make();
  runner.closeCapMs = 50;
  const pause = gate();
  const agent = new StuckAgent((input) => [
    started(input),
    textStart("a1"),
    textDelta("a1", "Hel"),
    { gate: pause.promise },
    textEnd("a1"),
    finished(input),
  ]);
  const run = collect(runner.run(request(agent, "t-stuck", "stuck-1")));
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  await runner.close();
  assert.equal(run.state.done, true);
  const events = await run.finished;
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal(field(events.at(-1), "message"), "The server is restarting.");
  const row = await runRow("stuck-1");
  assert.equal(row?.status, "interrupted");
  assert.equal(await chats.isLocked("t-stuck"), false);
  pause.open();
});

test("the heartbeat keeps a long reply's lock from being recovered by another instance", async (t) => {
  await chats.ensureThread("alice", "t-beat", "default");
  const original = db.sql.bind(db);
  let sweeps = 0;
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (text.includes("chat:stale")) sweeps++;
    return original(text, params);
  });
  const owner = make({ heartbeatMs: 10, staleAfterMs: 100, sweepMs: 60_000 });
  await owner.start();
  const watcher = make({ heartbeatMs: 10, staleAfterMs: 100, sweepMs: 10 });
  const pause = gate();
  const run = collect(
    owner.run(request(replyAgent("a1", ["Hel", "lo"], pause.promise), "t-beat", "beat-1")),
  );
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  await watcher.start();
  // Well past the stale threshold, with the watcher sweeping every 10 ms.
  const from = sweeps;
  await waitFor(() => sweeps - from >= 20, "watcher sweeps");
  assert.equal((await runRow("beat-1"))?.status, "running");
  assert.equal(await chats.isLocked("t-beat"), true);
  pause.open();
  assert.equal((await run.finished).at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await runRow("beat-1"))?.status, "finished");
});

test("start() recovers at once a lock left under its instance id, or any lock when exclusive", async () => {
  for (const [label, deadOptions, nextOptions] of [
    ["same instance id", { instanceId: "api-1" }, { instanceId: "api-1" }],
    ["exclusive database", {}, { exclusive: true }],
  ] as const) {
    const threadId = `t-start-${label.replaceAll(" ", "-")}`;
    await chats.ensureThread("alice", threadId, "default");
    // The previous process: never started (no heartbeat), its lock still fresh.
    const dead = make(deadOptions);
    const pause = gate();
    const run = collect(
      dead.run(
        request(replyAgent("a1", ["part", "ial"], pause.promise), threadId, `${threadId}-run`, [
          user("u1", "Tell me"),
        ]),
      ),
    );
    await waitFor(async () => (await journalCount(`${threadId}-run`)) >= 3, "journal");
    const next = make({ ...nextOptions, staleAfterMs: 60_000, sweepMs: 60_000 });
    await next.start();
    assert.equal(await chats.isLocked(threadId), false, label);
    const row = await runRow(`${threadId}-run`);
    assert.equal(row?.status, "interrupted", label);
    assert.deepEqual(toWireMessages(messagesFromEvents(row?.events ?? [])), [
      { id: "u1", role: "user", content: "Tell me" },
      { id: "a1", role: "assistant", content: "part" },
    ]);
    pause.open();
    assert.equal(field((await run.finished).at(-1), "code"), persistenceFailedCode);
  }
  // A fresh lock of another live instance is not touched by a non-exclusive start.
  await chats.ensureThread("alice", "t-start-live", "default");
  const live = make();
  const pause = gate();
  const run = collect(
    live.run(request(replyAgent("a1", ["x", "y"], pause.promise), "t-start-live", "live-run")),
  );
  await waitFor(() => hasDelta(run.events, "x"), "streaming");
  await make({ staleAfterMs: 60_000, sweepMs: 60_000 }).start();
  assert.equal((await runRow("live-run"))?.status, "running");
  pause.open();
  assert.equal((await run.finished).at(-1)?.type, EventType.RUN_FINISHED);
});

test("the standalone chat treats embedded PGlite as exclusive and DATABASE_URL as shared", async () => {
  const auth = { owner: async () => "alice" };
  const embedded = await createStandaloneChat({ db, auth, config: {} });
  const shared = await createStandaloneChat({
    db,
    auth,
    config: { databaseUrl: "postgres://elsewhere/openmuse" },
  });
  runners.push(embedded.runner, shared.runner);
  assert.equal(embedded.runner.options.exclusive, true);
  assert.equal(shared.runner.options.exclusive, false);
});

test("a run saved while a connect reads history is sent once, from the live run", async (t) => {
  await chats.ensureThread("alice", "t-race", "default");
  const runner = make();
  const original = db.sql.bind(db);
  const reading = gate();
  let holdReads = false;
  let reads = 0;
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (holdReads && text.includes("chat:connect-history")) {
      reads++;
      await reading.promise;
    }
    return original(text, params);
  });
  const pause = gate();
  const run = collect(
    runner.run(
      request(replyAgent("a1", ["Hel", "lo"], pause.promise), "t-race", "race-1", [
        user("u1", "Hi"),
      ]),
    ),
  );
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  holdReads = true;
  const connection = collect(runner.connect({ threadId: "t-race" }));
  await waitFor(() => reads > 0, "history read");
  pause.open();
  await run.finished;
  assert.equal((await runRow("race-1"))?.status, "finished");
  reading.open();
  const events = await connection.finished;
  assert.deepEqual(types(events), [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
  ]);
  assert.deepEqual(toWireMessages(messagesFromEvents(events)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Hello" },
  ]);
});

test("a connect between the claim and the run's start waits for the run and tails it", async () => {
  const runner = make();
  const claim = (runId: string) =>
    runner.claim({ owner: "alice", threadId: "t-window", agentId: "default", runId });
  assert.deepEqual(await claim("win-1"), { ok: true });
  const connection = collect(runner.connect({ threadId: "t-window" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connection.state.done, false, "the connect waits for the claimed run");
  const pause = gate();
  const run = collect(
    runner.run(
      request(replyAgent("a1", ["Hel", "lo"], pause.promise), "t-window", "win-1", [
        user("u1", "Hi"),
      ]),
    ),
  );
  await waitFor(() => hasDelta(connection.events, "Hel"), "connect tails the run");
  assert.equal(connection.state.done, false);
  pause.open();
  await run.finished;
  const events = await connection.finished;
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.deepEqual(toWireMessages(messagesFromEvents(events)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Hello" },
  ]);

  // A claim released without a run: the waiting connect ends with the history.
  assert.deepEqual(await claim("win-2"), { ok: true });
  const idle = collect(runner.connect({ threadId: "t-window" }));
  await runner.release("t-window", "win-2");
  const replayed = await idle.finished;
  assert.equal(replayed.filter((event) => event.type === EventType.RUN_STARTED).length, 1);
});

/** An agent whose run sends these STATE_DELTA patches, optionally pausing before it finishes. */
function patchAgent(patches: unknown[][], pause?: Promise<void>) {
  return new FakeAgent((input) => [
    started(input),
    ...patches.map((delta): Step => ({ event: { type: EventType.STATE_DELTA, delta } })),
    ...(pause ? [{ gate: pause }] : []),
    finished(input),
  ]);
}

/** request() with the state the client sent, which the runtime also sets on the agent. */
function requestWithState(
  agent: AbstractAgent,
  threadId: string,
  runId: string,
  state: Record<string, unknown>,
) {
  const run = request(agent, threadId, runId, [user(`${runId}-q`, "Count")]);
  run.input.state = state;
  agent.setState(state);
  return run;
}

// Valid against the state the run began with, not against {} (compactEvents' starting state).
const replaceCount = [{ op: "replace", path: "/count", value: 2 }];
// Valid against no state at all; the agent and the client warn and skip it.
const replaceMissing = [{ op: "replace", path: "/missing", value: 1 }];

test("a run whose state patches compaction cannot replay from {} finishes and frees its thread", async (t) => {
  t.mock.method(console, "warn", () => {}); // the agent warns about the patch it cannot apply
  await chats.ensureThread("alice", "t-patch", "default");
  const runner = make();
  const first = await within(
    collect(
      runner.run(
        requestWithState(patchAgent([replaceCount]), "t-patch", "patch-1", {
          count: 1,
          kept: true,
        }),
      ),
    ).finished,
    "the first run to end",
  );
  assert.deepEqual(types(first), [
    EventType.RUN_STARTED,
    EventType.STATE_DELTA,
    EventType.RUN_FINISHED,
  ]);
  const row = await runRow("patch-1");
  assert.equal(row?.status, "finished");
  // The stored snapshot is the state the run ended with, keys it did not touch included.
  assert.deepEqual(stateFromEvents(row?.events ?? []), { count: 2, kept: true });
  assert.equal(await runner.isRunning({ threadId: "t-patch" }), false);
  assert.equal(await chats.isLocked("t-patch"), false);

  // A patch that applies to nothing is dropped; the patches around it are kept.
  const second = await within(
    collect(
      runner.run(
        requestWithState(
          patchAgent([replaceMissing, [{ op: "add", path: "/added", value: true }]]),
          "t-patch",
          "patch-2",
          { count: 2, kept: true },
        ),
      ),
    ).finished,
    "the second run to end",
  );
  assert.equal(second.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await runRow("patch-2"))?.status, "finished");
  const replay = await within(collect(runner.connect({ threadId: "t-patch" })).finished, "replay");
  assert.equal(replay.filter((event) => event.type === EventType.RUN_STARTED).length, 2);
  assert.deepEqual(stateFromEvents(replay), { count: 2, kept: true, added: true });
  assert.deepEqual(stateFromEvents((await chats.threadEvents("alice", "t-patch")) ?? []), {
    count: 2,
    kept: true,
    added: true,
  });
  assert.equal(await chats.deleteThread("alice", "t-patch", "default"), "deleted");
});

test("recovery saves a journal whose state patches compaction cannot replay from {}", async (t) => {
  t.mock.method(console, "warn", () => {});
  await chats.ensureThread("alice", "t-patch-crash", "default");
  // Never started: once its patches are journaled it behaves like a dead process.
  const dead = make();
  const pause = gate();
  const run = collect(
    dead.run(
      requestWithState(
        patchAgent([replaceCount, replaceMissing], pause.promise),
        "t-patch-crash",
        "patch-crash-1",
        { count: 1 },
      ),
    ),
  );
  await waitFor(async () => (await journalCount("patch-crash-1")) >= 3, "journal");
  // Another process's connect replays what the journal holds.
  const journaled = await within(
    collect(make().connect({ threadId: "t-patch-crash" })).finished,
    "journal replay",
  );
  assert.deepEqual(stateFromEvents(journaled), { count: 2 });
  // A restart on the embedded database recovers the run at once and unlocks the thread.
  await make({ exclusive: true, staleAfterMs: 60_000, sweepMs: 60_000 }).start();
  assert.equal(await chats.isLocked("t-patch-crash"), false);
  const row = await runRow("patch-crash-1");
  assert.equal(row?.status, "interrupted");
  assert.deepEqual(stateFromEvents(row?.events ?? []), { count: 2 });
  assert.equal(await journalCount("patch-crash-1"), 0);
  pause.open();
  assert.equal(field((await run.finished).at(-1), "code"), persistenceFailedCode);
});

test("replay and the thread routes tolerate a stored state patch that applies to nothing", async () => {
  await chats.ensureThread("alice", "t-raw-patch", "default");
  const stored = [
    {
      type: EventType.RUN_STARTED,
      threadId: "t-raw-patch",
      runId: "raw-patch-1",
      input: {
        threadId: "t-raw-patch",
        runId: "raw-patch-1",
        messages: [],
        tools: [],
        context: [],
      },
    },
    { type: EventType.STATE_DELTA, delta: replaceMissing },
    { type: EventType.RUN_FINISHED, threadId: "t-raw-patch", runId: "raw-patch-1" },
  ];
  await db.sql(
    `INSERT INTO chat_runs(run_id, thread_id, status, events, finished_at)
    VALUES ('raw-patch-1', 't-raw-patch', 'finished', $1::jsonb, now())`,
    [JSON.stringify(stored)],
  );
  const replay = await within(
    collect(make().connect({ threadId: "t-raw-patch" })).finished,
    "replay",
  );
  assert.deepEqual(types(replay), [EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  assert.deepEqual(types((await chats.threadEvents("alice", "t-raw-patch")) ?? []), [
    EventType.RUN_STARTED,
    EventType.RUN_FINISHED,
  ]);
});

test("an unexpected failure while saving still ends the stream and leaves the run to the sweep", async (t) => {
  t.mock.method(console, "error", () => {});
  await chats.ensureThread("alice", "t-finalize", "default");
  const runner = make({ heartbeatMs: 10, staleAfterMs: 100, sweepMs: 20 });
  await runner.start();
  const internals = runner as unknown as { closeWithRetry: (input: unknown) => Promise<boolean> };
  const original = internals.closeWithRetry.bind(runner);
  let saves = 0;
  t.mock.method(internals, "closeWithRetry", async (input: unknown) => {
    if (saves++ === 0) throw new Error("unexpected");
    return original(input);
  });
  const events = await within(
    collect(
      runner.run(
        request(replyAgent("a1", ["Hel", "lo"]), "t-finalize", "finalize-1", [user("u1", "Q")]),
      ),
    ).finished,
    "the stream to end",
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal(field(events.at(-1), "code"), persistenceFailedCode);
  // The run left the runner, so its lock is no longer refreshed: the sweep recovers it.
  await waitFor(async () => !(await chats.isLocked("t-finalize")), "sweep recovery");
  assert.equal(await runner.isRunning({ threadId: "t-finalize" }), false);
  const row = await runRow("finalize-1");
  assert.equal(row?.status, "interrupted");
  assert.deepEqual(toWireMessages(messagesFromEvents(row?.events ?? [])), [
    { id: "u1", role: "user", content: "Q" },
    { id: "a1", role: "assistant", content: "Hello" },
  ]);
  const closing = Date.now();
  await runner.close();
  assert.ok(Date.now() - closing < 1000, "close() has no run left to wait for");
});

test("a run that begins and is saved while a connect reads history is sent once, from the live run", async (t) => {
  await chats.ensureThread("alice", "t-race-late", "default");
  const runner = make();
  const original = db.sql.bind(db);
  const reading = gate();
  const saving = gate();
  let reads = 0;
  let saved = false;
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (text.includes("/* chat:connect-history */") && reads++ === 0) await reading.promise;
    if (!text.includes("/* chat:close */")) return original(text, params);
    // The save commits, but the runner only sees it once `saving` opens (a pg Pool can answer the
    // history read in between).
    const result = await original(text, params);
    saved = true;
    await saving.promise;
    return result;
  });
  // The connect finds no live run, then its history read waits.
  const connection = collect(runner.connect({ threadId: "t-race-late" }));
  await waitFor(() => reads > 0, "history read");
  const run = collect(
    runner.run(
      request(replyAgent("a1", ["Hel", "lo"]), "t-race-late", "late-1", [user("u1", "Hi")]),
    ),
  );
  await waitFor(() => saved, "the run's save");
  // The history read now sees the saved run. A run began during the read, so the connect reads
  // again without that run, which is still live in this process, and follows it until it is saved.
  reading.open();
  await waitFor(
    () => reads > 1 && hasDelta(connection.events, "lo"),
    "the connect to follow the run",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(connection.state.done, false, "the connect ends only once the run is saved");
  assert.ok(!connection.events.some(isTerminalEvent), "the terminal event waits for the save");
  saving.open();
  const events = await within(connection.finished, "the connect to end");
  assert.equal((await run.finished).at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(events.filter((event) => event.type === EventType.RUN_STARTED).length, 1);
  assert.deepEqual(toWireMessages(messagesFromEvents(events)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Hello" },
  ]);
});

test("a run whose runId runs on another thread is refused and releases its own claim", async () => {
  await chats.ensureThread("alice", "t-dup-a", "default");
  const runner = make();
  const pause = gate();
  const first = collect(
    runner.run(request(replyAgent("a1", ["one", "two"], pause.promise), "t-dup-a", "dup-run")),
  );
  await waitFor(() => hasDelta(first.events, "one"), "first run");
  assert.deepEqual(
    await runner.claim({
      owner: "alice",
      threadId: "t-dup-b",
      agentId: "default",
      runId: "dup-run",
    }),
    { ok: true },
  );
  const refused = await collect(runner.run(request(replyAgent("a2", ["x"]), "t-dup-b", "dup-run")))
    .finished;
  assert.deepEqual(types(refused), [EventType.RUN_ERROR]);
  assert.equal(field(refused[0], "code"), "agent_thread_locked");
  assert.equal(await chats.isLocked("t-dup-b"), false);
  assert.equal(await chats.isLocked("t-dup-a"), true);
  pause.open();
  assert.equal((await first.finished).at(-1)?.type, EventType.RUN_FINISHED);
});

/**
 * Holds the rows of the thread's first connect-history read until `answer` opens. The read itself
 * runs at once (its snapshot is taken then), as a pg Pool connection that answers slowly would.
 */
function holdFirstHistoryAnswer(t: TestContext) {
  const original = db.sql.bind(db);
  const answer = gate();
  const state = { reads: 0, read: false };
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (!text.includes("/* chat:connect-history */") || state.reads++ > 0)
      return original(text, params);
    const rows = await original(text, params);
    state.read = true;
    await answer.promise;
    return rows;
  });
  return { answer, state };
}

test("a run that begins and ends while a connect's earlier snapshot is answered is still sent", async (t) => {
  await chats.ensureThread("alice", "t-snapshot", "default");
  const runner = make();
  const { answer, state } = holdFirstHistoryAnswer(t);
  // No run is live: the connect captures none, and its read sees the thread before the run.
  const connection = collect(runner.connect({ threadId: "t-snapshot" }));
  await waitFor(() => state.read, "history read");
  const run = collect(
    runner.run(
      request(replyAgent("a1", ["Hel", "lo"]), "t-snapshot", "snap-1", [user("u1", "Hi")]),
    ),
  );
  assert.equal((await run.finished).at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await runRow("snap-1"))?.status, "finished");
  // The run has been saved and has left the runner by the time the old snapshot arrives.
  answer.open();
  const events = await within(connection.finished, "the connect to end");
  assert.equal(state.reads, 2, "the connect read the history again");
  assert.equal(events.filter((event) => event.type === EventType.RUN_STARTED).length, 1);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.deepEqual(toWireMessages(messagesFromEvents(events)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Hello" },
  ]);
});

test("a connect follows the run that succeeded its captured run during the history read", async (t) => {
  await chats.ensureThread("alice", "t-succeed", "default");
  const runner = make();
  const original = db.sql.bind(db);
  const reading = gate();
  let reads = 0;
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (text.includes("/* chat:connect-history */") && reads++ === 0) await reading.promise;
    return original(text, params);
  });
  const firstPause = gate();
  const first = collect(
    runner.run(
      request(replyAgent("a1", ["one", "two"], firstPause.promise), "t-succeed", "succ-1", [
        user("u1", "Hi"),
      ]),
    ),
  );
  await waitFor(() => hasDelta(first.events, "one"), "first run");
  // The connect captures the first run; its history read waits.
  const connection = collect(runner.connect({ threadId: "t-succeed" }));
  await waitFor(() => reads > 0, "history read");
  firstPause.open();
  await first.finished;
  // A message queued on another device starts the next run at once.
  assert.deepEqual(
    await runner.claim({
      owner: "alice",
      threadId: "t-succeed",
      agentId: "default",
      runId: "succ-2",
    }),
    { ok: true },
  );
  const secondPause = gate();
  const second = collect(
    runner.run(
      request(replyAgent("a2", ["three", "four"], secondPause.promise), "t-succeed", "succ-2", [
        user("u1", "Hi"),
        { id: "a1", role: "assistant", content: "onetwo" },
        user("u2", "Again"),
      ]),
    ),
  );
  await waitFor(() => hasDelta(second.events, "three"), "second run");
  reading.open();
  await waitFor(() => hasDelta(connection.events, "three"), "the connect to follow the second run");
  assert.equal(connection.state.done, false, "the reply in progress is still followed");
  secondPause.open();
  assert.equal((await second.finished).at(-1)?.type, EventType.RUN_FINISHED);
  const events = await within(connection.finished, "the connect to end");
  assert.equal(events.filter((event) => event.type === EventType.RUN_STARTED).length, 2);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.deepEqual(toWireMessages(messagesFromEvents(events)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "onetwo" },
    { id: "u2", role: "user", content: "Again" },
    { id: "a2", role: "assistant", content: "threefour" },
  ]);
});

test("another process's reply is read in the same snapshot as the history, so a save between them loses nothing", async (t) => {
  await chats.ensureThread("alice", "t-elsewhere", "default");
  const holder = make();
  const reader = make();
  await collect(
    holder.run(
      request(replyAgent("a0", ["Earlier"]), "t-elsewhere", "else-0", [user("u0", "First")]),
    ),
  ).finished;
  const pause = gate();
  const run = collect(
    holder.run(
      request(replyAgent("a1", ["part", "ial"], pause.promise), "t-elsewhere", "else-1", [
        user("u0", "First"),
        { id: "a0", role: "assistant", content: "Earlier" },
        user("u1", "Then"),
      ]),
    ),
  );
  await waitFor(async () => (await journalCount("else-1")) >= 3, "journal");
  const { answer, state } = holdFirstHistoryAnswer(t);
  const connection = collect(reader.connect({ threadId: "t-elsewhere" }));
  await waitFor(() => state.read, "history read");
  // The other process saves its reply after the snapshot was taken.
  pause.open();
  assert.equal((await run.finished).at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await runRow("else-1"))?.status, "finished");
  answer.open();
  const events = await within(connection.finished, "the connect to end");
  assert.equal(state.reads, 1);
  // The snapshot held the saved first reply and the second one's journal: both are sent.
  assert.deepEqual(types(events), [
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED,
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
  ]);
  assert.equal(field(events[2], "delta"), "Earlier");
  assert.equal(field(events[7], "delta"), "part");
});

/** The single event a connect sends when it cannot read the thread's history. */
const historyUnavailable = [
  { type: EventType.RUN_ERROR, message: historyUnavailableMessage, code: historyUnavailableCode },
];

test("a connect fails rather than send a wrong history while replies keep starting during its reads", async (t) => {
  t.mock.method(console, "error", () => {});
  await chats.ensureThread("alice", "t-restless", "default");
  const runner = make();
  runner.historyReadLimit = 3;
  const original = db.sql.bind(db);
  let reads = 0;
  let restless = true;
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (restless && text.includes("/* chat:connect-history */")) {
      // Another reply runs on the thread during every read.
      const n = ++reads;
      await collect(
        runner.run(
          request(replyAgent(`a${n}`, [`reply ${n}`]), "t-restless", `rest-${n}`, [
            user(`u${n}`, `Message ${n}`),
          ]),
        ),
      ).finished;
    }
    return original(text, params);
  });
  // The runtime would end the SSE response normally on a stream error, so the connect ends with a
  // RUN_ERROR the app reports as a failed load (with Retry) instead.
  assert.deepEqual(
    await within(collect(runner.connect({ threadId: "t-restless" })).finished, "the connect"),
    historyUnavailable,
  );
  assert.equal(reads, 3);
  // Once the thread is quiet, a connect (the app's Retry) sends every reply once.
  restless = false;
  const events = await within(
    collect(runner.connect({ threadId: "t-restless" })).finished,
    "the retried connect",
  );
  assert.deepEqual(
    toWireMessages(messagesFromEvents(events)).map((message) => message.id),
    ["u1", "a1", "u2", "a2", "u3", "a3"],
  );
});

test("a connect whose history cannot be read ends with history_unavailable", async (t) => {
  t.mock.method(console, "error", () => {});
  await chats.ensureThread("alice", "t-no-history", "default");
  const runner = make();
  await collect(
    runner.run(
      request(replyAgent("a1", ["Saved"]), "t-no-history", "nohist-1", [user("u1", "Hi")]),
    ),
  ).finished;
  const original = db.sql.bind(db);
  const failing = t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    if (text.includes("/* chat:connect-history */")) throw new Error("connection terminated");
    return original(text, params);
  });
  assert.deepEqual(
    await within(collect(runner.connect({ threadId: "t-no-history" })).finished, "the connect"),
    historyUnavailable,
  );
  failing.mock.restore();
  const events = await within(
    collect(runner.connect({ threadId: "t-no-history" })).finished,
    "the retried connect",
  );
  assert.deepEqual(toWireMessages(messagesFromEvents(events)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Saved" },
  ]);
});

test("a run begun in the database but not yet registered when a connect's read returns is followed", async (t) => {
  await chats.ensureThread("alice", "t-registering", "default");
  const runner = make();
  const original = db.sql.bind(db);
  const answer = gate();
  let begun = false;
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    const rows = await original(text, params);
    if (text.includes("/* chat:begin */")) {
      // The run is begun in the database; its answer reaches the runner only once `answer` opens
      // (a pg Pool connection that answers slowly).
      begun = true;
      await answer.promise;
    }
    return rows;
  });
  const pause = gate();
  const run = collect(
    runner.run(
      request(replyAgent("a1", ["Hel", "lo"], pause.promise), "t-registering", "reg-1", [
        user("u1", "Hi"),
      ]),
    ),
  );
  await waitFor(() => begun, "the run to begin in the database");
  // The connect's read sees the run as running with an empty journal; the runner has not
  // registered it yet, so the connect waits for it instead of ending with nothing.
  const connection = collect(runner.connect({ threadId: "t-registering" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connection.state.done, false, "the connect waits for the run being begun");
  answer.open();
  await waitFor(() => hasDelta(connection.events, "Hel"), "the connect to follow the run");
  assert.equal(connection.state.done, false, "the reply in progress is followed");
  pause.open();
  assert.equal((await run.finished).at(-1)?.type, EventType.RUN_FINISHED);
  const events = await within(connection.finished, "the connect to end");
  assert.equal(events.filter((event) => event.type === EventType.RUN_STARTED).length, 1);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.deepEqual(toWireMessages(messagesFromEvents(events)), [
    { id: "u1", role: "user", content: "Hi" },
    { id: "a1", role: "assistant", content: "Hello" },
  ]);
});

test("claim takes over a dead process's stale lock after saving its journal", async () => {
  await chats.ensureThread("alice", "t-takeover", "default");
  // The dead process never starts its timers, so nothing refreshes its lock.
  const dead = make();
  const pause = gate();
  const run = collect(
    dead.run(
      request(replyAgent("a1", ["part", "ial"], pause.promise), "t-takeover", "take-1", [
        user("u1", "Tell me"),
      ]),
    ),
  );
  await waitFor(async () => (await journalCount("take-1")) >= 3, "journal");
  const next = make({ sweepMs: 60_000 });
  const claim = (runId: string) =>
    next.claim({ owner: "alice", threadId: "t-takeover", agentId: "default", runId });
  assert.deepEqual(await claim("take-2"), { ok: false, reason: "locked" }, "a fresh lock holds");
  await db.sql(
    "UPDATE chat_threads SET run_heartbeat_at = now() - interval '1 hour' WHERE id='t-takeover'",
  );
  assert.deepEqual(await claim("take-2"), { ok: true });
  const row = await runRow("take-1");
  assert.equal(row?.status, "interrupted");
  assert.equal(await journalCount("take-1"), 0);
  assert.deepEqual(toWireMessages(messagesFromEvents(row?.events ?? [])), [
    { id: "u1", role: "user", content: "Tell me" },
    { id: "a1", role: "assistant", content: "part" },
  ]);
  await next.release("t-takeover", "take-2");
  assert.equal(await chats.isLocked("t-takeover"), false);
  pause.open();
  assert.equal(field((await run.finished).at(-1), "code"), persistenceFailedCode);
});

test("the sweep leaves a lock alone when its holder heartbeats after the lock was found stale", async (t) => {
  await chats.ensureThread("alice", "t-guard", "default");
  const holder = make();
  const pause = gate();
  const run = collect(
    holder.run(request(replyAgent("a1", ["Hel", "lo"], pause.promise), "t-guard", "guard-1")),
  );
  await waitFor(() => hasDelta(run.events, "Hel"), "streaming");
  await db.sql(
    "UPDATE chat_threads SET run_heartbeat_at = now() - interval '1 hour' WHERE id='t-guard'",
  );
  const original = db.sql.bind(db);
  t.mock.method(db, "sql", async (text: string, params?: unknown[]) => {
    const rows = await original(text, params);
    // The holder's heartbeat lands between the sweep's scan and its recovery.
    if (text.includes("/* chat:stale */"))
      await original("UPDATE chat_threads SET run_heartbeat_at = now() WHERE id='t-guard'");
    return rows;
  });
  const sweeper = make();
  await sweeper.sweep();
  assert.equal((await runRow("guard-1"))?.status, "running");
  assert.equal(await chats.isLocked("t-guard"), true);
  pause.open();
  assert.equal((await run.finished).at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await runRow("guard-1"))?.status, "finished");
});

test("close() releases this instance's claims whose runs never began, and only those", async () => {
  const runner = make();
  const other = make();
  const claim = (target: LocalAgentRunner, threadId: string, runId: string) =>
    target.claim({ owner: "alice", threadId, agentId: "default", runId });
  assert.deepEqual(await claim(runner, "t-shut-mine", "shut-1"), { ok: true });
  assert.deepEqual(await claim(other, "t-shut-other", "shut-2"), { ok: true });
  await runner.close();
  assert.equal(await chats.isLocked("t-shut-mine"), false);
  assert.equal(await chats.isLocked("t-shut-other"), true);
  await other.release("t-shut-other", "shut-2");
});

test("text with unpaired surrogates or NUL characters is saved with U+FFFD instead of failing", async () => {
  await chats.ensureThread("alice", "t-unpaired", "default");
  const runner = make();
  // A reply cut in the middle of an emoji, and a message carrying stray characters.
  const events = await within(
    collect(
      runner.run(
        request(replyAgent("a1", ["Cut at the limit: ", "\uD83D"]), "t-unpaired", "unpaired-1", [
          user("u1", "Name: \uDE00 and \u0000 😀"),
        ]),
      ),
    ).finished,
    "the run",
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  const row = await runRow("unpaired-1");
  assert.equal(row?.status, "finished");
  assert.equal(await chats.isLocked("t-unpaired"), false);
  const expected = [
    { id: "u1", role: "user", content: "Name: � and � 😀" },
    { id: "a1", role: "assistant", content: "Cut at the limit: �" },
  ];
  assert.deepEqual(toWireMessages(messagesFromEvents(row?.events ?? [])), expected);
  const replay = await collect(runner.connect({ threadId: "t-unpaired" })).finished;
  assert.deepEqual(toWireMessages(messagesFromEvents(replay)), expected);
});
