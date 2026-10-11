// Standalone: the contract between the local chat runner/store and the HTTP layer.
// With no CPK_INTELLIGENCE_API_KEY the CopilotKit runtime runs in SSE mode on LocalAgentRunner,
// and conversations live in this server's own database (chat_threads, chat_runs, chat_events).
import type { BaseEvent, Message } from "@ag-ui/client";

/** A thread as the runtime's thread endpoints and CopilotKit's useThreads expect it. */
export interface ThreadRecord {
  id: string;
  name: string | null;
  agentId: string;
  /** Always "" locally; kept for the runtime's thread record shape. */
  organizationId: string;
  /** Always "" locally; the owner is never exposed. */
  createdById: string;
  archived: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  /** ISO 8601 time the latest run began; null before the first run. */
  lastRunAt: string | null;
}

export interface ThreadPage {
  threads: ThreadRecord[];
  /** Opaque; pass back as `cursor` for the next page. */
  nextCursor: string | null;
}

export interface ListThreadsQuery {
  agentId: string;
  includeArchived?: boolean;
  /** 1-100. */
  limit?: number;
  cursor?: string;
}

export interface ThreadPatch {
  name?: string;
  archived?: boolean;
}

/** Thread ids are global: a thread of another owner is "forbidden" and served as 404. */
export type ClaimResult = { ok: true } | { ok: false; reason: "locked" | "forbidden" };

export type DeleteResult = "deleted" | "not_found" | "running";

/** Error code the client already understands as "thread busy, hold the message". */
export const threadLockedCode = "agent_thread_locked";

/**
 * RUN_ERROR code ending a connect whose history could not be read: the app fails the load (and
 * offers Retry) instead of taking what it received for the whole conversation.
 */
export const historyUnavailableCode = "history_unavailable";

/** Owner-scoped thread storage used by the thread routes. Implemented by ChatStore. */
export interface StandaloneThreadStore {
  /** Create the thread for owner if absent. "forbidden" when another owner holds the id. */
  ensureThread(owner: string, threadId: string, agentId: string): Promise<"ok" | "forbidden">;
  /** Owner of a thread, or null when it does not exist. Not owner-scoped: callers compare. */
  threadOwner(threadId: string): Promise<string | null>;
  /** Threads that have run at least once, newest first; archived only when requested. */
  listThreads(owner: string, query: ListThreadsQuery): Promise<ThreadPage>;
  /** null when the thread is missing, owned by someone else, or has another agentId. */
  updateThread(
    owner: string,
    threadId: string,
    agentId: string,
    patch: ThreadPatch,
  ): Promise<ThreadRecord | null>;
  /** Deletes the thread with its runs and journal. "running" while a run holds the lock. */
  deleteThread(owner: string, threadId: string, agentId: string): Promise<DeleteResult>;
  /** Compacted events of the thread's closed runs; null when missing or another owner's. */
  threadEvents(owner: string, threadId: string): Promise<BaseEvent[] | null>;
}

/** Lock control used by the runtime hooks before the runtime answers. Implemented by LocalAgentRunner. */
export interface StandaloneRunControl {
  /**
   * Atomically create the thread for owner if absent and reserve it for runId.
   * Must be called before the runtime starts the SSE response so a busy thread answers 409.
   */
  claim(input: {
    owner: string;
    threadId: string;
    agentId: string;
    runId: string;
  }): Promise<ClaimResult>;
  /** Undo a claim whose run never began (the runtime answered non-200). No-op otherwise. */
  release(threadId: string, runId: string): Promise<void>;
}

export interface LocalRunnerOptions {
  /** Identifies this process's locks; default randomUUID(). start() recovers locks left under it. */
  instanceId?: string;
  /** Lock heartbeat interval; default 5000. */
  heartbeatMs?: number;
  /** A lock without a heartbeat for this long is recovered; default 30000. */
  staleAfterMs?: number;
  /** Recovery/retention sweep interval; default 15000. */
  sweepMs?: number;
  /** Journal flush interval for a running run; default 250. */
  flushMs?: number;
  /** Delete closed runs older than this many days; unset keeps history forever. */
  retentionDays?: number;
  /**
   * No other process can use the database (embedded PGlite): every lock found at start() belongs
   * to a previous process and is recovered at once instead of after staleAfterMs.
   */
  exclusive?: boolean;
}

/** Messages rebuilt from stored events, in the runtime's /threads/:id/messages wire shape. */
export type WireMessage =
  | {
      id: string;
      role: "assistant";
      content?: string;
      toolCalls?: { id: string; name: string; args: string }[];
    }
  | { id: string; role: "tool"; content: string; toolCallId: string }
  | { id: string; role: Exclude<Message["role"], "assistant" | "tool">; content?: unknown };
