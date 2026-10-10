import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/client";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ChatStore, CursorError } from "../apps/server/src/standalone/chat-store.ts";
import {
  messageIdsOf,
  messagesFromEvents,
  persistedRunEvents,
  stateFromEvents,
  toWireMessages,
} from "../apps/server/src/standalone/events.ts";

let db: Store;
let chats: ChatStore;

before(async () => {
  db = await createStore();
  chats = await ChatStore.open(db);
});

after(async () => {
  await db.close();
});

const ev = (event: Record<string, unknown>) => event as unknown as BaseEvent;

/** Begins and closes a run directly through the store, like the runner does. */
async function storeRun(
  threadId: string,
  runId: string,
  text: string,
  options: { userText?: string } = {},
) {
  const newMessages = options.userText
    ? [{ id: `${runId}-user`, role: "user" as const, content: options.userText }]
    : [];
  const started = persistedRunEvents([], { threadId, runId, newMessages })[0] as BaseEvent;
  const begun = await chats.beginRun({
    threadId,
    runId,
    instanceId: "test",
    started,
    staleAfterMs: 30_000,
  });
  assert.equal(begun.status, "begun");
  const events = persistedRunEvents(
    [
      ev({ type: EventType.RUN_STARTED, threadId, runId }),
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: `${runId}-a`, role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: `${runId}-a`, delta: text }),
      ev({ type: EventType.TEXT_MESSAGE_END, messageId: `${runId}-a` }),
      ev({ type: EventType.STATE_SNAPSHOT, snapshot: { lastRun: runId } }),
      ev({ type: EventType.RUN_FINISHED, threadId, runId }),
    ],
    { threadId, runId, newMessages },
  );
  const closed = await chats.closeRun({
    threadId,
    runId,
    status: "finished",
    events,
    messageIds: messageIdsOf(events),
  });
  assert.deepEqual(closed, { closed: true, released: true });
}

test("open is idempotent and creates the chat tables", async () => {
  const again = await ChatStore.open(db);
  assert.ok(again);
  const tables = await db.sql<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_name LIKE 'chat_%' ORDER BY 1",
  );
  assert.deepEqual(
    tables.map((row) => row.name),
    ["chat_events", "chat_runs", "chat_threads"],
  );
});

test("ensureThread creates once and refuses another owner's id", async () => {
  assert.equal(await chats.ensureThread("alice", "ensure-1", "default"), "ok");
  assert.equal(await chats.ensureThread("alice", "ensure-1", "default"), "ok");
  assert.equal(await chats.ensureThread("bob", "ensure-1", "default"), "forbidden");
  assert.equal(await chats.threadOwner("ensure-1"), "alice");
  assert.equal(await chats.threadOwner("ensure-missing"), null);
});

test("listThreads: ran threads only, newest first, paginated, owner and agent scoped", async () => {
  const owner = "lister";
  await chats.ensureThread(owner, "list-never-ran", "default");
  for (const id of ["list-a", "list-b", "list-c", "list-d", "list-e"]) {
    await chats.ensureThread(owner, id, "default");
    await storeRun(id, `${id}-run`, "hi");
  }
  await chats.ensureThread(owner, "list-other-agent", "helper");
  await storeRun("list-other-agent", "list-other-agent-run", "hi");
  await chats.ensureThread("someone-else", "list-foreign", "default");
  await storeRun("list-foreign", "list-foreign-run", "hi");
  // A new run on list-b moves it to the top.
  await storeRun("list-b", "list-b-run-2", "again");

  const all = await chats.listThreads(owner, { agentId: "default" });
  assert.deepEqual(
    all.threads.map((thread) => thread.id),
    ["list-b", "list-e", "list-d", "list-c", "list-a"],
  );
  assert.equal(all.nextCursor, null);
  const first = all.threads[0];
  assert.ok(first);
  assert.equal(first.agentId, "default");
  assert.equal(first.organizationId, "");
  assert.equal(first.createdById, "");
  assert.equal(first.name, null);
  assert.equal(first.archived, false);
  assert.match(first.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.match(first.lastRunAt ?? "", /^\d{4}-\d{2}-\d{2}T.*Z$/);

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await chats.listThreads(owner, { agentId: "default", limit: 2, cursor });
    seen.push(...result.threads.map((thread) => thread.id));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  assert.deepEqual(seen, ["list-b", "list-e", "list-d", "list-c", "list-a"]);

  const helper = await chats.listThreads(owner, { agentId: "helper" });
  assert.deepEqual(
    helper.threads.map((thread) => thread.id),
    ["list-other-agent"],
  );
  const foreign = await chats.listThreads("someone-else", { agentId: "default" });
  assert.deepEqual(
    foreign.threads.map((thread) => thread.id),
    ["list-foreign"],
  );
});

test("listThreads rejects bad cursors with CursorError", async () => {
  for (const cursor of [
    "%%%",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ k: "yesterday", id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ k: "2026-13-45 99:00:00+00", id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ k: "2026-01-01 00:00:00+00" })).toString("base64url"),
  ]) {
    await assert.rejects(
      chats.listThreads("lister", { agentId: "default", cursor }),
      (error: Error) => error instanceof CursorError && error.name === "CursorError",
      cursor,
    );
  }
});

