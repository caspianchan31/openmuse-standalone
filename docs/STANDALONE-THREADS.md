# Self-hosted chat threads (local mode)

OpenMuse stores conversations on its own server unless you connect CopilotKit Intelligence. In this **local mode**, OpenMuse runs entirely on your own server: conversations live in the API's own Postgres database (embedded PGlite by default, or `DATABASE_URL`), and no third-party chat cloud is used.

The mode follows one setting. Nothing else selects it.

| `CPK_INTELLIGENCE_API_KEY` | Chat threads | CopilotKit runtime | `/api/copilotkit/info` `mode` |
|---|---|---|---|
| unset or blank | **Local mode**: this server's database (`chat_*` tables) | SSE mode with OpenMuse's own persistent runner | `sse` |
| set | CopilotKit Intelligence, exactly as upstream OpenMuse | Intelligence mode, `identifyUser` from the OpenMuse session | `intelligence` |

A wrong key is not a fallback: with any non-blank key the API uses Intelligence and reports its errors. History does not move between modes. Threads saved locally stay in this database; threads saved in Intelligence stay there.

`GET /api/workspace` reports the mode as `runtime.threads` (`"local"` or `"intelligence"`). `runtime.richThreads` is `true` in both modes, so the app uses the same thread menu, main conversation and replay either way. Settings shows **Rich Threads: This server** in local mode.

## Configuration

```dotenv
# Leave unset (or blank) for local mode.
# CPK_INTELLIGENCE_API_KEY=
# Optional: delete finished replies older than this many days. Unset keeps history forever.
# CHAT_RETENTION_DAYS=90
```

`CHAT_RETENTION_DAYS` must be a positive whole number; the API refuses to start otherwise. It has no effect in Intelligence mode.

For production, point `DATABASE_URL` at Postgres and back it up like any other application data. With embedded PGlite, conversations are in `DATA_DIR/postgres` next to the rest of OpenMuse's data; a host without a persistent disk loses them on redeploy.

## What each mode provides

| Capability | Local mode | Intelligence |
|---|---|---|
| Main conversation with a stable server-issued id | Yes | Yes |
| Side chats persisted on their first run | Yes | Yes |
| Thread menu: list, paginate, rename, archive, restore | Yes (`/api/copilotkit/threads*`, served by OpenMuse) | Yes (runtime + Intelligence) |
| Delete a thread | Yes, refused with 409 while it is replying | Yes |
| Reload replays the conversation | Yes (`connectAgent` replays saved runs) | Yes |
| Reload during a reply resumes the reply | Yes, when the reply runs in the same API process | Yes |
| A second send while a reply runs | 409 `agent_thread_locked`, the app holds the queued message | `AgentThreadLockedError`, same handling |
| Stop | Yes; the stopped reply is saved | Yes |
| Thread list refreshes live on other devices | No: the menu refetches each time it opens | Yes (realtime metadata) |
| Live tail of a reply running in another API process | No: a reload there shows the reply's progress so far, then ends | Yes |
| Automatic thread names | No (off in both modes) | No |
| Memories | No | Not enabled by OpenMuse |

Run one API process (the existing guidance for OpenMuse). A separate task worker can share the same Postgres; it never serves chat.

## How it works

Without a key, `createApp` builds the standalone chat layer in `apps/server/src/standalone/`:

- `LocalAgentRunner` is the CopilotKit `AgentRunner` the runtime uses in SSE mode. It implements only the asynchronous `run`, `connect`, `isRunning` and `stop`, backed by the database, so nothing is held only in memory.
- Runtime hooks run after the runtime's own route matching, so they apply to every path the runtime serves:
  - **run**: before any SSE byte, the thread is claimed for the session owner. A thread that is already replying answers `409 {"error": "...", "code": "agent_thread_locked"}`; a thread that belongs to another owner answers `404`. If the runtime then answers anything other than `200` (bad body, unknown agent), the claim is released.
  - **connect** and **stop**: another owner's thread answers `404`.
  - **info**: `threadEndpoints` is rewritten to `{ list, inspect, mutations: true, realtimeMetadata: false }`, so the app uses the local thread routes and opens no realtime socket.
  - The runtime's debug event stream (`cpk-debug-events`) answers `404`, because it would carry every owner's events.
  - If the database fails during these checks, the request answers `503 {"error": "Chat history is unavailable right now. Try again."}` before any SSE byte, and nothing is claimed.
- `GET /api/main-thread` records the owner's main thread in the local database instead of calling Intelligence.

Hono routes serve the thread menu before the runtime handler, behind the normal session check:

