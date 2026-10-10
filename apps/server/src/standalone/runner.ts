// Standalone: a persistent AgentRunner for the SSE runtime, backed by ChatStore.
// Implements only the async run/connect/isRunning/stop contract (not LocalThreadEndpointRunner,
// whose synchronous methods a database cannot satisfy); thread listing lives in thread-routes.ts.
import type { BaseEvent } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import type { Observable } from "rxjs";
import { type ChatStore, notImplemented } from "./chat-store.ts";
import type { ClaimResult, LocalRunnerOptions, StandaloneRunControl } from "./types.ts";

export class LocalAgentRunner extends AgentRunner implements StandaloneRunControl {
  constructor(
    readonly store: ChatStore,
    readonly options: LocalRunnerOptions = {},
  ) {
    super();
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    void request;
    return notImplemented("LocalAgentRunner.run");
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    void request;
    return notImplemented("LocalAgentRunner.connect");
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    void request;
    return notImplemented("LocalAgentRunner.isRunning");
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    void request;
    return notImplemented("LocalAgentRunner.stop");
  }

  async claim(input: {
    owner: string;
    threadId: string;
    agentId: string;
    runId: string;
  }): Promise<ClaimResult> {
    void input;
    return notImplemented("LocalAgentRunner.claim");
  }

  async release(threadId: string, runId: string): Promise<void> {
    void [threadId, runId];
    return notImplemented("LocalAgentRunner.release");
  }

  /** Recovers stale runs once, then starts the heartbeat and sweep timers (unref'd). */
  async start(): Promise<void> {
    return notImplemented("LocalAgentRunner.start");
  }

  /** Stops timers and saves in-flight local runs as interrupted, ending their SSE streams. */
  async close(): Promise<void> {
    return notImplemented("LocalAgentRunner.close");
  }
}
