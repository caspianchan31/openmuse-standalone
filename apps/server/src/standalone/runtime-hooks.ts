// Standalone: CopilotKit runtime hooks for local mode. They run after the runtime's own router, so
// owner checks and the busy-thread 409 apply to every path the runtime would serve.
import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import type { Auth } from "../auth.ts";
import { AppError } from "../errors.ts";
import {
  type StandaloneRunControl,
  type StandaloneThreadStore,
  threadLockedCode,
} from "./types.ts";

export interface StandaloneHookDeps {
  auth: Pick<Auth, "owner">;
  threads: Pick<StandaloneThreadStore, "threadOwner">;
  runs: StandaloneRunControl;
}

export type StandaloneRuntimeHooks = Required<
  Pick<CopilotRuntimeHooks, "onBeforeHandler" | "onResponse">
>;

/** The /info thread capabilities local mode serves (list, inspect and mutations; no realtime). */
export const localThreadEndpoints = {
  list: true,
  inspect: true,
  mutations: true,
  realtimeMetadata: false,
} as const;

/** Body of the 409 a run on a busy thread receives before any SSE byte. */
export const threadLockedMessage =
  "This conversation is still replying. Try again when it finishes.";

/** Thread and run ids longer than this are left to the runtime's own validation. */
const maxIdLength = 256;

const jsonError = (status: number, error: string, code?: string) =>
  Response.json(code ? { error, code } : { error }, { status });
const threadNotFound = () => jsonError(404, "Thread not found");

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxIdLength;

/** The JSON body without consuming it; undefined when it is not a JSON object. */
async function peekBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.clone().json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * agent/run: claim the thread for the session owner before the SSE response (busy -> 409
 * agent_thread_locked, another owner's thread -> 404) and release the claim if the runtime
 * answers non-200. agent/connect and agent/stop: another owner's thread -> 404.
 * info: threadEndpoints rewritten to localThreadEndpoints.
 * cpk-debug-events: 404, because the debug bus carries every owner's run events.
 */
export function standaloneRuntimeHooks({
  auth,
  threads,
  runs,
}: StandaloneHookDeps): StandaloneRuntimeHooks {
  const claims = new WeakMap<Request, { threadId: string; runId: string }>();

  async function ownerOf(request: Request) {
    try {
      return await auth.owner(request.headers.get("authorization") ?? undefined);
    } catch (error) {
      if (error instanceof AppError) throw jsonError(401, error.message);
      throw error;
    }
  }

  async function assertOwnThread(request: Request, threadId: string) {
    const owner = await ownerOf(request);
    const holder = await threads.threadOwner(threadId);
    if (holder !== null && holder !== owner) throw threadNotFound();
  }

  return {
    async onBeforeHandler({ request, route }) {
      switch (route.method) {
        case "agent/run": {
          const owner = await ownerOf(request);
          const body = await peekBody(request);
          // An invalid body is answered 400 by the runtime; nothing is claimed.
          if (!isId(body?.threadId) || !isId(body?.runId)) return;
          const { threadId, runId } = body;
          const claim = await runs.claim({ owner, threadId, agentId: route.agentId, runId });
          if (!claim.ok)
            throw claim.reason === "locked"
              ? jsonError(409, threadLockedMessage, threadLockedCode)
              : threadNotFound();
          claims.set(request, { threadId, runId });
          return;
        }
        case "agent/connect": {
          const body = await peekBody(request);
          // Threads are only ever created with ids that pass isId, so other ids replay nothing.
          if (isId(body?.threadId)) await assertOwnThread(request, body.threadId);
          else await ownerOf(request);
          return;
        }
        case "agent/stop":
          await assertOwnThread(request, route.threadId);
          return;
        case "cpk-debug-events":
          throw jsonError(404, "Not found");
        default:
          return;
      }
    },
    async onResponse({ request, response, route }) {
      if (route.method === "agent/run") {
        const claim = claims.get(request);
        claims.delete(request);
        // The run never began (bad body, unknown agent, runtime error): undo the claim. A failed
        // release keeps the runtime's answer; the unstarted claim is then recovered as stale.
        if (claim && response.status !== 200)
          await runs.release(claim.threadId, claim.runId).catch((error: unknown) => {
            console.error(
              `[OpenMuse] Releasing an unstarted chat run failed: ${error instanceof Error ? error.name : "Error"}`,
            );
          });
        return;
      }
      if (route.method === "info" && response.ok) return withLocalThreadEndpoints(response);
    },
  };
}

/** The runtime's /info body with threadEndpoints pointing the client at the local thread routes. */
async function withLocalThreadEndpoints(response: Response): Promise<Response | undefined> {
  let info: unknown;
  try {
    info = await response.clone().json();
  } catch {
    return undefined;
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...info, threadEndpoints: localThreadEndpoints }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
