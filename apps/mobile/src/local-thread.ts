// Standalone: connecting to a conversation stored on this server (no Intelligence key).

/** What connectThread needs from the agent (an @ag-ui/client AbstractAgent). */
export interface ResettableAgent {
  setMessages(messages: []): void;
  setState(state: Record<string, never>): void;
}

/**
 * Connects the agent to its thread, as `copilotkit.connectAgent({ agent })`. A server without an
 * Intelligence key replays the whole thread on every connect (there is no replay cursor), while
 * CopilotKit clears the agent only on the first connect to a thread. A second connect (Retry after
 * a failed load, or opening the thread again) would append the replay to the messages already
 * shown, doubling their text, so with local threads the agent is cleared first.
 */
export function connectThread<A extends ResettableAgent, R>(
  copilotkit: { connectAgent(input: { agent: A }): Promise<R> },
  agent: A,
  localThreads: boolean,
): Promise<R> {
  if (localThreads) {
    agent.setMessages([]);
    agent.setState({});
  }
  return copilotkit.connectAgent({ agent });
}