| Route | Response |
|---|---|
| `GET /api/copilotkit/threads?agentId=…[&includeArchived=true][&limit=1-100][&cursor=…]` | `{ threads, nextCursor }`, newest first, only threads that have run |
| `GET /api/copilotkit/threads/:id/messages` | `{ messages }` in the runtime's message shape |
| `GET /api/copilotkit/threads/:id/events` | `{ events }`, the saved runs' compacted AG-UI events |
| `GET /api/copilotkit/threads/:id/state` | `{ state }`, the last state snapshot or `null` |
| `PATCH /api/copilotkit/threads/:id` `{ agentId, name?, archived? }` | the updated thread (rename, restore) |
| `POST /api/copilotkit/threads/:id/archive` `{ agentId }` | `{ threadId, archived: true }` |
| `DELETE /api/copilotkit/threads/:id` `{ agentId }` | `{ threadId, deleted: true }`, or 409 while replying |

Invalid input is `400`; a missing thread, another owner's thread or a different `agentId` is `404`. `POST /threads/subscribe` (realtime) and memories are not served locally; `POST /threads/clear` is a no-op.

## Database

`ChatStore.open` creates three tables if they do not exist (PGlite and Postgres). Every change that touches several rows is a single SQL statement.

| Table | Holds |
|---|---|
| `chat_threads` | One row per thread: owner, agent, name, archived flag, timestamps, and the run lock (`run_id`, the process holding it, its heartbeat, a stop request) |
| `chat_runs` | One row per reply: thread, order, status (`running`, `finished`, `error`, `stopped`, `interrupted`) and, once closed, its compacted AG-UI events and message ids |
| `chat_events` | A journal of the events of replies that are still running, so a crash loses nothing that was streamed |

Each saved run starts with `RUN_STARTED` carrying only the messages that were new to the thread. Tools, context, state and forwarded properties sent by the app are not stored (tools and context are saved as empty lists, which the client requires on replay). Every saved `RUN_FINISHED` carries its thread and run ids.

## Durability and recovery

- The final `RUN_FINISHED` or `RUN_ERROR` is sent to the app only after the reply is saved. If saving fails after retries, the stream ends with `RUN_ERROR` code `persistence_failed` ("This reply could not be saved…"), and the journal is recovered once the database is reachable again.
- A failure after the stream started ends it with `RUN_ERROR`; it never hangs. Closing the browser tab does not stop the reply; reopening the conversation resumes it.
- The process holding a reply refreshes its lock every 5 seconds. A lock without a heartbeat for 30 seconds is recovered by a sweep (every 15 seconds and at startup): the journal is saved as an `interrupted` reply with the message "The server stopped before this reply finished." and the thread is unlocked.
- On `SIGINT`/`SIGTERM` the API saves replies in progress as interrupted ("The server is restarting."), ends their streams, then closes.

## Retention

History is kept until you delete a thread. With `CHAT_RETENTION_DAYS=N`, the sweep deletes finished replies older than N days; replies in progress are never touched. Thread rows and names stay, so an old thread can appear in the menu with an empty history. Deleting a thread removes its replies and journal. Nothing is evicted by count or size.

## Owner isolation

Every thread belongs to the owner whose session first created it. Thread ids are global: an id held by another owner is answered exactly like a missing thread (`404`), on the thread routes and on run, connect and stop, and a refused run takes no lock. Owner fields in requests (`userId` and similar) are ignored; the owner always comes from the verified session.

The default deployment is still a single-owner workspace protected by one access key (see the [README](../README.md)); per-owner isolation keeps thread data correct if more owners are added later.

## Validation

- `tests/standalone-routes.test.ts`: runtime hooks and thread routes against in-memory stores, and the hooks inside the real CopilotKit runtime handler.
- `tests/standalone-api.test.ts`: keyless `createApp` through the real runtime HTTP path with the sample agent: no Intelligence calls, main thread, SSE runs, listing, messages, replay, 409 before SSE, owner isolation, claim release, pagination and mutations.
- `tests/standalone-client.test.ts`: the app's CopilotKit Core client against a keyless API served by `@hono/node-server` over real HTTP: an SSE run, replay after a reload through `connectAgent` (the client validates every replayed event), and a send on a busy thread surfacing as the thread lock the app holds.
- `tests/standalone-runner.test.ts` and `tests/standalone-chat-store.test.ts`: persistence, replay after restart, durability boundary, concurrency, stop, crash recovery and retention.
- `tests/rich-threads.test.ts` keeps covering Intelligence mode unchanged.
