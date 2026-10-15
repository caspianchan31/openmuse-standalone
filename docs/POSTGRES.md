# Run OpenMuse with external PostgreSQL

OpenMuse uses embedded PGlite when `DATABASE_URL` is unset. Set `DATABASE_URL` to use an external PostgreSQL server instead. The API creates its application tables, including `chat_threads`, `chat_runs` and `chat_events`, when it starts.

This walkthrough uses Docker for PostgreSQL and the sample workspace, so it does not require a model key or a CopilotKit Intelligence key.

## Requirements

- macOS or Linux with Docker
- Node.js 24 LTS (Node.js 22 or newer is supported by `package.json`)
- pnpm 11.19.0

## 1. Start PostgreSQL

From the repository root, start a disposable local PostgreSQL instance:

```sh
docker run --name openmuse-postgres \
  --detach \
  --env POSTGRES_PASSWORD=local-test-password \
  --env POSTGRES_DB=openmuse \
  --publish 55432:5432 \
  postgres:16-alpine
```

Wait until PostgreSQL accepts connections:

```sh
until docker exec openmuse-postgres pg_isready -U postgres -d openmuse >/dev/null 2>&1; do
  sleep 1
done
```

The connection URL for this container is:

```text
postgresql://postgres:local-test-password@127.0.0.1:55432/openmuse
```

Use a URL-encoded password if your real PostgreSQL password contains characters with special meaning in a URL.

## 2. Configure and start the API

Copy the example environment file to `.env`, then set these values in it:

```dotenv
WORKSPACE_MODE=sample
AGENT_BACKEND=sample
PORT=18787
HOST=127.0.0.1
PUBLIC_API_URL=http://127.0.0.1:18787
DATABASE_URL=postgresql://postgres:local-test-password@127.0.0.1:55432/openmuse
TASK_WORKER_ENABLED=true
```

Install dependencies and start the API:

```sh
cp .env.example .env
# Edit .env with the values above.
npx --yes pnpm@11.19.0 install --frozen-lockfile
npx --yes pnpm@11.19.0 dev
```

The API should report that it is ready at `http://127.0.0.1:18787`. In another terminal, confirm that PostgreSQL contains the tables created by OpenMuse:

```sh
docker exec openmuse-postgres \
  psql -U postgres -d openmuse \
  -Atc "select tablename from pg_tables where schemaname = 'public' order by tablename;"
```

The output includes:

```text
chat_events
chat_runs
chat_threads
records
```

`records` stores the rest of the application data. The three `chat_*` tables store local chat threads, runs and the journal for replies in progress.

## 3. Send a message

Create a sample session and get its main thread:

```sh
session_json=$(curl -sS -X POST http://127.0.0.1:18787/api/session \
  -H 'Content-Type: application/json' \
  -d '{}')
token=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$session_json")
thread_json=$(curl -sS http://127.0.0.1:18787/api/main-thread \
  -H "Authorization: Bearer $token")
thread=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).threadId)' "$thread_json")
```

Send a sample message over the local SSE chat route:

```sh
message_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
run_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
node -e '
const [thread, run, message] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  threadId: thread,
  runId: run,
  messages: [{ id: message, role: "user", content: "Show my calendar" }],
  tools: [], context: [], state: {}, forwardedProps: {}
}));
' "$thread" "$run_id" "$message_id" >/tmp/openmuse-run.json
curl -sS -N -X POST \
  http://127.0.0.1:18787/api/copilotkit/agent/default/run \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/openmuse-run.json
```

The response is an SSE stream. In sample mode it contains `RUN_STARTED`, text content describing the sample calendar, and `RUN_FINISHED`. The reply is saved in PostgreSQL before the finished event is sent.

Confirm the saved messages:

```sh
curl -sS \
  http://127.0.0.1:18787/api/copilotkit/threads/$thread/messages \
  -H "Authorization: Bearer $token"
```

## 4. Restart and verify persistence

Stop the API with `Ctrl-C`, then start it again:

```sh
npx --yes pnpm@11.19.0 dev
```

Using the same `token` and `thread` values from the earlier terminal, request the messages again:

```sh
curl -sS \
  http://127.0.0.1:18787/api/copilotkit/threads/$thread/messages \
  -H "Authorization: Bearer $token"
```

The response still contains the user message and the sample assistant reply. The PostgreSQL container must remain running, and the API must use the same `DATABASE_URL`; `DATA_DIR` does not hold the chat data in this setup.

When finished, remove the disposable database container:

```sh
docker rm --force openmuse-postgres
```

## Verification record

The commands above were run on macOS 15.6 (Apple Silicon, Darwin 24.6.0) with Docker 29.8.2, Node.js v25.9.0, pnpm 11.19.0, and PostgreSQL 16.15 (`postgres:16-alpine`). Node 25.9.0 was used for verification because it was installed on that machine; the documented project requirement remains Node 24 LTS.

Observed results:

- The API started in sample mode with `DATABASE_URL` set and reported a healthy `/api/health` response.
- PostgreSQL contained `chat_events`, `chat_runs`, `chat_threads` and `records` after startup.
- A sample `Show my calendar` message completed as an SSE run with `RUN_STARTED` first and `RUN_FINISHED` last. The thread contained one user message and one assistant message.
- After stopping and starting the API again, the same thread still returned both messages from PostgreSQL.

The separate task worker was not part of this walkthrough. If you use one, keep the API and worker on the same `DATABASE_URL`, set `TASK_WORKER_ENABLED=false` on the API, and follow the worker commands in [Persistence and operation](UPSTREAM-README.md#persistence-and-operation).
