// Standalone: a keyless app whose agent is a remote AG-UI server (AGENT_BACKEND=agui), through the
// real createApp and runtime HTTP path. A run whose STATE_DELTA patches only apply to the state it
// began with, or to no state at all, must still finish, save and free its thread: the agent and the
// client only warn about a patch they cannot apply.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { createApp } from "../apps/server/src/app.ts";
import type { Store } from "../apps/server/src/db.ts";
import type { StandaloneChat } from "../apps/server/src/standalone/index.ts";
import { createChatTestStore } from "./helpers/chat-database.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let chat: StandaloneChat;
let agentServer: Server | undefined;
/** The STATE_DELTA patches the remote agent sends in each run. */
let patches: unknown[][] = [];

const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const get = (path: string) => app.request(path, { headers: headers() });
const send = (method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: headers(), body: JSON.stringify(body) });

function sseEvents(text: string): BaseEvent[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent);
}

/** One turn over SSE with the state the app sends; its events once the stream has ended. */
async function runTurn(threadId: string, state: Record<string, unknown>) {
  const response = await send("POST", "/api/copilotkit/agent/default/run", {
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "Count" }],
    tools: [],
    context: [],
    state,
    forwardedProps: {},
  });
  assert.equal(response.status, 200, await response.clone().text());
  return sseEvents(await response.text());
}

const stateOf = async (threadId: string) =>
  (await (await get(`/api/copilotkit/threads/${threadId}/state`)).json()).state;

before(async () => {
  // A minimal AG-UI agent server: RUN_STARTED, the configured patches, RUN_FINISHED.
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const input = JSON.parse(body) as { threadId: string; runId: string };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const write = (event: Record<string, unknown>) =>
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      write({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
      for (const delta of patches) write({ type: EventType.STATE_DELTA, delta });
      write({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
      response.end();
    });
  });
  agentServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  directory = await mkdtemp(join(tmpdir(), "openmuse-standalone-agui-"));
  db = await createChatTestStore();
  const created = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "agui",
    agentUrl: `http://127.0.0.1:${port}/agent`,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  });
  assert.ok(created.chat, "a keyless app runs local chat");
  app = created.app;
  chat = created.chat;
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});

after(async () => {
  await chat?.close();
  await db?.close();
  if (agentServer) await new Promise<void>((resolve) => agentServer?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("runs with state patches the compaction cannot replay from {} finish and free the thread", async (t) => {
  t.mock.method(console, "warn", () => {}); // the agent warns about the patch it cannot apply
  const threadId = randomUUID();

  // Valid against the state the run began with, not against {}.
  patches = [[{ op: "replace", path: "/count", value: 2 }]];
  const first = await runTurn(threadId, { count: 1, kept: true });
  assert.deepEqual(
    first.map((event) => event.type),
    [EventType.RUN_STARTED, EventType.STATE_DELTA, EventType.RUN_FINISHED],
  );
  assert.deepEqual(await stateOf(threadId), { count: 2, kept: true });

  // The thread is free for the next send. A patch that applies to no state is dropped.
  patches = [
    [{ op: "replace", path: "/missing", value: 1 }],
    [{ op: "add", path: "/added", value: true }],
  ];
  const second = await runTurn(threadId, { count: 2, kept: true });
  assert.equal(second.at(-1)?.type, EventType.RUN_FINISHED);
  assert.deepEqual(await stateOf(threadId), { count: 2, kept: true, added: true });

  // A reload replays both runs and ends; the thread can be deleted; shutdown has nothing to wait for.
  const connect = await send("POST", "/api/copilotkit/agent/default/connect", {
    threadId,
    runId: randomUUID(),
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
  assert.equal(connect.status, 200);
  const replay = sseEvents(await connect.text());
  assert.equal(replay.filter((event) => event.type === EventType.RUN_STARTED).length, 2);
  assert.equal(replay.at(-1)?.type, EventType.RUN_FINISHED);
  const deleting = await send("DELETE", `/api/copilotkit/threads/${threadId}`, {
    agentId: "default",
  });
  assert.equal(deleting.status, 200, await deleting.clone().text());
  assert.equal(await chat.runner.isRunning({ threadId }), false);
  const closing = Date.now();
  await chat.close();
  assert.ok(Date.now() - closing < 1000, "close() has no run left to wait for");
});
