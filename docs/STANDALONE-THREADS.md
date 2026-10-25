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

In local mode `CHAT_RETENTION_DAYS` must be a whole number from 1 to 36500 (larger values would overflow Postgres timestamps in the purge); the API refuses to start otherwise. Intelligence mode ignores it.

For production, point `DATABASE_URL` at Postgres and back it up like any other application data ([step-by-step guide](POSTGRES.md)). With embedded PGlite, conversations are in `DATA_DIR/postgres` next to the rest of OpenMuse's data; a host without a persistent disk loses them on redeploy.

## What each mode provides

| Capability | Local mode | Intelligence |
|---|---|---|
| Main conversation with a stable server-issued id | Yes | Yes |
| Side chats persisted on their first run | Yes | Yes |
| Thread menu: list, paginate, rename, archive, restore | Yes (`/api/copilotkit/threads*`, served by OpenMuse) | Yes (runtime + Intelligence) |
| Delete a thread | Yes, refused with 409 while it is replying | Yes |
| Reload replays the conversation | Yes (`connectAgent` replays saved runs) | Yes |
| Reload during a reply resumes the reply | Yes, when the reply runs in the same API process (also one that is just starting) | Yes |
| A second send while a reply runs | 409 `agent_thread_locked` before any SSE; the app holds the queued message, and neither the app nor CopilotKit logs an error. The browser itself still logs the refused request (in Chrome, one console line: "Failed to load resource: the server responded with a status of 409 (Conflict)") | `AgentThreadLockedError`, same handling |
| Stop | Yes; the reply stops streaming at once and what it said so far is saved | Yes |
| Thread list refreshes live on other devices | No: the menu refetches each time it opens | Yes (realtime metadata) |
| Live tail of a reply running in another API process | No: a reload there shows the reply's progress so far, then ends | Yes |
| Automatic thread names | No (off in both modes) | No |
| Memories | No | Not enabled by OpenMuse |

Run one API process (the existing guidance for OpenMuse). A separate task worker can share the same Postgres; it never serves chat.

Known limit: a message the app held because another device was replying is sent later with this device's copy of the conversation, so the model does not see the other device's turn (the saved history is still in the right order and a reload shows it).

## How it works

Without a key, `createApp` builds the standalone chat layer in `apps/server/src/standalone/`:

- `LocalAgentRunner` is the CopilotKit `AgentRunner` the runtime uses in SSE mode. It implements only the asynchronous `run`, `connect`, `isRunning` and `stop`, backed by the database, so nothing is held only in memory.
- Runtime hooks run after the runtime's own route matching, so they apply to every path the runtime serves:
  - **run**: before any SSE byte, the thread is claimed for the session owner. A thread that is already replying answers `409 {"error": "...", "code": "agent_thread_locked"}`; a thread that belongs to another owner answers `404`; a `threadId` or `runId` that is missing, empty or longer than 256 characters answers `400` (the runtime would accept any string and run it without a claim). If the runtime then answers anything other than `200` (bad body, unknown agent), the claim is released, and a thread row that has never run is removed again.
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

Invalid input is `400`; a missing thread, another owner's thread or a different `agentId` is `404`. `POST /threads/subscribe` (realtime) answers `404 {"error": "Realtime thread updates are not available without Intelligence"}`; the app never calls it because `/info` reports `realtimeMetadata: false`. Memories are not served locally; `POST /threads/clear` is a no-op.

## Database

`ChatStore.open` creates three tables if they do not exist (PGlite and Postgres). Every change that touches several rows is a single SQL statement.

| Table | Holds |
|---|---|
| `chat_threads` | One row per thread: owner, agent, name, archived flag, timestamps, and the run lock (`run_id`, the process holding it, its heartbeat, a stop request) |
| `chat_runs` | One row per reply: thread, order, status (`running`, `finished`, `error`, `stopped`, `interrupted`) and, once closed, its compacted AG-UI events and message ids |
| `chat_events` | A journal of the events of replies that are still running, written every 250 ms (or every 64 events), so a crash loses at most the last quarter second of a reply |

