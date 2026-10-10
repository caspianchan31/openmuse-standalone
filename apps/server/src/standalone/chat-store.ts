// Standalone: chat threads, runs and the running-run journal in this server's own database.
// Schema and statements: see the standalone plan (chat_threads, chat_runs, chat_events).
// Store.sql has no transactions (a pg Pool hands out one connection per query), so every multi-row
// state change below is ONE statement; Postgres runs data-modifying CTEs atomically.
import type { BaseEvent } from "@ag-ui/client";
import type { Store } from "../db.ts";
import { compactLeniently } from "./events.ts";
import type {
  DeleteResult,
  ListThreadsQuery,
  StandaloneThreadStore,
  ThreadPage,
  ThreadPatch,
  ThreadRecord,
} from "./types.ts";

/** A malformed or forged list cursor; the thread routes answer 400. */
export class CursorError extends Error {
  override name = "CursorError";
  constructor() {
    super("Invalid cursor");
  }
}

export type RunStatus = "running" | "finished" | "error" | "stopped" | "interrupted";

export type BeginResult =
  | { status: "begun"; stopRequested: boolean }
  | { status: "locked"; holder: string | null; stale: boolean }
  | { status: "missing" }
  | { status: "duplicate" };

/** Holders known to be dead, whose locks are recovered at once (see staleRuns). */
export interface DeadLocks {
  /** A previous process that used this instance id. */
  instanceId?: string;
  /** Every holder: this process is the only one that can use the database. */
  all?: boolean;
}

export interface ClaimRow {
  claimed: boolean;
  owner: string | null;
  holder: string | null;
  stale: boolean;
}

// One advisory lock serialises concurrent first starts (API and worker) on the same Postgres.
const schema = `DO $$ BEGIN
PERFORM pg_advisory_xact_lock(7316010401);
CREATE TABLE IF NOT EXISTS chat_threads(
  id text PRIMARY KEY,
  owner text NOT NULL,
  agent_id text NOT NULL,
  name text,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  run_id text,
  run_instance text,
  run_claimed_at timestamptz,
  run_heartbeat_at timestamptz,
  stop_requested boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS chat_threads_owner_recent
  ON chat_threads(owner, agent_id, (coalesce(last_run_at, created_at)) DESC, id DESC);
CREATE INDEX IF NOT EXISTS chat_threads_locked ON chat_threads(run_heartbeat_at) WHERE run_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS chat_runs(
  run_id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  position bigserial,
  parent_run_id text,
  status text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS chat_runs_thread ON chat_runs(thread_id, position);
-- The sweep's scans (every 15 s in each process): running runs, and closed runs by age (retention).
CREATE INDEX IF NOT EXISTS chat_runs_running ON chat_runs(thread_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS chat_runs_closed_age ON chat_runs(finished_at) WHERE status<>'running';
CREATE TABLE IF NOT EXISTS chat_events(
  run_id text NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
  seq integer NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY(run_id, seq)
);
END $$`;

const threadColumns = "id, name, agent_id, archived, created_at, updated_at, last_run_at";
const ms = "::double precision * interval '1 millisecond'";
const unlock =
  "run_id=NULL, run_instance=NULL, run_claimed_at=NULL, run_heartbeat_at=NULL, stop_requested=false";

interface ThreadRow {
  id: string;
  name: string | null;
  agent_id: string;
  archived: boolean;
  created_at: unknown;
  updated_at: unknown;
  last_run_at: unknown;
}

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    organizationId: "",
    createdById: "",
    archived: row.archived,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastRunAt: row.last_run_at == null ? null : iso(row.last_run_at),
  };
}

/** jsonb text for a value; NUL characters (rejected by Postgres) become U+FFFD. */
export function toJsonb(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "string" && item.includes("\u0000") ? item.replaceAll("\u0000", "�") : item,
  );
}

/** A list cursor's sort key: microseconds since 1970 (independent of the server's DateStyle). */
const epochMicros = /^\d{1,18}$/;

function encodeCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify({ k: key, id })).toString("base64url");
}

