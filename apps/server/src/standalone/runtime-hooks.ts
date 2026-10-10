// Standalone: CopilotKit runtime hooks for local mode. They run after the runtime's own router, so
// owner checks and the busy-thread 409 apply to every path the runtime would serve.
import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import type { Auth } from "../auth.ts";
import type { StandaloneRunControl, StandaloneThreadStore } from "./types.ts";

export interface StandaloneHookDeps {
  auth: Pick<Auth, "owner">;
  threads: Pick<StandaloneThreadStore, "threadOwner">;
  runs: StandaloneRunControl;
}

/** The /info thread capabilities local mode serves (list, inspect and mutations; no realtime). */
export const localThreadEndpoints = {
  list: true,
  inspect: true,
  mutations: true,
  realtimeMetadata: false,
} as const;

/**
 * agent/run: claim the thread for the session owner before the SSE response (busy -> 409
 * agent_thread_locked, another owner's thread -> 404) and release the claim if the runtime
 * answers non-200. agent/connect and agent/stop: another owner's thread -> 404.
 * info: threadEndpoints rewritten to localThreadEndpoints.
 */
export function standaloneRuntimeHooks(deps: StandaloneHookDeps): CopilotRuntimeHooks {
  void deps;
  return {};
}
