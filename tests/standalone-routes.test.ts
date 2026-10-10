// Standalone: the local-mode HTTP layer (runtime hooks and thread routes) against in-memory fakes of
// the store and run-control contracts, plus the real CopilotKit runtime handler with a scripted runner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  CopilotRuntime,
  createCopilotHonoHandler,
  type HandlerHookContext,
  type ResponseHookContext,
} from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { from, type Observable, of } from "rxjs";
import { AppError } from "../apps/server/src/errors.ts";
import { CursorError } from "../apps/server/src/standalone/chat-store.ts";
import {
  chatUnavailableMessage,
  localThreadEndpoints,
  runIdsRequired,
  standaloneRuntimeHooks,
  threadLockedMessage,
} from "../apps/server/src/standalone/runtime-hooks.ts";
import {
  realtimeUnavailable,
  standaloneThreadRoutes,
  type ThreadView,
} from "../apps/server/src/standalone/thread-routes.ts";
import {
  type ClaimResult,
  type DeleteResult,
  type ListThreadsQuery,
  type StandaloneRunControl,
  type StandaloneThreadStore,
  type ThreadPage,
  type ThreadPatch,
  type ThreadRecord,
  threadLockedCode,
  type WireMessage,
} from "../apps/server/src/standalone/types.ts";

// ---------------------------------------------------------------------------------------------
// Fakes of the frozen types.ts contracts.

interface Row {
  id: string;
  owner: string;
  agentId: string;
  name: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  runId: string | null;
  events: BaseEvent[];
}

class MemoryThreads implements StandaloneThreadStore {
  readonly rows = new Map<string, Row>();
  readonly listed: { owner: string; query: ListThreadsQuery }[] = [];
  readonly updates: { owner: string; threadId: string; agentId: string; patch: ThreadPatch }[] = [];
  private clock = Date.parse("2026-10-01T00:00:00.000Z");

  private tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  add(owner: string, id: string, patch: Partial<Row> = {}) {
    const at = this.tick();
    const row: Row = {
      id,
      owner,
      agentId: "default",
      name: null,
      archived: false,
      createdAt: at,
      updatedAt: at,
      lastRunAt: at,
      runId: null,
      events: [],
      ...patch,
    };
    this.rows.set(id, row);
    return row;
  }

  private record(row: Row): ThreadRecord {
    return {
      id: row.id,
      name: row.name,
      agentId: row.agentId,
      organizationId: "",
      createdById: "",
      archived: row.archived,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastRunAt: row.lastRunAt,
    };
  }

  private owned(owner: string, threadId: string, agentId?: string) {
    const row = this.rows.get(threadId);
    return row && row.owner === owner && (agentId === undefined || row.agentId === agentId)
      ? row
      : undefined;
  }

  async ensureThread(owner: string, threadId: string, agentId: string) {
    const row = this.rows.get(threadId);
    if (!row) this.add(owner, threadId, { agentId, lastRunAt: null });
    return !row || row.owner === owner ? "ok" : "forbidden";
  }

  async threadOwner(threadId: string) {
    return this.rows.get(threadId)?.owner ?? null;
  }

  async listThreads(owner: string, query: ListThreadsQuery): Promise<ThreadPage> {
    this.listed.push({ owner, query });
    let offset = 0;
    if (query.cursor !== undefined) {
      offset = Number(Buffer.from(query.cursor, "base64url").toString());
      if (!Number.isInteger(offset) || offset < 0) throw new CursorError();
    }
    const limit = query.limit ?? 50;
    const matching = [...this.rows.values()]
      .filter(
        (row) =>
          row.owner === owner &&
          row.agentId === query.agentId &&
          row.lastRunAt !== null &&
          (query.includeArchived || !row.archived),
      )
      .sort(
        (a, b) =>
          (b.lastRunAt ?? b.createdAt).localeCompare(a.lastRunAt ?? a.createdAt) ||
          b.id.localeCompare(a.id),
      );
    const next = offset + limit;
    return {
      threads: matching.slice(offset, next).map((row) => this.record(row)),
      nextCursor: next < matching.length ? Buffer.from(String(next)).toString("base64url") : null,
    };
  }

