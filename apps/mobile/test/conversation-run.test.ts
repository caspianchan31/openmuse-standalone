import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConversationTurnError,
  isThreadLocked,
  replayedRunError,
  runConversationTurn,
  showsRunError,
  threadLocked,
} from "../src/conversation-run.ts";

const lockBody = {
  error: "This conversation is still replying. Try again when it finishes.",
  code: "agent_thread_locked",
};

/** The Error @ag-ui/client's runHttpRequest builds for a non-2xx answer. */
function httpError(status: number, payload: unknown) {
  const error = new Error(
    `HTTP ${status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`,
  ) as Error & { status?: number; payload?: unknown };
  error.status = status;
  error.payload = payload;
  return error;
}

class AgentThreadLockedError extends Error {
  constructor(threadId: string) {
    super(`Thread ${threadId} is locked`);
    this.name = "AgentThreadLockedError";
  }
}

type Event = { error: unknown; code?: string; context?: { agentId?: string } };

/** A CopilotKit-like error bus: execute() reports each event to the listeners, then resolves. */
function reporter(events: Event[]) {
  const listeners = new Set<(event: Event) => void>();
  return {
    execute: async () => {
      for (const event of events) for (const listener of listeners) listener(event);
    },
    subscribe: (listener: (event: Event) => void) => {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    listeners,
  };
}

test("a server-side 409 lock refusal in SSE mode is a thread lock", () => {
  // Standalone (no Intelligence key): CopilotKit reports the 409 as agent_run_failed.
  assert.equal(isThreadLocked({ code: "agent_run_failed", error: httpError(409, lockBody) }), true);
  // The same error first reaches onRunFailed as agent_run_failed_event.
  assert.equal(
    isThreadLocked({ code: "agent_run_failed_event", error: httpError(409, lockBody) }),
    true,
  );
  // A body that was not parsed as JSON is still recognised by the message.
  assert.equal(
    isThreadLocked({
      code: "agent_run_failed",
      error: httpError(409, JSON.stringify(lockBody)),
    }),
    true,
  );
  // A lock found after the stream began arrives as a RUN_ERROR whose code is on the error.
  const inStream = Object.assign(new Error("This conversation is still replying."), {
    code: "agent_thread_locked",
  });
  assert.equal(isThreadLocked({ code: "agent_run_error_event", error: inStream }), true);
});

test("Intelligence lock reports keep working", () => {
  assert.equal(isThreadLocked({ code: threadLocked, error: new Error("Thread is locked") }), true);
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: new AgentThreadLockedError("t-1") }),
    true,
  );
});

test("other failures are not thread locks", () => {
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: httpError(500, { error: "Boom" }) }),
    false,
  );
  assert.equal(
    isThreadLocked({
      code: "agent_run_failed",
      error: httpError(404, { error: "Thread not found" }),
    }),
    false,
  );
  // A lock code on a different status is not a lock refusal.
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: httpError(500, lockBody) }),
    false,
  );
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: httpError(409, { error: "Conflict" }) }),
    false,
  );
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: httpError(409, "Conflict") }),
    false,
  );
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: new Error("Network down") }),
    false,
  );
  assert.equal(
    isThreadLocked({ code: "agent_run_failed", error: new Error("agent_thread_locked") }),
    false,
  );
  assert.equal(isThreadLocked({ code: "agent_run_failed", error: "HTTP 409: locked" }), false);
  assert.equal(isThreadLocked({ error: undefined }), false);
});

test("a turn refused by the SSE 409 fails as threadLocked, not as the generic follow-up", async () => {
  const error = httpError(409, lockBody);
  const bus = reporter([
    { code: "agent_run_failed_event", error, context: { agentId: "openmuse-t-1" } },
    { code: "agent_run_failed", error, context: { agentId: "openmuse-t-1" } },
  ]);
  const failure = await runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe).then(
    () => assert.fail("the turn should fail"),
    (e: unknown) => e,
  );
  assert.ok(failure instanceof ConversationTurnError);
  assert.equal(failure.code, threadLocked);
  assert.equal(failure.cause, error);
  assert.match(failure.message, /^HTTP 409:/);
  assert.equal(bus.listeners.size, 0);
});

test("a lone agent_run_failed carrying the SSE 409 is still threadLocked", async () => {
  const bus = reporter([{ code: "agent_run_failed", error: httpError(409, lockBody) }]);
  await assert.rejects(
    runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe),
    (e: unknown) => e instanceof ConversationTurnError && e.code === threadLocked,
  );
});

test("a generic run failure keeps its own code", async () => {
  const bus = reporter([
    { code: "agent_run_failed_event", error: httpError(500, { error: "Boom" }) },
    { code: "agent_run_failed", error: httpError(500, { error: "Boom" }) },
  ]);
  await assert.rejects(
    runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe),
    (e: unknown) => e instanceof ConversationTurnError && e.code === "agent_run_failed_event",
  );
});

test("reports for other agents and ignored codes do not fail the turn", async () => {
  const bus = reporter([
    { code: "agent_run_failed", error: httpError(409, lockBody), context: { agentId: "other" } },
    { code: replayedRunError, error: new Error("Saved failure") },
  ]);
  await runConversationTurn("openmuse-t-1", bus.execute, bus.subscribe, [replayedRunError]);
});

test("a queued turn refused by the SSE 409 is held silently; anything else shows", () => {
  const event = { code: "agent_run_failed", error: httpError(409, lockBody) };
  assert.equal(showsRunError(event, { replaying: false, queuedTurn: true }), false);
  assert.equal(
    showsRunError(
      { code: "agent_run_failed_event", error: httpError(409, lockBody) },
      { replaying: false, queuedTurn: true },
    ),
    false,
  );
  // Retry is not a queued turn, so the refusal shows.
  assert.equal(showsRunError(event, { replaying: false, queuedTurn: false }), true);
  // A different failure during a queued turn still shows.
  assert.equal(
    showsRunError(
      { code: "agent_run_failed", error: httpError(500, { error: "Boom" }) },
      { replaying: false, queuedTurn: true },
    ),
    true,
  );
  // Replayed history errors stay hidden while replaying.
  assert.equal(
    showsRunError(
      { code: replayedRunError, error: new Error("Saved failure") },
      { replaying: true, queuedTurn: false },
    ),
    false,
  );
});