Each saved run starts with `RUN_STARTED` carrying only the messages that were new to the thread. Tools, context, state and forwarded properties in that input are not stored (tools and context are saved as empty lists, which the client requires on replay). Every saved `RUN_FINISHED` carries its thread and run ids.

Text Postgres cannot store, NUL characters and unpaired UTF-16 surrogates (a reply cut in the middle of an emoji), is saved with U+FFFD in its place; the live stream is unchanged.

A run's state events are saved as one `STATE_SNAPSHOT` of the state it ended with: the state it began with plus its `STATE_DELTA` patches. A patch that cannot be applied (a path that does not exist) is dropped, as the agent and the app skip it with a warning, so it never keeps a reply from being saved or replayed, or its thread from being freed.

## Replay

`connectAgent` (a reload, or opening a thread) receives the thread's saved replies, compacted, then the reply in progress from its start if this process is running it, until that reply is saved. A connect that arrives just after a send was accepted but before the reply began waits for the reply and follows it.

The saved replies are read in one statement, which also reads the journal of a reply running in another API process, so a reply saved in between is not lost. If a reply begins on the thread in this process while that read runs, the read may not match what the process is running: with `DATABASE_URL` it can answer from a snapshot taken before the reply was saved, or after the reply began in the database but before the process registered it. The connect then waits until the reply is registered and reads again, so the reply is sent once, and followed live while it runs.

If the history cannot be read (the database is unavailable, or replies kept beginning during 10 reads in a row), the connect ends with a single `RUN_ERROR` with code `history_unavailable` ("This conversation could not be loaded. Try again."). The app treats it as a failed load, not as a replayed past failure: it shows "Could not load conversation" with **Retry loading conversation** instead of an empty or partial conversation. A plain stream error would not do this, because the runtime ends the SSE response normally when a runner's stream errors, which the app cannot tell from an empty thread.

A failed or interrupted reply is replayed ending with `RUN_FINISHED` instead of its saved `RUN_ERROR`: the app shows no notice for a past failure after a reload, and replaying the error only made the client report it again (a console error per failed reply on every load). The stored reply keeps its `RUN_ERROR` and status, and `GET /threads/:id/events` returns it as stored.

There is no replay cursor in local mode, so every connect sends the whole thread. The app therefore clears the conversation before each connect when `runtime.threads` is `"local"` (`apps/mobile/src/local-thread.ts`); otherwise a second connect to a loaded thread (Retry after a failed load, or reopening the thread) would append the replay to the messages already shown.

## Durability and recovery