test("updateThread renames, archives and unarchives; listing honours includeArchived", async () => {
  const owner = "updater";
  await chats.ensureThread(owner, "upd-1", "default");
  await storeRun("upd-1", "upd-1-run", "hello");
  const renamed = await chats.updateThread(owner, "upd-1", "default", { name: "Trip plans" });
  assert.equal(renamed?.name, "Trip plans");
  assert.equal(renamed?.archived, false);
  const archived = await chats.updateThread(owner, "upd-1", "default", { archived: true });
  assert.equal(archived?.archived, true);
  assert.equal(archived?.name, "Trip plans");
  assert.deepEqual((await chats.listThreads(owner, { agentId: "default" })).threads, []);
  const withArchived = await chats.listThreads(owner, {
    agentId: "default",
    includeArchived: true,
  });
  assert.deepEqual(
    withArchived.threads.map((thread) => [thread.id, thread.archived]),
    [["upd-1", true]],
  );
  const restored = await chats.updateThread(owner, "upd-1", "default", { archived: false });
  assert.equal(restored?.archived, false);
  assert.equal((await chats.listThreads(owner, { agentId: "default" })).threads.length, 1);

  assert.equal(await chats.updateThread("intruder", "upd-1", "default", { name: "x" }), null);
  assert.equal(await chats.updateThread(owner, "upd-1", "other-agent", { name: "x" }), null);
  assert.equal(await chats.updateThread(owner, "upd-missing", "default", { name: "x" }), null);
  assert.equal((await chats.updateThread(owner, "upd-1", "default", {}))?.name, "Trip plans");
});

test("deleteThread cascades runs and journal, refuses while running, scopes by owner", async () => {
  const owner = "deleter";
  await chats.ensureThread(owner, "del-1", "default");
  await storeRun("del-1", "del-1-run", "bye");
  assert.equal(await chats.deleteThread("intruder", "del-1", "default"), "not_found");
  assert.equal(await chats.deleteThread(owner, "del-1", "other-agent"), "not_found");

  // While a run holds the lock the thread cannot be deleted.
  const begun = await chats.beginRun({
    threadId: "del-1",
    runId: "del-1-live",
    instanceId: "test",
    started: persistedRunEvents([], {
      threadId: "del-1",
      runId: "del-1-live",
      newMessages: [],
    })[0] as BaseEvent,
    staleAfterMs: 30_000,
  });
  assert.equal(begun.status, "begun");
  await chats.appendJournal("del-1-live", 0, [
    ev({ type: EventType.RUN_STARTED, threadId: "del-1", runId: "del-1-live" }),
  ]);
  assert.equal(await chats.deleteThread(owner, "del-1", "default"), "running");

  await chats.closeRun({
    threadId: "del-1",
    runId: "del-1-live",
    status: "finished",
    events: [],
    messageIds: [],
  });
  assert.equal(await chats.deleteThread(owner, "del-1", "default"), "deleted");
  assert.equal(await chats.deleteThread(owner, "del-1", "default"), "not_found");
  const leftovers = await db.sql<{ runs: number; journal: number }>(
    `SELECT (SELECT count(*) FROM chat_runs WHERE thread_id='del-1')::int AS runs,
      (SELECT count(*) FROM chat_events WHERE run_id IN ('del-1-run','del-1-live'))::int AS journal`,
  );
  assert.deepEqual(leftovers[0], { runs: 0, journal: 0 });
});

test("deleteThread cascades a running run's journal rows", async () => {
  await chats.ensureThread("cascade", "del-2", "default");
  await chats.beginRun({
    threadId: "del-2",
    runId: "del-2-live",
    instanceId: "test",
    started: persistedRunEvents([], {
      threadId: "del-2",
      runId: "del-2-live",
      newMessages: [],
    })[0] as BaseEvent,
    staleAfterMs: 30_000,
  });
  await chats.appendJournal("del-2-live", 0, [
    ev({ type: EventType.RUN_STARTED, threadId: "del-2", runId: "del-2-live" }),
  ]);
  // Forced release (as if the lock were cleared) lets the row go; its run and journal cascade.
  await db.sql("UPDATE chat_threads SET run_id=NULL WHERE id='del-2'");
  assert.equal(await chats.deleteThread("cascade", "del-2", "default"), "deleted");
  const rows = await db.sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM chat_events WHERE run_id='del-2-live'",
  );
  assert.equal(rows[0]?.n, 0);
});

