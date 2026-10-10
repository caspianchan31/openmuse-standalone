// Standalone: the app's CopilotKit client (CopilotKitCore, configured as App.tsx configures it)
// against a keyless OpenMuse API over real HTTP: an SSE run, replay after a reload through
// connectAgent (the client validates every replayed event), and the busy-thread 409.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { CopilotKitCore, CopilotKitCoreRuntimeConnectionStatus } from "@copilotkit/core";
import { type ServerType, serve } from "@hono/node-server";
import { Observable, toArray } from "rxjs";
import {
  ConversationTurnError,
  replayedRunError,
  runConversationTurn,
  threadLocked,
} from "../apps/mobile/src/conversation-run.ts";
import { connectThread } from "../apps/mobile/src/local-thread.ts";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { StandaloneChat } from "../apps/server/src/standalone/index.ts";

let db: Store, directory: string, token: string, runtimeUrl: string;
let server: ServerType;
let chat: StandaloneChat;
const cores: CopilotKitCore[] = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-standalone-client-"));
  db = await createStore();
  const created = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  });
  assert.ok(created.chat, "a keyless app runs local chat");
  chat = created.chat;
  server = serve({ fetch: created.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  runtimeUrl = `http://127.0.0.1:${port}/api/copilotkit`;
  const session = await created.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
  // React Native defines `window` as the global object, and CopilotKitCore only opens its runtime
  // connection when `window` exists. Set it once the server side (PGlite checks it) has started.
  (globalThis as { window?: unknown }).window ??= globalThis;
});

after(async () => {
  // Without a runtime URL a client stops reconnecting to the server that is going away.
  for (const core of cores) core.setRuntimeUrl(undefined);
  await chat?.close();
  if (server) {
    // Clients keep connections alive; close them so the server can stop.
    (server as import("node:http").Server).closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** A client as the app builds one after sign-in (a reload builds a new one). */
async function client(threadId: string) {
  const core = new CopilotKitCore({ runtimeUrl, headers: { Authorization: `Bearer ${token}` } });
  cores.push(core);
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (core.runtimeConnectionStatus === CopilotKitCoreRuntimeConnectionStatus.Connected)
        resolve();
      else if (core.runtimeConnectionStatus === CopilotKitCoreRuntimeConnectionStatus.Error)
        reject(new Error("runtime /info failed"));
    };
    core.subscribe({ onRuntimeConnectionStatusChanged: check });
    check();
  });
  const agent = core.getAgent("default");
  assert.ok(agent, "the runtime advertises the default agent");
  agent.threadId = threadId;
  const errors: string[] = [];
  core.subscribe({
    onError: ({ code }) => {
      errors.push(code);
    },
  });
  const turn = (action: () => Promise<unknown>, ignore?: string[]) =>
    runConversationTurn("default", action, (onError) => core.subscribe({ onError }), ignore);
  return { core, agent, errors, turn };
}

test("the app client runs over SSE, then a reload replays the saved conversation", async () => {
  const threadId = randomUUID();
  const first = await client(threadId);
  first.agent.addMessage({ id: randomUUID(), role: "user", content: "Show my calendar" });
  await first.turn(() => first.core.runAgent({ agent: first.agent }));
  assert.deepEqual(first.errors, []);
  const sent = first.agent.messages.map((message) => message.id);
  assert.ok(
    first.agent.messages.some(
      (message) =>
        message.role === "assistant" && /Your local calendar has/.test(String(message.content)),
    ),
  );

  // A reload: a new client hydrates the thread with connectAgent, as chat.tsx does.
  const reloaded = await client(threadId);
  await reloaded.turn(
    () => reloaded.core.connectAgent({ agent: reloaded.agent }),
    [replayedRunError],
  );
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual(
    reloaded.agent.messages.map((message) => message.id),
    sent,
  );

  // The next turn on the reloaded client resends its history; nothing is stored twice.
  reloaded.agent.addMessage({ id: randomUUID(), role: "user", content: "Show my calendar again" });
  await reloaded.turn(() => reloaded.core.runAgent({ agent: reloaded.agent }));
  const again = await client(threadId);
  await again.turn(() => again.core.connectAgent({ agent: again.agent }), [replayedRunError]);
  const ids = again.agent.messages.map((message) => message.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    ids,
    reloaded.agent.messages.map((message) => message.id),
  );
});