  async updateThread(owner: string, threadId: string, agentId: string, patch: ThreadPatch) {
    this.updates.push({ owner, threadId, agentId, patch });
    const row = this.owned(owner, threadId, agentId);
    if (!row) return null;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.archived !== undefined) row.archived = patch.archived;
    row.updatedAt = this.tick();
    return this.record(row);
  }

  async deleteThread(owner: string, threadId: string, agentId: string): Promise<DeleteResult> {
    const row = this.owned(owner, threadId, agentId);
    if (!row) return "not_found";
    if (row.runId) return "running";
    this.rows.delete(threadId);
    return "deleted";
  }

  async threadEvents(owner: string, threadId: string) {
    return this.owned(owner, threadId)?.events ?? null;
  }
}

type Claim = { owner: string; threadId: string; agentId: string; runId: string };

/** Lock control over MemoryThreads; also an AgentRunner so the real runtime can drive it. */
class ScriptedRunner extends AgentRunner implements StandaloneRunControl {
  readonly claims: Claim[] = [];
  readonly releases: { threadId: string; runId: string }[] = [];
  readonly runs: string[] = [];
  readonly connects: string[] = [];
  readonly stops: string[] = [];

  constructor(readonly threads: MemoryThreads) {
    super();
  }

  async claim(input: Claim): Promise<ClaimResult> {
    this.claims.push(input);
    const row = this.threads.rows.get(input.threadId);
    if (row && row.owner !== input.owner) return { ok: false, reason: "forbidden" };
    if (row?.runId) return { ok: false, reason: "locked" };
    const target =
      row ??
      this.threads.add(input.owner, input.threadId, { agentId: input.agentId, lastRunAt: null });
    target.runId = input.runId;
    return { ok: true };
  }

  async release(threadId: string, runId: string) {
    this.releases.push({ threadId, runId });
    const row = this.threads.rows.get(threadId);
    if (row?.runId === runId) row.runId = null;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, runId } = request.input;
    this.runs.push(threadId);
    const row = this.threads.rows.get(threadId);
    if (row) row.runId = null;
    return from([
      { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
    ]);
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    this.connects.push(request.threadId);
    return of(...(this.threads.rows.get(request.threadId)?.events ?? []));
  }

  async isRunning(request: AgentRunnerIsRunningRequest) {
    return Boolean(this.threads.rows.get(request.threadId)?.runId);
  }

  async stop(request: AgentRunnerStopRequest) {
    this.stops.push(request.threadId);
    return false;
  }
}

class StubAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return of({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
  }
}

const auth = {
  async owner(authorization?: string) {
    const owner = authorization?.match(/^Bearer (alice|bob)$/)?.[1];
    if (!owner) throw new AppError("Sign in to OpenMuse", 401);
    return owner;
  },
};

function fixture() {
  const threads = new MemoryThreads();
  const runner = new ScriptedRunner(threads);
  const hooks = standaloneRuntimeHooks({ auth, threads, runs: runner });
  return { threads, runner, hooks };
}

const runtimeStub = {} as HandlerHookContext["runtime"];

function request(path: string, init: { owner?: string; method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "POST",
    headers: {
      ...(init.owner ? { Authorization: `Bearer ${init.owner}` } : {}),
      "Content-Type": "application/json",
    },
    ...(init.body === undefined
      ? {}
      : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
  });
}

function handlerContext(req: Request, route: HandlerHookContext["route"]): HandlerHookContext {
  return { request: req, path: new URL(req.url).pathname, runtime: runtimeStub, route };
}

function responseContext(
  req: Request,
  route: ResponseHookContext["route"],
  response: Response,
): ResponseHookContext {
  return { ...handlerContext(req, route), response };
}

function runBody(threadId: string, runId: string, messages: unknown[] = []) {
  return { threadId, runId, messages, tools: [], context: [], state: {}, forwardedProps: {} };
}

/** The hook's thrown Response (hooks short-circuit by throwing a Response). */
async function thrown(promise: unknown): Promise<Response> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  assert.fail("expected the hook to throw a Response");
}

// ---------------------------------------------------------------------------------------------
// Runtime hooks, called directly.

