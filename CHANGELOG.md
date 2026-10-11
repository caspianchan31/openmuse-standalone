# Changelog

## OpenMuse Standalone v0.1.0 — 2026-10-11

First release of OpenMuse Standalone, based on upstream OpenMuse `main` at `1ac68f3`. Everything upstream does is kept; with `CPK_INTELLIGENCE_API_KEY` set, behavior is unchanged from upstream.

- `CPK_INTELLIGENCE_API_KEY` is optional. Without it, the API starts in local mode and conversations are stored in its own Postgres or embedded PGlite; no third-party chat cloud is used.
- Local mode runs the CopilotKit runtime in SSE mode on a persistent `AgentRunner` (`run`, `connect`, `isRunning`, `stop`) backed by new `chat_threads`, `chat_runs` and `chat_events` tables.
- The API serves `/api/copilotkit/threads*` (list, messages, events, state, rename, archive, restore, delete), scoped to the signed-in owner, and rewrites `/info.threadEndpoints` so the app uses them. `/api/main-thread` works without Intelligence.
- A run on a thread that is already replying answers `409 agent_thread_locked` before any SSE response; the app holds the queued message, as it does for Intelligence's `AgentThreadLockedError`.
- Reloading replays a conversation, and reloading mid-reply resumes the reply. Stop saves the reply so far.
- Replies are journaled while they run and saved before the app sees them finish. Replies cut off by a crash are recovered at startup (PGlite) or once their lock goes stale (Postgres). Shutdown saves replies in progress.
- `CHAT_RETENTION_DAYS` optionally deletes finished replies older than that many days.
- Settings shows where conversations are stored; `/api/workspace` reports `runtime.threads` (`local` or `intelligence`), and Rich Threads are on in both modes.
- `pnpm dev:demo` runs without a key.
- Docs: [README](README.md), [architecture](docs/STANDALONE.md), [local threads reference](docs/STANDALONE-THREADS.md), and upstream's README kept as [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

Known limits: thread lists on other devices refresh when their menu opens rather than live; run one API instance, because a reply resumes live only from the process that runs it; cloud threads are not imported when moving from Intelligence.

## 0.1.0-alpha — 2026-09-15

Initial public OpenMuse alpha.

- Native/web interface using CopilotKit React Native and AG-UI.
- Persistent browser computer, inline PDFs, structured artifacts, and optional Rich Threads integration.
- Durable delegated tasks, reviews/receipts, Ideas, Goals, Tracking, and editable memory.
- Google adapters, supported PDF workflows, and CSV spending summaries.
- Disabled, contract-tested OpenBot adapter for future backend integration.
- Native walkthrough recording, contributor docs, and CI for tests, builds, and real Chromium.
- Fixed Ideas suggesting sent replies or already completed matching work; restored task delegation in the persistent menu.

See [verification](docs/VERIFICATION.md) for actual coverage and [roadmap](ROADMAP.md) for incomplete integrations.
