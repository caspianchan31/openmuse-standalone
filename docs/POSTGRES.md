# Running OpenMuse Standalone with an external Postgres

By default the API keeps everything in embedded PGlite under `DATA_DIR/postgres`. This guide points it at a Postgres server of your own instead, through `DATABASE_URL`, and checks each step. It was followed end to end on a clean checkout; the versions used are at the [end](#what-this-guide-was-run-with).

What `DATABASE_URL` changes, and what it does not:

- All of OpenMuse's data moves to that server: the `records` table (workspace, tasks, sessions) and, in local mode, the chat tables `chat_threads`, `chat_runs` and `chat_events`. They are created on startup if they do not exist.
- `DATA_DIR` is still used for files, PDF documents and the session signing key, so keep it on a persistent disk and back it up with the database.
- A separate task worker becomes possible (step 4). With PGlite, one process owns the database, so the worker has to run inside the API.
- The URL is read from `.env` by the API and the task worker, both started from the repository root. Each opens a pool of up to 5 connections. A `DATABASE_URL` already set in the shell wins over the one in `.env`, and the API says so at startup (`[OpenMuse] Using DATABASE_URL from the environment instead of .env`). `pnpm dev:demo` keeps its own PGlite database and ignores it.

## 1. Start a Postgres

Any reachable Postgres works. Two ways to get one on your own machine:

With Docker (the container keeps its data in the `openmuse-pg` volume):

```sh
docker run -d --name openmuse-pg -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=openmuse \
  -v openmuse-pg:/var/lib/postgresql/data postgres:17
```

With Homebrew on macOS:

```sh
brew install postgresql@17
brew services start postgresql@17
/opt/homebrew/opt/postgresql@17/bin/createdb -h 127.0.0.1 openmuse
```

Check that it answers before going on:

```sh
pg_isready -h 127.0.0.1 -p 5432
```

If you create the database yourself, create it empty; OpenMuse creates its tables.

## 2. Point the API at it

From the repository root (the API reads `.env` from the directory it is started in):

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Add the URL to `.env`. Use the user, password and database you chose in step 1:

```dotenv
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/openmuse
```

Leave `CPK_INTELLIGENCE_API_KEY` unset so that conversations are stored in this database (local mode). The rest of `.env.example` can stay as it is for a first run: `WORKSPACE_MODE=sample` and `AGENT_BACKEND=sample` need no model or Google account.

Start the API:

```sh
pnpm dev
```

It prints `OpenMuse sample API ready at http://localhost:8787`. The tables now exist:

```sh
psql postgres://postgres:postgres@127.0.0.1:5432/openmuse -c '\dt'
```

```
 Schema |     Name     | Type  |  Owner
--------+--------------+-------+----------
 public | chat_events  | table | postgres
 public | chat_runs    | table | postgres
 public | chat_threads | table | postgres
 public | records      | table | postgres
```

The API also reports local mode. Create a session, then read the workspace with its token (in sample mode `POST /api/session` needs no access key):

```sh
TOKEN=$(curl -s -X POST http://localhost:8787/api/session -H 'Content-Type: application/json' -d '{}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s http://localhost:8787/api/workspace -H "Authorization: Bearer $TOKEN" | grep -o '"threads":"[a-z]*"'
```

This prints `"threads":"local"`. With a Postgres that is not reachable, `pnpm dev` exits during startup with the connection error from `pg` (`Error: connect ECONNREFUSED 127.0.0.1:5432` from `createStore`); it never falls back to PGlite.

## 3. Send a message, restart, and check it is still there

In a second terminal, start the web app and open http://localhost:8081:

```sh
pnpm dev:web
```

Send a message, for example `Show my calendar`; the sample agent answers. Each finished reply is one row in `chat_runs`:

```sh
psql postgres://postgres:postgres@127.0.0.1:5432/openmuse -c 'SELECT position, status FROM chat_runs ORDER BY position'
```

```
 position |  status
----------+----------
        1 | finished
```

Now stop the API with Ctrl-C in its terminal and start it again with `pnpm dev`. While it is down, the row is still in Postgres (run the query above again). After it is back, reload the page: the conversation is replayed from the database. `chat_events` is empty whenever no reply is running; it only journals replies in progress.

A reply that was streaming when the API stopped is saved as `interrupted`: at once on `SIGINT`/`SIGTERM`, or, after a crash, once its lock has had no heartbeat for 30 seconds (see [Durability and recovery](STANDALONE-THREADS.md#durability-and-recovery)).

## 4. Optional: a separate task worker

The task worker runs tasks, watches and ideas in the background. By default it runs inside the API process. With `DATABASE_URL` it can be a process of its own, sharing the database and `DATA_DIR`.

On the API, turn the built-in worker off and restart it:

```dotenv
TASK_WORKER_ENABLED=false
```

Then start the worker from the same repository root, so it reads the same `.env`:

```sh
pnpm dev:worker                          # development
pnpm build:server && pnpm start:worker   # production
```

It prints `OpenMuse task worker running`. Without `DATABASE_URL` it refuses to start: `A separate task worker requires DATABASE_URL. Embedded PGlite runs inside the API process.`

The worker never serves chat. Keep running one API process; see [Known limits](../README.md#known-limits).

## Running the test suite against your Postgres

The standalone tests use PGlite by default. To run them through a `pg` Pool against your server, set `OPENMUSE_TEST_DATABASE_URL` (not `DATABASE_URL`) to a URL whose user may create databases; each test file creates its own database and drops it:

```sh
OPENMUSE_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm exec tsx --import ./tests/setup.ts --test tests/standalone-*.test.ts
```

## What this guide was run with

- macOS 26.0 (arm64), Node 24.12.0, pnpm 11.19.0
- PostgreSQL 17.9 (Homebrew), started with trust authentication on 127.0.0.1, so the URL used had no password: `postgres://postgres@127.0.0.1:5432/openmuse`
- OpenMuse Standalone v0.1.0

Things noticed on the way:

- Four tables appear, not three: `records` is OpenMuse's own data and was already there in PGlite.
- `.openmuse/` is still created (for `session-signing-key`) even though no PGlite database is in it.
- Starting a second API on the same port fails with `EADDRINUSE`; this is the same with or without Postgres, but easy to hit while restarting.