- The final `RUN_FINISHED` or `RUN_ERROR` is sent to the app only after the reply is saved. If saving fails after retries, or in any unexpected way, the stream ends with `RUN_ERROR` code `persistence_failed` ("This reply could not be saved…"), the process stops refreshing the reply's lock, and the journal is recovered by the sweep once the lock is stale and the database is reachable. The stream also ends with `persistence_failed` if another process had already recovered the reply from its journal (its database calls stalled past the heartbeat window), because the saved reply is then the shorter recovered one.
- A failure after the stream started ends it with `RUN_ERROR`; it never hangs. Closing the browser tab does not stop the reply; reopening the conversation resumes it.
- The process holding a reply refreshes its lock every 5 seconds. A lock without a heartbeat for 30 seconds is recovered by a sweep (every 15 seconds): the journal is saved as an `interrupted` reply with the message "The server stopped before this reply finished." and the thread is unlocked.
- At startup with embedded PGlite (no `DATABASE_URL`), no other process can use the database, so every lock left by the previous process is recovered at once. With `DATABASE_URL`, other processes may hold live locks, so a reply cut off by a crash stays locked until its heartbeat is 30 seconds old and is recovered within the next sweep (about 30-45 seconds); meanwhile the app holds new messages for that thread.
- Stop cancels the agent's run: the runner calls `abortRun` and detaches the run, which unsubscribes from the agent's stream (OpenMuse's agent ends its model request when unsubscribed; `abortRun` alone is a no-op for it). The reply so far is saved as `stopped` and the stream ends with `RUN_FINISHED`.
- On `SIGINT`/`SIGTERM` the API cancels replies in progress the same way, saves them as interrupted ("The server is restarting."), ends their streams, then closes. An agent that ignores both is saved after a 5-second cap.

## Retention

History is kept until you delete a thread. With `CHAT_RETENTION_DAYS=N`, the sweep deletes finished replies older than N days; replies in progress are never touched. Thread rows and names stay, so an old thread can appear in the menu with an empty history. Deleting a thread removes its replies and journal. Nothing is evicted by count or size. A thread whose first run the runtime refused (unknown agent, invalid body) leaves no row behind.

## Owner isolation

Every thread belongs to the owner whose session first created it. Thread ids are global: an id held by another owner is answered exactly like a missing thread (`404`), on the thread routes and on run, connect and stop, and a refused run takes no lock. A run is only ever started after the hook has claimed its thread for the session owner: a run whose ids the hook cannot claim answers `400` instead of reaching the runtime. Owner fields in requests (`userId` and similar) are ignored; the owner always comes from the verified session.

The default deployment is still a single-owner workspace protected by one access key (see [Configure the agent and Google](UPSTREAM-README.md#configure-the-agent-and-google)); per-owner isolation keeps thread data correct if more owners are added later.

## Validation

- `tests/standalone-routes.test.ts`: runtime hooks and thread routes against in-memory stores, and the hooks inside the real CopilotKit runtime handler.
- `tests/standalone-api.test.ts`: keyless `createApp` through the real runtime HTTP path with the sample agent: no Intelligence calls, main thread, SSE runs, listing, messages, replay, 409 before SSE, owner isolation, claim release, pagination and mutations.
- `tests/standalone-client.test.ts`: the app's CopilotKit Core client against a keyless API served by `@hono/node-server` over real HTTP: an SSE run, replay after a reload through `connectAgent` (the client validates every replayed event), a second connect that does not double the messages, a history the server cannot read failing the load (then Retry loading it), a failed reply replayed without an error, and a send on a busy thread (409, or a lock found after the stream began) surfacing as the thread lock the app holds, without an error logged by the app or CopilotKit.
- `tests/standalone-agui.test.ts`: keyless `createApp` with a remote AG-UI agent whose state patches only apply to the run's starting state, or to none: the runs finish, the state is saved, and the thread can be used and deleted.
- `tests/standalone-runner.test.ts` and `tests/standalone-chat-store.test.ts`: persistence, replay after restart, durability boundary, concurrency, stop (including an agent whose `abortRun` is a no-op), shutdown caps, heartbeat, crash recovery at startup, by sweep (which leaves a lock whose holder heartbeats meanwhile) and by a claim that takes over a stale lock, connect races (a reply that begins, is registered or is saved during the history read, in this process or another), a history that cannot be read, claim cleanup (also at shutdown), text Postgres cannot store, list timestamps under any `DateStyle`, and retention.
- `tests/rich-threads.test.ts` keeps covering Intelligence mode unchanged.

The standalone tests use embedded PGlite. To run them through a pg Pool against real Postgres, as `DATABASE_URL` does, set `OPENMUSE_TEST_DATABASE_URL` to a server where they may create databases (each test file creates its own and drops it): `OPENMUSE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm exec tsx --import ./tests/setup.ts --test tests/standalone-*.test.ts`. They never read `DATABASE_URL` itself. CI runs them this way too, in the `postgres` job of `.github/workflows/ci.yml`, against a `postgres:17` service container.