function decodeCursor(cursor: string): { k: string; id: string } {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new CursorError();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") throw new CursorError();
    const { k, id } = value as { k?: unknown; id?: unknown };
    if (typeof k !== "string" || !epochMicros.test(k)) throw new CursorError();
    if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new CursorError();
    return { k, id };
  } catch {
    throw new CursorError();
  }
}

function isDataError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("22");
}

export class ChatStore implements StandaloneThreadStore {
  private constructor(readonly db: Store) {}

  /** Creates the chat_* tables if needed (idempotent on PGlite and Postgres). */
  static async open(db: Store): Promise<ChatStore> {
    await db.sql(schema);
    return new ChatStore(db);
  }

  async ensureThread(
    owner: string,
    threadId: string,
    agentId: string,
  ): Promise<"ok" | "forbidden"> {
    const rows = await this.db.sql<{ owner: string }>(
      `/* chat:ensure */ WITH ins AS (
        INSERT INTO chat_threads(id, owner, agent_id) VALUES($1, $2, $3)
        ON CONFLICT (id) DO NOTHING RETURNING owner
      )
      SELECT owner FROM ins UNION ALL SELECT owner FROM chat_threads WHERE id=$1`,
      [threadId, owner, agentId],
    );
    // A row inserted concurrently after this statement's snapshot is only visible to a new one.
    const found = rows[0]?.owner ?? (await this.threadOwner(threadId));
    return found === owner ? "ok" : "forbidden";
  }

  async threadOwner(threadId: string): Promise<string | null> {
    const rows = await this.db.sql<{ owner: string }>(
      "SELECT owner FROM chat_threads WHERE id=$1",
      [threadId],
    );
    return rows[0]?.owner ?? null;
  }