test("a run on a busy thread is refused with the typed 409 before the runtime answers", async () => {
  const { threads, runner, hooks } = fixture();
  threads.add("alice", "busy", { runId: "running-run" });
  const req = request("/api/copilotkit/agent/default/run", {
    owner: "alice",
    body: runBody("busy", "second-run"),
  });
  const refused = await thrown(
    hooks.onBeforeHandler(handlerContext(req, { method: "agent/run", agentId: "default" })),
  );
  assert.equal(refused.status, 409);
  assert.match(refused.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await refused.json(), {
    error: threadLockedMessage,
    code: "agent_thread_locked",
  });
  assert.equal(threadLockedCode, "agent_thread_locked");
  assert.deepEqual(runner.claims, [
    { owner: "alice", threadId: "busy", agentId: "default", runId: "second-run" },
  ]);
  // The runtime passes the thrown 409 to onResponse; it was never claimed, so nothing is released.
  await hooks.onResponse(
    responseContext(req, { method: "agent/run", agentId: "default" }, refused),
  );
  assert.deepEqual(runner.releases, []);
  assert.equal(threads.rows.get("busy")?.runId, "running-run");
});

test("a run claims the thread for the session owner and keeps the claim on a 200 stream", async () => {
  const { threads, runner, hooks } = fixture();
  const req = request("/api/copilotkit/agent/default/run", {
    owner: "alice",
    body: { ...runBody("new-thread", "run-1"), userId: "bob" },
  });
  const route = { method: "agent/run", agentId: "default" } as const;
  assert.equal(await hooks.onBeforeHandler(handlerContext(req, route)), undefined);
  assert.deepEqual(runner.claims, [
    { owner: "alice", threadId: "new-thread", agentId: "default", runId: "run-1" },
  ]);
  assert.equal(threads.rows.get("new-thread")?.owner, "alice");
  // The body is still readable by the runtime after the hook peeked at it.
  assert.equal((await req.json()).threadId, "new-thread");
  const stream = new Response("data: {}\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  assert.equal(await hooks.onResponse(responseContext(req, route, stream)), undefined);
  assert.deepEqual(runner.releases, []);
  assert.equal(threads.rows.get("new-thread")?.runId, "run-1");
});

test("a non-200 runtime answer releases the claim the hook took", async () => {
  for (const status of [400, 404, 500]) {
    const { threads, runner, hooks } = fixture();
    const req = request("/api/copilotkit/agent/missing/run", {
      owner: "alice",
      body: runBody("thread-1", `run-${status}`),
    });
    const route = { method: "agent/run", agentId: "missing" } as const;
    await hooks.onBeforeHandler(handlerContext(req, route));
    assert.equal(threads.rows.get("thread-1")?.runId, `run-${status}`);
    await hooks.onResponse(
      responseContext(req, route, Response.json({ error: "Agent not found" }, { status })),
    );
    assert.deepEqual(runner.releases, [{ threadId: "thread-1", runId: `run-${status}` }]);
    assert.equal(threads.rows.get("thread-1")?.runId, null);
  }
});

test("a run without usable ids answers 400 before the runtime runs and claims nothing", async () => {
  const { threads, runner, hooks } = fixture();
  threads.add("alice", "alice-thread");
  const route = { method: "agent/run", agentId: "default" } as const;
  // Not a JSON object: the runtime's own body validation answers 400.
  for (const body of ["not json", []]) {
    const req = request("/api/copilotkit/agent/default/run", { owner: "bob", body });
    assert.equal(await hooks.onBeforeHandler(handlerContext(req, route)), undefined);
    await hooks.onResponse(responseContext(req, route, Response.json({}, { status: 400 })));
  }
  // An object whose ids the hook cannot claim: the runtime would accept any string and run it
  // unclaimed, without the owner check, so the hook refuses it, here on another owner's thread.
  for (const body of [
    { runId: "run" },
    { threadId: "", runId: "run" },
    { threadId: "thread", runId: 7 },
    { threadId: "t".repeat(257), runId: "run" },
    { threadId: "alice-thread", runId: "" },
    { threadId: "alice-thread", runId: "r".repeat(300) },
  ]) {
    const req = request("/api/copilotkit/agent/default/run", { owner: "bob", body });
    const refused = await thrown(hooks.onBeforeHandler(handlerContext(req, route)));
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await refused.json(), { error: runIdsRequired });
  }
  assert.deepEqual(runner.claims, []);
  assert.deepEqual(runner.releases, []);
  assert.equal(threads.rows.get("alice-thread")?.runId, null);
});

