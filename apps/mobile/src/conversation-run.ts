type RunError = { error: unknown; code?: string; context?: { agentId?: string } };

/** A RUN_ERROR event from the thread's saved history, not a failure of this call. */
export const replayedRunError = "agent_run_error_event";

/** The thread is busy with another run, so the server refused this one before starting it. */
export const threadLocked = "agent_thread_locked";

/** CopilotKit reports a lock as agent_thread_locked, then again as agent_run_failed. */
export function isThreadLocked(event: Pick<RunError, "error" | "code">) {
  return (
    event.code === threadLocked ||
    (event.error instanceof Error && event.error.name === "AgentThreadLockedError") ||
    // Standalone: without Intelligence the runtime streams over SSE, so a lock arrives as HTTP.
    isHttpThreadLock(event.error)
  );
}

/**
 * Standalone: a server without an Intelligence key refuses a busy thread with HTTP 409
 * `{ error, code: "agent_thread_locked" }` before streaming. HttpAgent turns that into an Error
 * with `status`, the parsed `payload` and the message `HTTP 409: <body>`, and CopilotKit reports
 * it as agent_run_failed. A lock found after the stream began is a RUN_ERROR event whose code
 * CopilotKit copies onto the error.
 */
function isHttpThreadLock(error: unknown) {
  if (!(error instanceof Error)) return false;
  const { status, payload, code } = error as Error & {
    status?: unknown;
    payload?: unknown;
    code?: unknown;
  };
  if (code === threadLocked) return true;
  if (status === 409 && typeof payload === "object" && payload !== null)
    return (payload as { code?: unknown }).code === threadLocked;
  // The body was not parsed as JSON (for example a proxy changed its content type).
  return error.message.startsWith("HTTP 409:") && error.message.includes(threadLocked);
}

/** A failed turn, carrying the CopilotKit error code that reported it. */
export class ConversationTurnError extends Error {
  constructor(
    readonly cause: Error,
    readonly code?: string,
  ) {
    super(cause.message);
    this.name = cause.name;
  }
}

/** Whether the chat's error banner shows an error reported while these are in progress. */
export function showsRunError(
  event: Pick<RunError, "error" | "code">,
  during: { replaying: boolean; queuedTurn: boolean },
) {
  // A failed turn saved in history is already over; it is not a failure of this session.
  if (during.replaying && event.code === replayedRunError) return false;
  // A queued message refused by a lock goes back on hold. Retry is not a queued turn, so it shows.
  if (during.queuedTurn && isThreadLocked(event)) return false;
  return true;
}

/**
 * What claimThreadLock needs from the agent (an @ag-ui/client AbstractAgent). Results are
 * `unknown` because @ag-ui/client types onRunFailed's result without stopPropagation, although
 * AbstractAgent.onError honours it (it then neither logs nor rethrows the failure);
 * tests/standalone-client.test.ts pins that against the real client.
 */
export interface LockableAgent {
  subscribe(subscriber: {
    onRunFailed?(params: { error: Error }): unknown;
    onRunErrorEvent?(params: { event: { code?: string; message?: string } }): unknown;
  }): { unsubscribe(): void };
}

/**
 * Standalone: claims a thread-lock refusal of the agent's next run, for a turn that puts its
 * message back on hold, so the refusal is expected rather than an error. Returning stopPropagation
 * from the agent subscriber keeps @ag-ui/client ("Agent execution failed") and CopilotKit (its
 * onError, which CopilotKitProvider logs) from reporting it on the console; this subscriber runs
 * before CopilotKit's own run subscriber. The refusal is a 409 before streaming (local mode), an
 * AgentThreadLockedError (Intelligence), or a RUN_ERROR with the lock code. Other failures pass.
 * If a client version stopped honouring stopPropagation here, the refusal would still be held:
 * CopilotKit would then report it as before, and runConversationTurn rethrows it either way.
 */
export function claimThreadLock(agent: LockableAgent) {
  let refusal: Error | undefined;
  const subscription = agent.subscribe({
    onRunFailed: ({ error }) => {
      if (!isThreadLocked({ error })) return undefined;
      refusal ??= error;
      return { stopPropagation: true };
    },
    onRunErrorEvent: ({ event }) => {
      if (event.code !== threadLocked) return undefined;
      refusal ??= Object.assign(new Error(event.message ?? "The conversation is busy."), {
        code: threadLocked,
      });
      return { stopPropagation: true };
    },
  });
  return { refusal: () => refusal, unsubscribe: () => subscription.unsubscribe() };
}

/**
 * CopilotKit emits run failures through onError even when runAgent resolves. With holdOnLock, a
 * thread-lock refusal of that agent's run is claimed (see claimThreadLock) and rethrown here as a
 * threadLocked turn error.
 */
export async function runConversationTurn(
  agentId: string,
  execute: () => Promise<unknown>,
  subscribe: (listener: (event: RunError) => void) => { unsubscribe: () => void },
  ignore: readonly string[] = [],
  holdOnLock?: LockableAgent,
) {
  let failure: ConversationTurnError | undefined;
  const subscription = subscribe((event) => {
    if (event.context?.agentId && event.context.agentId !== agentId) return;
    if (event.code && ignore.includes(event.code)) return;
    const error = event.error instanceof Error ? event.error : new Error(String(event.error));
    // The first report is the specific one; CopilotKit follows it with a generic agent_run_failed.
    failure ??= new ConversationTurnError(error, isThreadLocked(event) ? threadLocked : event.code);
  });
  const lock = holdOnLock ? claimThreadLock(holdOnLock) : undefined;
  try {
    await execute();
    const refusal = lock?.refusal();
    if (refusal) throw new ConversationTurnError(refusal, threadLocked);
    if (failure) throw failure;
  } finally {
    subscription.unsubscribe();
    lock?.unsubscribe();
  }
}