  async listThreads(owner: string, query: ListThreadsQuery): Promise<ThreadPage> {
    const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 50) || 50));
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    let rows: (ThreadRow & { sort_key: string })[];
    try {
      rows = await this.db.sql(
        `/* chat:list */ SELECT ${threadColumns},
          (extract(epoch FROM coalesce(last_run_at, created_at)) * 1000000)::bigint::text AS sort_key
        FROM chat_threads
        WHERE owner=$1 AND agent_id=$2 AND last_run_at IS NOT NULL AND ($3::boolean OR NOT archived)
          AND ($4::bigint IS NULL OR (coalesce(last_run_at, created_at), id)
            < (timestamptz 'epoch' + $4::bigint * interval '1 microsecond', $5::text))
        ORDER BY coalesce(last_run_at, created_at) DESC, id DESC
        LIMIT $6`,
        [
          owner,
          query.agentId,
          query.includeArchived === true,
          after?.k ?? null,
          after?.id ?? null,
          limit + 1,
        ],
      );
    } catch (error) {
      if (after && isDataError(error)) throw new CursorError();
      throw error;
    }
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      threads: page.map(toRecord),
      nextCursor: rows.length > limit && last ? encodeCursor(last.sort_key, last.id) : null,
    };
  }

  async updateThread(
    owner: string,
    threadId: string,
    agentId: string,
    patch: ThreadPatch,
  ): Promise<ThreadRecord | null> {
    const name = patch.name ?? null;
    const archived = patch.archived ?? null;
    const rows = await this.db.sql<ThreadRow>(
      `/* chat:update */ UPDATE chat_threads SET name=coalesce($4::text, name),
        archived=coalesce($5::boolean, archived),
        updated_at=CASE WHEN $4::text IS NULL AND $5::boolean IS NULL THEN updated_at ELSE now() END
      WHERE id=$1 AND owner=$2 AND agent_id=$3
      RETURNING ${threadColumns}`,
      [threadId, owner, agentId, name, archived],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async deleteThread(owner: string, threadId: string, agentId: string): Promise<DeleteResult> {
    const rows = await this.db.sql<{ found: number; deleted: number }>(
      `/* chat:delete */ WITH target AS (
        SELECT id FROM chat_threads WHERE id=$1 AND owner=$2 AND agent_id=$3
      ), gone AS (
        DELETE FROM chat_threads t USING target WHERE t.id=target.id AND t.run_id IS NULL RETURNING t.id
      )
      SELECT (SELECT count(*) FROM target)::int AS found, (SELECT count(*) FROM gone)::int AS deleted`,
      [threadId, owner, agentId],
    );
    const row = rows[0];
    if (!row?.found) return "not_found";
    return row.deleted ? "deleted" : "running";
  }

  async threadEvents(owner: string, threadId: string): Promise<BaseEvent[] | null> {
    const rows = await this.db.sql<{ owner: string; runs: BaseEvent[][] }>(
      `/* chat:thread-events */ SELECT t.owner, coalesce((
        SELECT jsonb_agg(r.events ORDER BY r.position) FROM chat_runs r
        WHERE r.thread_id=t.id AND r.status<>'running'
      ), '[]'::jsonb) AS runs
      FROM chat_threads t WHERE t.id=$1`,
      [threadId],
    );
    const row = rows[0];
    if (!row || row.owner !== owner) return null;
    return compactLeniently(row.runs.flat());
  }

  // ---- Runner statements (LocalAgentRunner). Not owner-scoped: the hooks check ownership. ----

  /** Inserts the thread for owner if absent and takes the lock iff it is owned by owner and idle. */
  async claimRun(input: {
    owner: string;
    threadId: string;
    agentId: string;
    runId: string;
    instanceId: string;
    staleAfterMs: number;
  }): Promise<ClaimRow> {
    const rows = await this.db.sql<{
      claimed: number;
      owner: string | null;
      holder: string | null;
      stale: boolean | null;
    }>(
      `/* chat:claim */ WITH claimed AS (
        INSERT INTO chat_threads AS t (id, owner, agent_id, run_id, run_instance, run_claimed_at,
          run_heartbeat_at, stop_requested)
        VALUES ($1, $2, $3, $4, $5, now(), now(), false)
        ON CONFLICT (id) DO UPDATE SET run_id=excluded.run_id, run_instance=excluded.run_instance,
          run_claimed_at=now(), run_heartbeat_at=now(), stop_requested=false
        WHERE t.owner=excluded.owner AND t.run_id IS NULL
        RETURNING t.id
      )
      SELECT (SELECT count(*) FROM claimed)::int AS claimed, t.owner, t.run_id AS holder,
        (t.run_heartbeat_at < now() - $6${ms}) AS stale
      FROM (SELECT 1) one LEFT JOIN chat_threads t ON t.id=$1`,
      [
        input.threadId,
        input.owner,
        input.agentId,
        input.runId,
        input.instanceId,
        input.staleAfterMs,
      ],
    );
    const row = rows[0];
    return {
      claimed: Boolean(row?.claimed),
      owner: row?.owner ?? null,
      holder: row?.holder ?? null,
      stale: row?.stale === true,
    };
  }

  /**
   * Undoes a claim whose run is not running (never began, or its start failed). A thread row that
   * has never run, has no runs and was not renamed or archived is deleted instead of kept unlocked,
   * so refused runs leave no rows behind (/api/main-thread records the main thread again).
   */
  async releaseClaim(threadId: string, runId: string): Promise<boolean> {
    const rows = await this.db.sql<{ released: number }>(
      `/* chat:release */ WITH gone AS (
        DELETE FROM chat_threads t
        WHERE t.id=$1 AND t.run_id=$2 AND t.last_run_at IS NULL AND t.name IS NULL AND NOT t.archived
          AND NOT EXISTS (SELECT 1 FROM chat_runs r WHERE r.thread_id=t.id)
        RETURNING t.id
      ), kept AS (
        UPDATE chat_threads t SET ${unlock}
        WHERE t.id=$1 AND t.run_id=$2 AND NOT EXISTS (SELECT 1 FROM gone)
          AND NOT EXISTS (
            SELECT 1 FROM chat_runs r WHERE r.run_id=$2 AND r.thread_id=t.id AND r.status='running')
        RETURNING t.id
      )
      SELECT ((SELECT count(*) FROM gone) + (SELECT count(*) FROM kept))::int AS released`,
      [threadId, runId],
    );
    return Boolean(rows[0]?.released);
  }

  /** Ids of every message already stored for the thread (closed runs). */
  async historicMessageIds(threadId: string): Promise<string[]> {
    const rows = await this.db.sql<{ ids: string[] }>(
      `/* chat:historic */ SELECT coalesce(jsonb_agg(DISTINCT i.value), '[]'::jsonb) AS ids
      FROM chat_runs r, jsonb_array_elements_text(r.message_ids) i
      WHERE r.thread_id=$1 AND r.status<>'running'`,
      [threadId],
    );
    return rows[0]?.ids ?? [];
  }

  /**
   * Starts a run: the thread must be claimed for runId (or idle, which claims it now); inserts the
   * running chat_runs row (events = [the persisted RUN_STARTED]) and sets last_run_at.
   */
  async beginRun(input: {
    threadId: string;
    runId: string;
    instanceId: string;
    started: BaseEvent;
    staleAfterMs: number;
  }): Promise<BeginResult> {
    const rows = await this.db.sql<{
      begun: number;
      stop_requested: boolean | null;
      found: number;
      holder: string | null;
      stale: boolean | null;
      dup_status: string | null;
    }>(
      `/* chat:begin */ WITH thread AS (
        SELECT run_id, (run_id IS NOT NULL AND run_heartbeat_at < now() - $5${ms}) AS stale
        FROM chat_threads WHERE id=$1
      ), dup AS (
        SELECT status FROM chat_runs WHERE run_id=$2
      ), parent AS (
        SELECT run_id FROM chat_runs WHERE thread_id=$1 AND status<>'running'
        ORDER BY position DESC LIMIT 1
      ), lock AS (
        UPDATE chat_threads t SET run_id=$2, run_instance=$3,
          run_claimed_at=CASE WHEN t.run_id=$2 THEN t.run_claimed_at ELSE now() END,
          run_heartbeat_at=now(), last_run_at=now(), updated_at=now(),
          stop_requested=CASE WHEN t.run_id=$2 THEN t.stop_requested ELSE false END
        WHERE t.id=$1 AND (t.run_id=$2 OR t.run_id IS NULL) AND NOT EXISTS (SELECT 1 FROM dup)
        RETURNING t.id, t.stop_requested
      ), run AS (
        INSERT INTO chat_runs(run_id, thread_id, parent_run_id, status, events)
        SELECT $2, lock.id, (SELECT run_id FROM parent), 'running', $4::jsonb FROM lock
        RETURNING run_id
      )
      SELECT (SELECT count(*) FROM run)::int AS begun,
        (SELECT stop_requested FROM lock) AS stop_requested,
        (SELECT count(*) FROM thread)::int AS found,
        (SELECT run_id FROM thread) AS holder,
        (SELECT stale FROM thread) AS stale,
        (SELECT status FROM dup) AS dup_status`,
      [input.threadId, input.runId, input.instanceId, toJsonb([input.started]), input.staleAfterMs],
    );
    const row = rows[0];
    if (row?.begun) return { status: "begun", stopRequested: row.stop_requested === true };
    if (!row?.found) return { status: "missing" };
    // The same runId already ran: a duplicate request while it runs is "locked", later "duplicate".
    if (row.dup_status && row.dup_status !== "running") return { status: "duplicate" };
    return { status: "locked", holder: row.holder, stale: row.stale === true };
  }

  /** Appends events to a running run's journal at seq0, seq0+1, ... (idempotent on retry). */
  async appendJournal(runId: string, seq0: number, events: BaseEvent[]): Promise<void> {
    await this.db.sql(
      `/* chat:journal */ INSERT INTO chat_events(run_id, seq, event)
      SELECT $1, $2::int + (x.ord::int - 1), x.value
      FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS x(value, ord)
      WHERE EXISTS (SELECT 1 FROM chat_runs WHERE run_id=$1 AND status='running')
      ON CONFLICT DO NOTHING`,
      [runId, seq0, toJsonb(events)],
    );
  }

  /**
   * Closes a run in one statement: saves its compacted events, deletes its journal and releases
   * the thread lock (guarded by runId). With staleAfterMs (recovery), only a lock whose heartbeat
   * is older than that is touched. A missing run row just releases the lock.
   */
  async closeRun(input: {
    threadId: string;
    runId: string;
    status: Exclude<RunStatus, "running">;
    events: BaseEvent[];
    messageIds: string[];
    staleAfterMs?: number;
  }): Promise<{ closed: boolean; released: boolean }> {
    const rows = await this.db.sql<{ closed: number; released: number }>(
      `/* chat:close */ WITH guard AS (
        SELECT 1 AS ok WHERE $6::double precision IS NULL OR NOT EXISTS (
          SELECT 1 FROM chat_threads WHERE id=$1 AND run_id=$2
            AND run_heartbeat_at >= now() - $6${ms})
      ), run AS (
        UPDATE chat_runs SET events=$3::jsonb, message_ids=$4::jsonb, status=$5, finished_at=now()
        WHERE run_id=$2 AND thread_id=$1 AND status='running' AND EXISTS (SELECT 1 FROM guard)
        RETURNING run_id
      ), journal AS (
        DELETE FROM chat_events WHERE run_id IN (SELECT run_id FROM run) RETURNING 1
      ), thread AS (
        UPDATE chat_threads SET ${unlock}, updated_at=now()
        WHERE id=$1 AND run_id=$2 AND EXISTS (SELECT 1 FROM guard)
        RETURNING id
      )
      SELECT (SELECT count(*) FROM run)::int AS closed, (SELECT count(*) FROM thread)::int AS released`,
      [
        input.threadId,
        input.runId,
        toJsonb(input.events),
        toJsonb(input.messageIds),
        input.status,
        input.staleAfterMs ?? null,
      ],
    );
    return { closed: Boolean(rows[0]?.closed), released: Boolean(rows[0]?.released) };
  }

  /** Refreshes this instance's locks for the given runs; returns their stop requests. */
  async heartbeat(
    instanceId: string,
    runIds: string[],
  ): Promise<{ threadId: string; runId: string; stopRequested: boolean }[]> {
    if (runIds.length === 0) return [];
    const rows = await this.db.sql<{ id: string; run_id: string; stop_requested: boolean }>(
      `/* chat:heartbeat */ UPDATE chat_threads SET run_heartbeat_at=now()
      WHERE run_instance=$1 AND run_id IN (SELECT jsonb_array_elements_text($2::jsonb))
      RETURNING id, run_id, stop_requested`,
      [instanceId, toJsonb(runIds)],
    );
    return rows.map((row) => ({
      threadId: row.id,
      runId: row.run_id,
      stopRequested: row.stop_requested,
    }));
  }

  /**
   * Locks to recover: heartbeat older than staleAfterMs, every lock of dead.instanceId (a previous
   * process with this instance id), every lock when dead.all (no other process can hold one), and
   * running runs no lock points at. Locks of a dead holder are not guarded by their heartbeat.
   */
  async staleRuns(
    staleAfterMs: number,
    dead: DeadLocks = {},
  ): Promise<{ threadId: string; runId: string; guarded: boolean }[]> {
    const rows = await this.db.sql<{ thread_id: string; run_id: string; guarded: boolean }>(
      `/* chat:stale */ SELECT id AS thread_id, run_id,
        NOT ($3::boolean OR ($2::text IS NOT NULL AND run_instance=$2)) AS guarded
      FROM chat_threads
      WHERE run_id IS NOT NULL
        AND ($3::boolean OR run_heartbeat_at < now() - $1${ms}
          OR ($2::text IS NOT NULL AND run_instance=$2))
      UNION
      SELECT r.thread_id, r.run_id, false AS guarded FROM chat_runs r
      WHERE r.status='running' AND NOT EXISTS (
        SELECT 1 FROM chat_threads t WHERE t.id=r.thread_id AND t.run_id=r.run_id)`,
      [staleAfterMs, dead.instanceId ?? null, dead.all === true],
    );
    return rows.map((row) => ({
      threadId: row.thread_id,
      runId: row.run_id,
      guarded: row.guarded,
    }));
  }

  /** A running run's persisted RUN_STARTED record and journal, or null when it is not running. */
  async runningRun(
    threadId: string,
    runId: string,
  ): Promise<{ started: BaseEvent | null; journal: BaseEvent[] } | null> {
    const rows = await this.db.sql<{ events: BaseEvent[]; journal: BaseEvent[] }>(
      `/* chat:running-run */ SELECT r.events, coalesce((
        SELECT jsonb_agg(e.event ORDER BY e.seq) FROM chat_events e WHERE e.run_id=r.run_id
      ), '[]'::jsonb) AS journal
      FROM chat_runs r WHERE r.run_id=$1 AND r.thread_id=$2 AND r.status='running'`,
      [runId, threadId],
    );
    const row = rows[0];
    return row ? { started: row.events[0] ?? null, journal: row.journal } : null;
  }

  /** The journal of the thread's running run (whichever instance holds it), or null. */
  async runningJournal(threadId: string): Promise<BaseEvent[] | null> {
    const rows = await this.db.sql<{ journal: BaseEvent[] }>(
      `/* chat:running-journal */ SELECT coalesce((
        SELECT jsonb_agg(e.event ORDER BY e.seq) FROM chat_events e WHERE e.run_id=r.run_id
      ), '[]'::jsonb) AS journal
      FROM chat_threads t JOIN chat_runs r ON r.run_id=t.run_id AND r.status='running'
      WHERE t.id=$1`,
      [threadId],
    );
    return rows[0]?.journal ?? null;
  }

  /** Compacted-per-run events of the thread's closed runs, oldest first. */
  async closedRunEvents(threadId: string, excludeRunId?: string): Promise<BaseEvent[][]> {
    const rows = await this.db.sql<{ events: BaseEvent[] }>(
      `/* chat:closed-runs */ SELECT events FROM chat_runs
      WHERE thread_id=$1 AND status<>'running' AND ($2::text IS NULL OR run_id<>$2)
      ORDER BY position`,
      [threadId, excludeRunId ?? null],
    );
    return rows.map((row) => row.events);
  }

  /** Flags the thread's current run (optionally only runId) to stop; true when one is locked. */
  async requestStop(threadId: string, runId?: string): Promise<boolean> {
    const rows = await this.db.sql(
      `/* chat:stop */ UPDATE chat_threads SET stop_requested=true
      WHERE id=$1 AND run_id IS NOT NULL AND ($2::text IS NULL OR run_id=$2) RETURNING id`,
      [threadId, runId ?? null],
    );
    return rows.length > 0;
  }

  /** True while a run is claimed, running, or stale but not yet recovered. */
  async isLocked(threadId: string): Promise<boolean> {
    const rows = await this.db.sql<{ locked: boolean }>(
      "SELECT run_id IS NOT NULL AS locked FROM chat_threads WHERE id=$1",
      [threadId],
    );
    return rows[0]?.locked === true;
  }

  /** Releases this instance's claims whose runs never began (shutdown). */
  async releaseInstanceClaims(instanceId: string): Promise<number> {
    const rows = await this.db.sql(
      `/* chat:release-instance */ UPDATE chat_threads t SET ${unlock}
      WHERE t.run_instance=$1 AND t.run_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM chat_runs r WHERE r.run_id=t.run_id AND r.status='running')
      RETURNING t.id`,
      [instanceId],
    );
    return rows.length;
  }

  /** Deletes closed runs that finished more than retentionDays ago; never running runs. */
  async purgeRuns(retentionDays: number): Promise<number> {
    const rows = await this.db.sql<{ n: number }>(
      `/* chat:purge */ WITH gone AS (
        DELETE FROM chat_runs WHERE status<>'running'
          AND finished_at < now() - $1::double precision * interval '1 day'
        RETURNING 1
      ) SELECT count(*)::int AS n FROM gone`,
      [retentionDays],
    );
    return rows[0]?.n ?? 0;
  }
}