test("another owner's thread is 404 on run, connect and stop, and no lock is taken", async () => {
  const { threads, runner, hooks } = fixture();
  threads.add("alice", "alice-thread");
  const run = await thrown(
    hooks.onBeforeHandler(
      handlerContext(
        request("/api/copilotkit/agent/default/run", {
          owner: "bob",
          body: runBody("alice-thread", "bob-run"),
        }),
        { method: "agent/run", agentId: "default" },
      ),
    ),
  );
  assert.equal(run.status, 404);
  assert.deepEqual(await run.json(), { error: "Thread not found" });
  assert.equal(threads.rows.get("alice-thread")?.runId, null);

  const connect = await thrown(
    hooks.onBeforeHandler(
      handlerContext(
        request("/api/copilotkit/agent/default/connect", {
          owner: "bob",
          body: runBody("alice-thread", "bob-connect"),
        }),
        { method: "agent/connect", agentId: "default" },
      ),
    ),
  );
  assert.equal(connect.status, 404);
  const stop = await thrown(
    hooks.onBeforeHandler(
      handlerContext(request("/api/copilotkit/agent/default/stop/alice-thread", { owner: "bob" }), {
        method: "agent/stop",
        agentId: "default",
        threadId: "alice-thread",
      }),
    ),
  );
  assert.equal(stop.status, 404);
  assert.deepEqual(await stop.json(), { error: "Thread not found" });
  // Only the run attempted a claim (which reported forbidden); connect and stop never claim.
  assert.deepEqual(
    runner.claims.map((claim) => claim.owner),
    ["bob"],
  );

  // The owner passes, and so does a thread that does not exist yet.
  for (const threadId of ["alice-thread", "missing-thread"]) {
    assert.equal(
      await hooks.onBeforeHandler(
        handlerContext(
          request("/api/copilotkit/agent/default/connect", {
            owner: "alice",
            body: runBody(threadId, "connect"),
          }),
          { method: "agent/connect", agentId: "default" },
        ),
      ),
      undefined,
    );
    assert.equal(
      await hooks.onBeforeHandler(
        handlerContext(
          request(`/api/copilotkit/agent/default/stop/${threadId}`, { owner: "alice" }),
          {
            method: "agent/stop",
            agentId: "default",
            threadId,
          },
        ),
      ),
      undefined,
    );
  }
});

test("a database failure while claiming or checking the owner is a 503 JSON, not a stream", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { threads, runner, hooks } = fixture();
  threads.add("alice", "alice-thread");
  const failure = Object.assign(new Error("connection refused for postgres://secret"), {
    code: "ECONNREFUSED",
  });
  t.mock.method(runner, "claim", async () => {
    throw failure;
  });
  t.mock.method(threads, "threadOwner", async () => {
    throw failure;
  });
  for (const [path, route, body] of [
    [
      "/api/copilotkit/agent/default/run",
      { method: "agent/run", agentId: "default" },
      runBody("alice-thread", "run-1"),
    ],
    [
      "/api/copilotkit/agent/default/connect",
      { method: "agent/connect", agentId: "default" },
      runBody("alice-thread", "connect-1"),
    ],
    [
      "/api/copilotkit/agent/default/stop/alice-thread",
      { method: "agent/stop", agentId: "default", threadId: "alice-thread" },
      undefined,
    ],
  ] as const) {
    const response = await thrown(
      hooks.onBeforeHandler(handlerContext(request(path, { owner: "alice", body }), route)),
    );
    assert.equal(response.status, 503, path);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await response.json(), { error: chatUnavailableMessage });
  }
  assert.equal(threads.rows.get("alice-thread")?.runId, null);
  assert.equal(
    logged.mock.calls.some((call) => String(call.arguments[0]).includes("secret")),
    false,
  );
});

test("hooks reject a request without a valid session and hide the shared debug stream", async () => {
  const { runner, hooks } = fixture();
  const unauthenticated = await thrown(
    hooks.onBeforeHandler(
      handlerContext(
        request("/api/copilotkit/agent/default/run", { body: runBody("thread", "run") }),
        { method: "agent/run", agentId: "default" },
      ),
    ),
  );
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: "Sign in to OpenMuse" });
  assert.deepEqual(runner.claims, []);
  const debug = await thrown(
    hooks.onBeforeHandler(
      handlerContext(
        request("/api/copilotkit/cpk-debug-events", { owner: "alice", method: "GET" }),
        {
          method: "cpk-debug-events",
        },
      ),
    ),
  );
  assert.equal(debug.status, 404);
  for (const route of [
    { method: "info" },
    { method: "threads/subscribe" },
    { method: "threads/clear" },
    { method: "agent/suggest", agentId: "default" },
  ] as const)
    assert.equal(
      await hooks.onBeforeHandler(
        handlerContext(request("/api/copilotkit/x", { owner: "alice" }), route),
      ),
      undefined,
    );
});

