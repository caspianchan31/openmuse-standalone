// Standalone: everything local chat mode adds, built once per app when no Intelligence key is set.
import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import type { Hono } from "hono";
import type { Auth } from "../auth.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { ChatStore } from "./chat-store.ts";
import { LocalAgentRunner } from "./runner.ts";
import { standaloneRuntimeHooks } from "./runtime-hooks.ts";
import { standaloneThreadRoutes } from "./thread-routes.ts";
import type { LocalRunnerOptions } from "./types.ts";

export interface StandaloneChat {
  runner: LocalAgentRunner;
  hooks: CopilotRuntimeHooks;
  routes: Hono<{ Variables: { owner: string } }>;
  /** Records the owner's main thread locally (replaces Intelligence getOrCreateThread). */
  ensureThread(owner: string, threadId: string, agentId: string): Promise<void>;
  /** Saves in-flight replies as interrupted and stops timers. Call before closing the database. */
  close(): Promise<void>;
}

export async function createStandaloneChat(input: {
  db: Store;
  auth: Pick<Auth, "owner">;
  config: Pick<Config, "chatRetentionDays">;
  runner?: Omit<LocalRunnerOptions, "retentionDays">;
}): Promise<StandaloneChat> {
  const store = await ChatStore.open(input.db);
  const runner = new LocalAgentRunner(store, {
    ...input.runner,
    retentionDays: input.config.chatRetentionDays,
  });
  await runner.start();
  return {
    runner,
    hooks: standaloneRuntimeHooks({ auth: input.auth, threads: store, runs: runner }),
    routes: standaloneThreadRoutes(store),
    async ensureThread(owner, threadId, agentId) {
      if ((await store.ensureThread(owner, threadId, agentId)) === "forbidden")
        throw new AppError("Thread not found", 404);
    },
    close: () => runner.close(),
  };
}
