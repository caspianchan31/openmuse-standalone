// Standalone: local chat mode end to end, without CPK_INTELLIGENCE_API_KEY, through the real
// createApp, the real CopilotKit runtime HTTP path, the local runner and the sample agent.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import type { Store } from "../apps/server/src/db.ts";
import type { StandaloneChat } from "../apps/server/src/standalone/index.ts";
import {
  localThreadEndpoints,
  threadLockedMessage,
} from "../apps/server/src/standalone/runtime-hooks.ts";
import type { ThreadRecord, WireMessage } from "../apps/server/src/standalone/types.ts";
import { createChatTestStore } from "./helpers/chat-database.ts";

let db: Store, directory: string, token: string, otherToken: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let chat: StandaloneChat;
const intelligenceCalls: string[] = [];
const cloudFetches: string[] = [];

const headers = (as = token) => ({
  Authorization: `Bearer ${as}`,
  "Content-Type": "application/json",
});
const get = (path: string, as = token) => app.request(path, { headers: headers(as) });
const send = (method: string, path: string, body: unknown, as = token) =>
  app.request(path, { method, headers: headers(as), body: JSON.stringify(body) });

function runInput(threadId: string, messages: unknown[] = [], runId: string = randomUUID()) {
  return { threadId, runId, messages, tools: [], context: [], state: {}, forwardedProps: {} };
}
const userMessage = (content: string) => ({ id: randomUUID(), role: "user", content });

function sseEvents(text: string): BaseEvent[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent);
}