test("/info advertises the local thread routes and keeps the rest of the runtime body", async () => {
  const { hooks } = fixture();
  const info = {
    version: "1.70.1",
    mode: "sse",
    agents: { default: { name: "default" } },
    threadEndpoints: { list: false, inspect: false, mutations: false, realtimeMetadata: false },
    suggestions: true,
  };
  const req = request("/api/copilotkit/info", { owner: "alice", method: "GET" });
  const rewritten = await hooks.onResponse(
    responseContext(
      req,
      { method: "info" },
      Response.json(info, { headers: { "X-Test": "kept" } }),
    ),
  );
  assert.ok(rewritten);
  assert.equal(rewritten.status, 200);
  assert.equal(rewritten.headers.get("x-test"), "kept");
  assert.match(rewritten.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await rewritten.json(), {
    ...info,
    threadEndpoints: { list: true, inspect: true, mutations: true, realtimeMetadata: false },
  });
  assert.deepEqual(localThreadEndpoints, {
    list: true,
    inspect: true,
    mutations: true,
    realtimeMetadata: false,
  });
  // Errors and other routes are untouched.
  const failed = Response.json({ error: "Not found" }, { status: 404 });
  assert.equal(await hooks.onResponse(responseContext(req, { method: "info" }, failed)), undefined);
  assert.equal(
    await hooks.onResponse(
      responseContext(req, { method: "threads/list" }, Response.json({ threads: [] })),
    ),
    undefined,
  );
});

// ---------------------------------------------------------------------------------------------
// The same hooks inside the real CopilotKit runtime handler (route matching, thrown Responses).

/** Runtime 1.70 streams SSE as strings (app.ts re-encodes them); read either kind of chunk. */
async function streamText(response: Response) {
  const reader = (response.body as ReadableStream<string | Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    text += typeof chunk.value === "string" ? chunk.value : decoder.decode(chunk.value);
  return text;
}

function runtimeFixture() {
  const { threads, runner, hooks } = fixture();
  const runtime = new CopilotRuntime({ agents: { default: new StubAgent() }, runner });
  const handler = createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit", hooks });
  const call = (path: string, init: { owner?: string; method?: string; body?: unknown } = {}) =>
    handler.fetch(request(path, init));
  return { threads, runner, call };
}

test("through the runtime: busy is 409 JSON before SSE; a free thread streams; non-200 releases", async (t) => {
  t.mock.method(console, "error", () => {}); // the runtime logs the refused runs
  const { threads, runner, call } = runtimeFixture();
  threads.add("alice", "busy", { runId: "running-run" });
  const busy = await call("/api/copilotkit/agent/default/run", {
    owner: "alice",
    body: runBody("busy", "second-run"),
  });
  assert.equal(busy.status, 409);
  assert.match(busy.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await busy.json(), { error: threadLockedMessage, code: threadLockedCode });
  assert.deepEqual(runner.runs, []);

  const ok = await call("/api/copilotkit/agent/default/run", {
    owner: "alice",
    body: runBody("free", "run-1", [{ id: "m1", role: "user", content: "Hi" }]),
  });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(await streamText(ok), /RUN_FINISHED/);
  assert.deepEqual(runner.runs, ["free"]);
  assert.deepEqual(runner.releases, []);

  const unknownAgent = await call("/api/copilotkit/agent/nope/run", {
    owner: "alice",
    body: runBody("free", "run-2"),
  });
  assert.equal(unknownAgent.status, 404);
  const invalid = await call("/api/copilotkit/agent/default/run", {
    owner: "alice",
    body: { ...runBody("free", "run-3"), messages: "not a list" },
  });
  // Runtime 1.70.1 answers an invalid run body with 500 (its request logger throws); 400 later.
  assert.ok([400, 500].includes(invalid.status), String(invalid.status));
  assert.deepEqual(runner.releases, [
    { threadId: "free", runId: "run-2" },
    { threadId: "free", runId: "run-3" },
  ]);
  assert.equal(threads.rows.get("free")?.runId, null);
});

test("through the runtime: owner checks follow the runtime's route matching, not exact paths", async () => {
  const { threads, runner, call } = runtimeFixture();
  threads.add("alice", "alice-thread");
  for (const path of [
    "/api/copilotkit/agent/default/run",
    "/api/copilotkit/threads/x/agent/default/run",
  ]) {
    const run = await call(path, { owner: "bob", body: runBody("alice-thread", "bob-run") });
    assert.equal(run.status, 404, path);
  }
  const connect = await call("/api/copilotkit/extra/agent/default/connect", {
    owner: "bob",
    body: runBody("alice-thread", "bob-connect"),
  });
  assert.equal(connect.status, 404);
  const stop = await call("/api/copilotkit/agent/default/stop/alice-thread", { owner: "bob" });
  assert.equal(stop.status, 404);
  assert.deepEqual(runner.runs, []);
  assert.deepEqual(runner.connects, []);
  assert.deepEqual(runner.stops, []);
  assert.equal(threads.rows.get("alice-thread")?.runId, null);

  const own = await call("/api/copilotkit/agent/default/stop/alice-thread", { owner: "alice" });
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), {
    stopped: false,
    message: "No active run for thread 'alice-thread'.",
  });
  const debug = await call("/api/copilotkit/cpk-debug-events", { owner: "alice", method: "GET" });
  assert.equal(debug.status, 404);

  const info = await call("/api/copilotkit/info", { owner: "alice", method: "GET" });
  const body = await info.json();
  assert.equal(body.mode, "sse");
  assert.deepEqual(body.threadEndpoints, localThreadEndpoints);
  assert.equal("intelligence" in body, false);
});

