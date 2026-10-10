// Standalone: chat threads, runs and the running-run journal in this server's own database.
// Schema and statements: see the standalone plan (chat_threads, chat_runs, chat_events).
import type { BaseEvent } from "@ag-ui/client";
import type { Store } from "../db.ts";
import type {
  DeleteResult,
  ListThreadsQuery,
  StandaloneThreadStore,
  ThreadPage,
  ThreadPatch,
  ThreadRecord,
} from "./types.ts";

export function notImplemented(name: string): never {
  throw new Error(`Standalone chat: ${name} is not implemented yet`);
}

export class ChatStore implements StandaloneThreadStore {
  private constructor(readonly db: Store) {}

  /** Creates the chat_* tables if needed (idempotent on PGlite and Postgres). */
  static async open(db: Store): Promise<ChatStore> {
    void db;
    return notImplemented("ChatStore.open");
  }

  async ensureThread(
    owner: string,
    threadId: string,
    agentId: string,
  ): Promise<"ok" | "forbidden"> {
    void [owner, threadId, agentId];
    return notImplemented("ChatStore.ensureThread");
  }

  async threadOwner(threadId: string): Promise<string | null> {
    void threadId;
    return notImplemented("ChatStore.threadOwner");
  }

  async listThreads(owner: string, query: ListThreadsQuery): Promise<ThreadPage> {
    void [owner, query];
    return notImplemented("ChatStore.listThreads");
  }

  async updateThread(
    owner: string,
    threadId: string,
    agentId: string,
    patch: ThreadPatch,
  ): Promise<ThreadRecord | null> {
    void [owner, threadId, agentId, patch];
    return notImplemented("ChatStore.updateThread");
  }

  async deleteThread(owner: string, threadId: string, agentId: string): Promise<DeleteResult> {
    void [owner, threadId, agentId];
    return notImplemented("ChatStore.deleteThread");
  }

  async threadEvents(owner: string, threadId: string): Promise<BaseEvent[] | null> {
    void [owner, threadId];
    return notImplemented("ChatStore.threadEvents");
  }
}