/** Runs one turn over SSE and returns its events once the stream (and the save) has finished. */
async function runTurn(threadId: string, messages: unknown[], as = token) {
  const response = await send(
    "POST",
    "/api/copilotkit/agent/default/run",
    runInput(threadId, messages),
    as,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return sseEvents(await response.text());
}

async function listAll(query = "") {
  const ids: string[] = [];
  const records: ThreadRecord[] = [];
  let cursor: string | null = null;
  do {
    const response = await get(
      `/api/copilotkit/threads?agentId=default&limit=2${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    assert.equal(response.status, 200);
    const page = (await response.json()) as { threads: ThreadRecord[]; nextCursor: string | null };
    assert.ok(page.threads.length <= 2);
    for (const thread of page.threads) {
      ids.push(thread.id);
      records.push(thread);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { ids, records };
}

before(async () => {
  // Every Intelligence method records and fails: local mode must never reach the service.
  const prototype = CopilotKitIntelligence.prototype as unknown as Record<string, () => unknown>;
  for (const name of Object.getOwnPropertyNames(CopilotKitIntelligence.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(CopilotKitIntelligence.prototype, name);
    if (name === "constructor" || typeof descriptor?.value !== "function") continue;
    mock.method(prototype, name, () => {
      intelligenceCalls.push(name);
      throw new Error(`CopilotKit Intelligence ${name} was called in local mode`);
    });
  }
  const realFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (/copilotkit/i.test(url.hostname)) cloudFetches.push(url.origin);
    return realFetch(input, init);
  });

  directory = await mkdtemp(join(tmpdir(), "openmuse-standalone-api-"));
  db = await createChatTestStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  const created = await createApp(db, config);
  app = created.app;
  assert.ok(created.chat, "a keyless app runs local chat");
  chat = created.chat;
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
  // A second signed-in owner (sessions are owner-bound rows; the shared access key only mints local-user).
  otherToken = randomUUID();
  await db.put("system", "sessions", {
    id: createHash("sha256").update(otherToken).digest("hex"),
    owner: "other",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
});

after(async () => {
  await chat?.close();
  mock.restoreAll();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("keyless startup reports local threads and serves /info in SSE mode without Intelligence", async () => {
  const workspace = await (await get("/api/workspace")).json();
  assert.equal(workspace.runtime.richThreads, true);
  assert.equal(workspace.runtime.threads, "local");

  const response = await get("/api/copilotkit/info");
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.mode, "sse");
  assert.deepEqual(info.threadEndpoints, localThreadEndpoints);
  assert.equal("intelligence" in info, false);
  assert.ok(info.agents.default);
  assert.deepEqual(intelligenceCalls, []);
});

test("the main thread is a stable server id recorded locally for its owner", async () => {
  const first = await (await get("/api/main-thread")).json();
  const again = await (await get("/api/main-thread")).json();
  assert.equal(first.existing, true);
  assert.equal(again.threadId, first.threadId);
  const other = await (await get("/api/main-thread", otherToken)).json();
  assert.notEqual(other.threadId, first.threadId);
  // Recorded for local-user: another owner cannot run on it.
  const refused = await send(
    "POST",
    "/api/copilotkit/agent/default/run",
    runInput(first.threadId, [userMessage("Hello")]),
    otherToken,
  );
  assert.equal(refused.status, 404);
  assert.equal(await chat.runner.isRunning({ threadId: first.threadId }), false);
  // The owner's first run on the main thread works and is listed afterwards.
  await runTurn(first.threadId, [userMessage("Show my calendar")]);
  const { ids } = await listAll();
  assert.ok(ids.includes(first.threadId));
  assert.deepEqual(intelligenceCalls, []);
});

test("a run streams over SSE, is saved, and is listed, inspected and replayed", async () => {
  const threadId = randomUUID();
  const first = userMessage("Show my calendar");
  const events = await runTurn(threadId, [first]);
  const types = events.map((event) => event.type);
  assert.equal(types[0], EventType.RUN_STARTED);
  assert.equal(types.at(-1), EventType.RUN_FINISHED);
  assert.ok(types.includes(EventType.TEXT_MESSAGE_CONTENT));
  assert.match(JSON.stringify(events), /Your local calendar has/);

  const { records } = await listAll();
  const record = records.find((thread) => thread.id === threadId);
  assert.ok(record);
  assert.equal(record.agentId, "default");
  assert.equal(record.archived, false);
  assert.equal(record.organizationId, "");
  assert.equal(record.createdById, "");
  assert.ok(record.lastRunAt && !Number.isNaN(Date.parse(record.lastRunAt)));

  const messages = (await (await get(`/api/copilotkit/threads/${threadId}/messages`)).json())
    .messages as WireMessage[];
  assert.deepEqual(messages[0], { id: first.id, role: "user", content: "Show my calendar" });
  assert.ok(
    messages.some(
      (message) =>
        message.role === "assistant" && /Your local calendar has/.test(String(message.content)),
    ),
  );
  const stored = (await (await get(`/api/copilotkit/threads/${threadId}/events`)).json())
    .events as BaseEvent[];
  assert.equal(stored[0]?.type, EventType.RUN_STARTED);
  assert.deepEqual(
    (stored[0] as BaseEvent & { input?: { messages?: { id: string }[] } }).input?.messages?.map(
      (message) => message.id,
    ),
    [first.id],
  );
  const state = await get(`/api/copilotkit/threads/${threadId}/state`);
  assert.equal(state.status, 200);
  assert.ok("state" in (await state.json()));

  // connect replays the saved conversation and ends because the thread is idle.
  const connect = await send("POST", "/api/copilotkit/agent/default/connect", runInput(threadId));
  assert.equal(connect.status, 200);
  assert.match(connect.headers.get("content-type") ?? "", /text\/event-stream/);
  const replay = await connect.text();
  assert.match(replay, /Your local calendar has/);
  assert.match(replay, new RegExp(first.id));

  // The client resends its whole history; each message is stored once.
  const second = userMessage("Show my calendar again");
  await runTurn(threadId, [first, second]);
  const after = (await (await get(`/api/copilotkit/threads/${threadId}/messages`)).json())
    .messages as WireMessage[];
  const ids = after.map((message) => message.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.indexOf(first.id) < ids.indexOf(second.id));
  assert.deepEqual(intelligenceCalls, []);
});

test("tool calls keep the runtime's message shape", async () => {
  const threadId = randomUUID();
  await runTurn(threadId, [userMessage("Complete the permission slip")]);
  const messages = (await (await get(`/api/copilotkit/threads/${threadId}/messages`)).json())
    .messages as WireMessage[];
  const assistant = messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  assert.ok(assistant && assistant.role === "assistant" && assistant.toolCalls);
  const call = assistant.toolCalls[0];
  assert.ok(call);
  assert.equal(call.name, "delegate_task");
  assert.equal(typeof call.args, "string");
  const tool = messages.find((message) => message.role === "tool");
  assert.ok(tool && tool.role === "tool");
  assert.equal(tool.toolCallId, call.id);
});

test("a busy thread answers 409 JSON before any SSE and cannot be deleted", async () => {
  const threadId = randomUUID();
  await runTurn(threadId, [userMessage("Show my calendar")]);
  assert.deepEqual(
    await chat.runner.claim({
      owner: "local-user",
      threadId,
      agentId: "default",
      runId: "held-run",
    }),
    { ok: true },
  );
  const busy = await send(
    "POST",
    "/api/copilotkit/agent/default/run",
    runInput(threadId, [userMessage("Again")]),
  );
  assert.equal(busy.status, 409);
  assert.match(busy.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await busy.json(), {
    error: threadLockedMessage,
    code: "agent_thread_locked",
  });
  const deleting = await send("DELETE", `/api/copilotkit/threads/${threadId}`, {
    agentId: "default",
  });
  assert.equal(deleting.status, 409);
  assert.equal((await deleting.json()).code, "agent_thread_locked");

  await chat.runner.release(threadId, "held-run");
  assert.equal(await chat.runner.isRunning({ threadId }), false);
  await runTurn(threadId, [userMessage("Show my calendar")]);
});

test("another owner gets 404 for every thread route and agent route, and takes no lock", async () => {
  const threadId = randomUUID();
  await runTurn(threadId, [userMessage("Show my calendar")]);
  const before = await (await get(`/api/copilotkit/threads/${threadId}/messages`)).json();

  const list = await (
    await get("/api/copilotkit/threads?agentId=default&includeArchived=true", otherToken)
  ).json();
  assert.equal(
    list.threads.some((thread: ThreadRecord) => thread.id === threadId),
    false,
  );
  for (const suffix of ["messages", "events", "state"])
    assert.equal(
      (await get(`/api/copilotkit/threads/${threadId}/${suffix}`, otherToken)).status,
      404,
    );
  for (const [method, path, body] of [
    ["PATCH", `/api/copilotkit/threads/${threadId}`, { agentId: "default", name: "Taken" }],
    ["POST", `/api/copilotkit/threads/${threadId}/archive`, { agentId: "default" }],
    ["DELETE", `/api/copilotkit/threads/${threadId}`, { agentId: "default", userId: "local-user" }],
    ["POST", "/api/copilotkit/agent/default/run", runInput(threadId, [userMessage("Hi")])],
    ["POST", "/api/copilotkit/agent/default/connect", runInput(threadId)],
    ["POST", `/api/copilotkit/agent/default/stop/${threadId}`, {}],
  ] as const) {
    const response = await send(method, path, body, otherToken);
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(await chat.runner.isRunning({ threadId }), false);
  assert.deepEqual(
    await (await get(`/api/copilotkit/threads/${threadId}/messages`)).json(),
    before,
  );
  const { records } = await listAll("&includeArchived=true");
  const record = records.find((thread) => thread.id === threadId);
  assert.equal(record?.name, null);
  assert.equal(record?.archived, false);
});

test("a run with an unusable runId is refused with 400, so it cannot write to another owner's thread", async () => {
  const threadId = randomUUID();
  await runTurn(threadId, [userMessage("Show my calendar")]);
  const before = await (await get(`/api/copilotkit/threads/${threadId}/messages`)).json();
  // The runtime accepts any string id; an unclaimed run would skip the owner check and take the
  // idle thread. Both requests must be refused before the runtime runs anything.
  for (const runId of ["", "x".repeat(300)]) {
    const response = await send(
      "POST",
      "/api/copilotkit/agent/default/run",
      runInput(threadId, [userMessage(`Injected by B ${runId.length}`)], runId),
      otherToken,
    );
    assert.equal(response.status, 400, `runId of ${runId.length} characters`);
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/event-stream/);
  }
  assert.equal(await chat.runner.isRunning({ threadId }), false);
  const after = await (await get(`/api/copilotkit/threads/${threadId}/messages`)).json();
  assert.deepEqual(after, before);
  assert.doesNotMatch(JSON.stringify(after), /Injected by B/);
  // The owner's own run with such an id is refused the same way, and the thread stays usable.
  const own = await send(
    "POST",
    "/api/copilotkit/agent/default/run",
    runInput(threadId, [userMessage("Hi")], ""),
  );
  assert.equal(own.status, 400);
  await runTurn(threadId, [userMessage("Show my calendar again")]);
});

test("a run the runtime refuses releases its claim", async () => {
  const threadId = randomUUID();
  const unknownAgent = await send(
    "POST",
    "/api/copilotkit/agent/nope/run",
    runInput(threadId, [userMessage("Hi")]),
  );
  assert.equal(unknownAgent.status, 404);
  assert.equal(await chat.runner.isRunning({ threadId }), false);
  const invalid = await send("POST", "/api/copilotkit/agent/default/run", {
    ...runInput(threadId),
    messages: "not a list",
  });
  assert.notEqual(invalid.status, 200);
  assert.equal(await chat.runner.isRunning({ threadId }), false);
  await runTurn(threadId, [userMessage("Show my calendar")]);
  const stop = await send("POST", `/api/copilotkit/agent/default/stop/${threadId}`, {});
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).stopped, false);
});

test("the thread menu paginates, renames, archives, restores and deletes", async () => {
  const created: string[] = [];
  for (let index = 0; index < 3; index++) {
    const threadId = randomUUID();
    await runTurn(threadId, [userMessage("Show my calendar")]);
    created.push(threadId);
  }
  const listed = await listAll();
  assert.equal(new Set(listed.ids).size, listed.ids.length);
  // Newest first: the three new threads lead the list in reverse creation order.
  assert.deepEqual(listed.ids.slice(0, 3), [...created].reverse());
  const [oldest, middle, newest] = created as [string, string, string];

  const renamed = await send("PATCH", `/api/copilotkit/threads/${newest}`, {
    agentId: "default",
    name: "Weekend plans",
    userId: "other",
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "Weekend plans");

  const archived = await send("POST", `/api/copilotkit/threads/${middle}/archive`, {
    agentId: "default",
  });
  assert.deepEqual(await archived.json(), { threadId: middle, archived: true });
  assert.equal((await listAll()).ids.includes(middle), false);
  const withArchived = await listAll("&includeArchived=true");
  assert.equal(withArchived.records.find((thread) => thread.id === middle)?.archived, true);

  const restored = await send("PATCH", `/api/copilotkit/threads/${middle}`, {
    agentId: "default",
    archived: false,
  });
  assert.equal((await restored.json()).archived, false);
  assert.ok((await listAll()).ids.includes(middle));

  const deleted = await send("DELETE", `/api/copilotkit/threads/${oldest}`, { agentId: "default" });
  assert.deepEqual(await deleted.json(), { threadId: oldest, deleted: true });
  assert.equal((await get(`/api/copilotkit/threads/${oldest}/messages`)).status, 404);
  assert.equal((await listAll("&includeArchived=true")).ids.includes(oldest), false);
  assert.equal(
    (await get("/api/copilotkit/threads?agentId=default&cursor=not-a-cursor")).status,
    400,
  );
  assert.equal((await get("/api/copilotkit/threads")).status, 400);
});

test("local mode made no Intelligence calls and no requests to a CopilotKit cloud host", () => {
  assert.deepEqual(intelligenceCalls, []);
  assert.deepEqual(cloudFetches, []);
});