test("a send on a busy thread is refused as a thread lock the app holds", async (t) => {
  t.mock.method(console, "error", () => {}); // CopilotKit logs the refused run
  const threadId = randomUUID();
  assert.deepEqual(
    await chat.runner.claim({ owner: "local-user", threadId, agentId: "default", runId: "held" }),
    { ok: true },
  );
  const { core, agent } = await client(threadId);
  agent.addMessage({ id: randomUUID(), role: "user", content: "Hello" });
  await assert.rejects(
    runConversationTurn(
      "default",
      () => core.runAgent({ agent }),
      (onError) => core.subscribe({ onError }),
    ),
    (error: unknown) => error instanceof ConversationTurnError && error.code === threadLocked,
  );
  await chat.runner.release(threadId, "held");
  assert.equal(await chat.runner.isRunning({ threadId }), false);
});

const assistantText = (messages: Message[]) =>
  messages
    .filter((message) => message.role === "assistant")
    .map((message) => String(message.content ?? ""));

test("connecting again to a loaded thread (Retry, reopening it) does not double its messages", async () => {
  const threadId = randomUUID();
  const first = await client(threadId);
  first.agent.addMessage({ id: randomUUID(), role: "user", content: "Show my calendar" });
  await first.turn(() => first.core.runAgent({ agent: first.agent }));
  const sent = first.agent.messages.map((message) => message.id);
  const replies = assistantText(first.agent.messages);
  assert.ok(replies.some((text) => /Your local calendar has/.test(text)));

  const reloaded = await client(threadId);
  for (let attempt = 0; attempt < 2; attempt++) {
    await reloaded.turn(
      () => connectThread(reloaded.core, reloaded.agent, true),
      [replayedRunError],
    );
    assert.deepEqual(
      reloaded.agent.messages.map((message) => message.id),
      sent,
      `connect ${attempt + 1}`,
    );
    assert.deepEqual(assistantText(reloaded.agent.messages), replies, `connect ${attempt + 1}`);
  }
  assert.deepEqual(reloaded.errors, []);
});

/** An agent whose model fails after part of a reply. */
class FailingAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "failed-reply",
        role: "assistant",
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "failed-reply",
        delta: "Partial",
      } as BaseEvent);
      const failing = setTimeout(() => subscriber.error(new Error("model unavailable")), 10);
      return () => clearTimeout(failing);
    });
  }
}

test("a reload replays a failed turn without reporting its old error again", async (t) => {
  t.mock.method(console, "error", () => {}); // the server logs the failed run
  const threadId = randomUUID();
  assert.deepEqual(
    await chat.runner.claim({ owner: "local-user", threadId, agentId: "default", runId: "failed" }),
    { ok: true },
  );
  const agent = new FailingAgent({ agentId: "default" });
  const input: RunAgentInput = {
    threadId,
    runId: "failed",
    messages: [{ id: "failed-question", role: "user", content: "Hi" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  agent.setMessages(input.messages);
  agent.threadId = threadId;
  const live = await new Promise<BaseEvent[]>((resolve, reject) => {
    chat.runner
      .run({ threadId, agent, input })
      .pipe(toArray())
      .subscribe({ next: resolve, error: reject });
  });
  assert.equal(live.at(-1)?.type, EventType.RUN_ERROR);

  const reloaded = await client(threadId);
  // No ignore list: a replayed RUN_ERROR would fail this turn and log a console error.
  await reloaded.turn(() => connectThread(reloaded.core, reloaded.agent, true));
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual(
    reloaded.agent.messages.map((message) => [message.role, message.content]),
    [
      ["user", "Hi"],
      ["assistant", "Partial"],
    ],
  );
});