// ---------------------------------------------------------------------------------------------
// Thread routes (Hono), mounted the way app.ts mounts them.

function routesApp(threads: StandaloneThreadStore, view?: ThreadView) {
  const app = new Hono<{ Variables: { owner: string } }>();
  // Mirrors app.ts: AppError keeps its status, malformed JSON is 400.
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    return c.json({ error: "Request failed" }, 502);
  });
  app.use("/api/*", async (c, next) => {
    c.set("owner", await auth.owner(c.req.header("authorization")));
    await next();
  });
  app.route("/api/copilotkit/threads", standaloneThreadRoutes(threads, view));
  app.all("/api/copilotkit/*", (c) => c.json({ runtime: `${c.req.method} ${c.req.path}` }, 202));
  const call = (path: string, init: { owner?: string; method?: string; body?: unknown } = {}) =>
    app.request(request(path, { method: "GET", owner: "alice", ...init }));
  return { app, call };
}

test("list is owner-scoped, newest first, paginated, and hides archived threads unless asked", async () => {
  const threads = new MemoryThreads();
  threads.add("alice", "a1");
  threads.add("alice", "a2", { name: "Trip" });
  threads.add("alice", "a3", { archived: true });
  threads.add("alice", "a4");
  threads.add("alice", "never-ran", { lastRunAt: null });
  threads.add("alice", "other-agent", { agentId: "helper" });
  threads.add("bob", "b1");
  const { call } = routesApp(threads);

  const first = await call(
    "/api/copilotkit/threads?agentId=default&limit=2&userId=bob&organizationId=x",
  );
  assert.equal(first.status, 200);
  const page1 = await first.json();
  assert.deepEqual(
    page1.threads.map((thread: ThreadRecord) => thread.id),
    ["a4", "a2"],
  );
  assert.equal(typeof page1.nextCursor, "string");
  const second = await (
    await call(
      `/api/copilotkit/threads?agentId=default&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
    )
  ).json();
  assert.deepEqual(
    second.threads.map((thread: ThreadRecord) => thread.id),
    ["a1"],
  );
  assert.equal(second.nextCursor, null);
  assert.deepEqual(page1.threads[1], {
    id: "a2",
    name: "Trip",
    agentId: "default",
    organizationId: "",
    createdById: "",
    archived: false,
    createdAt: threads.rows.get("a2")?.createdAt,
    updatedAt: threads.rows.get("a2")?.updatedAt,
    lastRunAt: threads.rows.get("a2")?.lastRunAt,
  });

  const archived = await (
    await call("/api/copilotkit/threads?agentId=default&includeArchived=true")
  ).json();
  assert.deepEqual(
    archived.threads.map((thread: ThreadRecord) => thread.id),
    ["a4", "a3", "a2", "a1"],
  );
  const bob = await (
    await call("/api/copilotkit/threads?agentId=default", { owner: "bob" })
  ).json();
  assert.deepEqual(
    bob.threads.map((thread: ThreadRecord) => thread.id),
    ["b1"],
  );
  // The store sees the session owner and the default page size; forged owner fields never reach it.
  assert.deepEqual(threads.listed[0], {
    owner: "alice",
    query: { agentId: "default", includeArchived: false, limit: 2 },
  });
  assert.deepEqual(threads.listed[2], {
    owner: "alice",
    query: { agentId: "default", includeArchived: true, limit: 50 },
  });
  assert.equal(threads.listed[3]?.owner, "bob");
});

test("list rejects a missing agentId, a bad limit and a bad cursor with 400", async () => {
  const { call } = routesApp(new MemoryThreads());
  for (const query of [
    "",
    "?agentId=",
    `?agentId=${"a".repeat(129)}`,
    "?agentId=default&limit=0",
    "?agentId=default&limit=101",
    "?agentId=default&limit=ten",
    "?agentId=default&cursor=not-a-cursor",
  ]) {
    const response = await call(`/api/copilotkit/threads${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.equal((await call("/api/copilotkit/threads?agentId=default", { owner: "" })).status, 401);
});

test("messages, events and state come from the owner's stored events and 404 otherwise", async () => {
  const threads = new MemoryThreads();
  const events = [
    {
      type: EventType.RUN_STARTED,
      threadId: "a1",
      runId: "r1",
      input: { threadId: "a1", runId: "r1", messages: [{ id: "u1", role: "user", content: "Hi" }] },
    },
    { type: EventType.STATE_SNAPSHOT, snapshot: { step: 2 } },
    { type: EventType.RUN_FINISHED, threadId: "a1", runId: "r1" },
  ] as BaseEvent[];
  threads.add("alice", "a1", { events });
  threads.add("bob", "b1", { events });
  const seen: BaseEvent[][] = [];
  const wire: WireMessage[] = [
    { id: "u1", role: "user", content: "Hi" },
    {
      id: "a1-reply",
      role: "assistant",
      content: "Working on it",
      toolCalls: [{ id: "call-1", name: "delegate_task", args: "{}" }],
    },
    { id: "tool-1", role: "tool", content: '{"taskId":"task-1"}', toolCallId: "call-1" },
  ];
  const view: ThreadView = {
    messages: (input) => {
      seen.push(input);
      return wire;
    },
    state: (input) => {
      seen.push(input);
      return { step: 2 };
    },
  };
  const { call } = routesApp(threads, view);

  const messages = await call("/api/copilotkit/threads/a1/messages?userId=bob");
  assert.equal(messages.status, 200);
  assert.deepEqual(await messages.json(), { messages: wire });
  const eventsResponse = await call("/api/copilotkit/threads/a1/events");
  assert.deepEqual(await eventsResponse.json(), { events });
  const state = await call("/api/copilotkit/threads/a1/state");
  assert.deepEqual(await state.json(), { state: { step: 2 } });
  assert.deepEqual(seen, [events, events]);

  for (const path of ["b1", "missing"])
    for (const suffix of ["messages", "events", "state"]) {
      const response = await call(`/api/copilotkit/threads/${path}/${suffix}`);
      assert.equal(response.status, 404, `${path}/${suffix}`);
      assert.deepEqual(await response.json(), { error: "Thread not found" });
    }
  assert.equal(seen.length, 2);
  assert.equal((await call(`/api/copilotkit/threads/${"t".repeat(257)}/messages`)).status, 400);
});

test("rename, archive, unarchive and delete are owner-bound and ignore forged owner fields", async () => {
  const threads = new MemoryThreads();
  threads.add("alice", "a1");
  threads.add("bob", "b1");
  const { call } = routesApp(threads);

  const renamed = await call("/api/copilotkit/threads/a1", {
    method: "PATCH",
    body: { agentId: "default", name: "  Weekend plans ", userId: "bob", owner: "bob" },
  });
  assert.equal(renamed.status, 200);
  const record = await renamed.json();
  assert.equal(record.id, "a1");
  assert.equal(record.name, "Weekend plans");
  assert.equal(record.organizationId, "");
  assert.equal(record.createdById, "");
  assert.deepEqual(threads.updates.at(-1), {
    owner: "alice",
    threadId: "a1",
    agentId: "default",
    patch: { name: "Weekend plans" },
  });

  const archived = await call("/api/copilotkit/threads/a1/archive", {
    method: "POST",
    body: { agentId: "default", userId: "bob" },
  });
  assert.equal(archived.status, 200);
  assert.deepEqual(await archived.json(), { threadId: "a1", archived: true });
  assert.equal(threads.rows.get("a1")?.archived, true);

  const restored = await call("/api/copilotkit/threads/a1", {
    method: "PATCH",
    body: { agentId: "default", archived: false },
  });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).archived, false);
  assert.deepEqual(threads.updates.at(-1)?.patch, { archived: false });

  // Another owner's thread, a missing thread and an agentId mismatch are all 404.
  for (const [path, agentId] of [
    ["b1", "default"],
    ["missing", "default"],
    ["a1", "helper"],
  ]) {
    for (const [method, suffix] of [
      ["PATCH", ""],
      ["POST", "/archive"],
      ["DELETE", ""],
    ]) {
      const response = await call(`/api/copilotkit/threads/${path}${suffix}`, {
        method,
        body: { agentId, name: "Taken" },
      });
      assert.equal(response.status, 404, `${method} ${path}${suffix} ${agentId}`);
      assert.deepEqual(await response.json(), { error: "Thread not found" });
    }
  }
  assert.equal(threads.rows.get("b1")?.name, null);
  assert.equal(threads.rows.get("a1")?.name, "Weekend plans");

  threads.rows.set("a1", { ...(threads.rows.get("a1") as Row), runId: "live-run" });
  const locked = await call("/api/copilotkit/threads/a1", {
    method: "DELETE",
    body: { agentId: "default" },
  });
  assert.equal(locked.status, 409);
  assert.deepEqual(await locked.json(), {
    error: threadLockedMessage,
    code: "agent_thread_locked",
  });
  assert.ok(threads.rows.has("a1"));
  (threads.rows.get("a1") as Row).runId = null;
  const deleted = await call("/api/copilotkit/threads/a1", {
    method: "DELETE",
    body: { agentId: "default", userId: "bob" },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { threadId: "a1", deleted: true });
  assert.equal(threads.rows.has("a1"), false);
  assert.ok(threads.rows.has("b1"));
});

test("thread mutations reject invalid bodies with 400", async () => {
  const threads = new MemoryThreads();
  threads.add("alice", "a1");
  const { call } = routesApp(threads);
  for (const [method, suffix, body] of [
    ["PATCH", "", {}],
    ["PATCH", "", { agentId: "" }],
    ["PATCH", "", { agentId: "default", name: "" }],
    ["PATCH", "", { agentId: "default", name: "   " }],
    ["PATCH", "", { agentId: "default", name: "n".repeat(201) }],
    ["PATCH", "", { agentId: "default", name: 7 }],
    ["PATCH", "", { agentId: "default", archived: "no" }],
    ["PATCH", "", "{not json"],
    ["POST", "/archive", {}],
    ["POST", "/archive", "{not json"],
    ["DELETE", "", { agentId: 1 }],
    ["DELETE", "", "{not json"],
  ] as const) {
    const response = await call(`/api/copilotkit/threads/a1${suffix}`, { method, body });
    assert.equal(response.status, 400, `${method}${suffix} ${JSON.stringify(body)}`);
  }
  assert.equal(threads.updates.length, 0);
  assert.ok(threads.rows.has("a1"));
});

test("realtime subscribe is 404 locally; other routes the local layer does not serve fall through", async () => {
  const { call } = routesApp(new MemoryThreads());
  const subscribe = await call("/api/copilotkit/threads/subscribe", { method: "POST", body: {} });
  assert.equal(subscribe.status, 404);
  assert.deepEqual(await subscribe.json(), { error: realtimeUnavailable });
  for (const [method, path] of [
    ["POST", "/api/copilotkit/threads/clear"],
    ["GET", "/api/copilotkit/memories"],
    ["GET", "/api/copilotkit/threads/a/b/messages"],
  ]) {
    const response = await call(path, { method, body: method === "POST" ? {} : undefined });
    assert.equal(response.status, 202, `${method} ${path}`);
    assert.deepEqual(await response.json(), { runtime: `${method} ${path}` });
  }
});