test("threadEvents is owner scoped and compacts closed runs into messages and state", async () => {
  const owner = "reader";
  await chats.ensureThread(owner, "read-1", "default");
  await storeRun("read-1", "read-1-r1", "Hello", { userText: "Hi" });
  await storeRun("read-1", "read-1-r2", "Again", { userText: "More" });
  assert.equal(await chats.threadEvents("intruder", "read-1"), null);
  assert.equal(await chats.threadEvents(owner, "read-missing"), null);
  const events = await chats.threadEvents(owner, "read-1");
  assert.ok(events);
  assert.deepEqual(events.filter((event) => event.type === EventType.RUN_STARTED).length, 2);
  const messages = toWireMessages(messagesFromEvents(events));
  assert.deepEqual(messages, [
    { id: "read-1-r1-user", role: "user", content: "Hi" },
    { id: "read-1-r1-a", role: "assistant", content: "Hello" },
    { id: "read-1-r2-user", role: "user", content: "More" },
    { id: "read-1-r2-a", role: "assistant", content: "Again" },
  ]);
  assert.deepEqual(stateFromEvents(events), { lastRun: "read-1-r2" });
  // A thread that never ran has no events.
  await chats.ensureThread(owner, "read-empty", "default");
  assert.deepEqual(await chats.threadEvents(owner, "read-empty"), []);
});

test("claim, begin and release statements guard the lock", async () => {
  const claim = (owner: string, runId: string) =>
    chats.claimRun({
      owner,
      threadId: "lock-1",
      agentId: "default",
      runId,
      instanceId: "test",
      staleAfterMs: 30_000,
    });
  assert.equal((await claim("locker", "r1")).claimed, true);
  const busy = await claim("locker", "r2");
  assert.equal(busy.claimed, false);
  assert.equal(busy.holder, "r1");
  assert.equal(busy.stale, false);
  const foreign = await claim("intruder", "r3");
  assert.equal(foreign.claimed, false);
  assert.equal(foreign.owner, "locker");
  assert.equal(await chats.isLocked("lock-1"), true);
  assert.equal(await chats.releaseClaim("lock-1", "r2"), false);
  assert.equal(await chats.releaseClaim("lock-1", "r1"), true);
  assert.equal(await chats.isLocked("lock-1"), false);
  assert.equal(await chats.isLocked("lock-missing"), false);
});

test("releasing a claim deletes a thread row that never ran; ran, named or archived rows stay", async () => {
  const claim = (threadId: string, runId: string) =>
    chats.claimRun({
      owner: "keeper",
      threadId,
      agentId: "default",
      runId,
      instanceId: "test",
      staleAfterMs: 30_000,
    });
  // A refused first run (unknown agent, invalid body) leaves no row behind.
  assert.equal((await claim("rel-new", "n1")).claimed, true);
  assert.equal(await chats.releaseClaim("rel-new", "n1"), true);
  assert.equal(await chats.threadOwner("rel-new"), null);
  // A thread that has run keeps its row and history; only the lock is released.
  await chats.ensureThread("keeper", "rel-ran", "default");
  await storeRun("rel-ran", "ran-1", "kept");
  assert.equal((await claim("rel-ran", "ran-2")).claimed, true);
  assert.equal(await chats.releaseClaim("rel-ran", "ran-2"), true);
  assert.equal(await chats.threadOwner("rel-ran"), "keeper");
  assert.equal(await chats.isLocked("rel-ran"), false);
  assert.equal((await chats.historicMessageIds("rel-ran")).length > 0, true);
  // A renamed or archived thread that has not run yet keeps its row.
  for (const [id, patch] of [
    ["rel-named", { name: "Plans" }],
    ["rel-archived", { archived: true }],
  ] as const) {
    await chats.ensureThread("keeper", id, "default");
    await chats.updateThread("keeper", id, "default", patch);
    assert.equal((await claim(id, `${id}-run`)).claimed, true);
    assert.equal(await chats.releaseClaim(id, `${id}-run`), true);
    assert.equal(await chats.threadOwner(id), "keeper");
    assert.equal(await chats.isLocked(id), false);
  }
  // A release for another run id changes nothing.
  assert.equal((await claim("rel-other", "o1")).claimed, true);
  assert.equal(await chats.releaseClaim("rel-other", "o2"), false);
  assert.equal(await chats.isLocked("rel-other"), true);
  assert.equal(await chats.releaseClaim("rel-other", "o1"), true);
});
