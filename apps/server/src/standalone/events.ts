// Standalone: pure helpers over AG-UI events for the local chat store.
import {
  type ActivitySnapshotEvent,
  type BaseEvent,
  compactEvents,
  EventType,
  type Message,
  type MessagesSnapshotEvent,
  type ReasoningMessageStartEvent,
  type RunStartedEvent,
  type TextMessageStartEvent,
  type ToolCall,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/client";
import type { WireMessage } from "./types.ts";

type Loose = BaseEvent & Record<string, unknown>;

/**
 * The persisted RUN_STARTED input: only the messages new to the thread. tools and context stay as
 * empty arrays because clients validate RUN_STARTED.input against RunAgentInput on replay.
 */
export function storedRunInput(run: { threadId: string; runId: string; newMessages: Message[] }) {
  return {
    threadId: run.threadId,
    runId: run.runId,
    messages: run.newMessages,
    tools: [],
    context: [],
  };
}

/** A RUN_STARTED carrying the stored input (used when the agent emitted none, and at run begin). */
export function startedEvent(run: {
  threadId: string;
  runId: string;
  newMessages: Message[];
}): BaseEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId: run.threadId,
    runId: run.runId,
    input: storedRunInput(run),
  } as BaseEvent;
}

/**
 * finalizeRunEvents appends a bare RUN_FINISHED; clients require threadId and runId on it, so
 * terminal events get the run's identity when they lack one. Other events pass through.
 */
export function withRunIdentity(event: BaseEvent, threadId: string, runId: string): BaseEvent {
  if (event.type !== EventType.RUN_FINISHED) return event;
  const loose = event as Loose;
  if (typeof loose.threadId === "string" && typeof loose.runId === "string") return event;
  return {
    ...event,
    threadId: loose.threadId ?? threadId,
    runId: loose.runId ?? runId,
  } as BaseEvent;
}

/**
 * The persisted form of one run: compacted, RUN_STARTED first with input reduced to
 * { threadId, runId, messages (only those new to the thread), tools: [], context: [] }, and every
 * RUN_FINISHED carrying the run's threadId and runId.
 */
export function persistedRunEvents(
  events: BaseEvent[],
  run: { threadId: string; runId: string; newMessages: Message[] },
): BaseEvent[] {
  const out: BaseEvent[] = [];
  for (const event of compactEvents(events)) {
    if (event.type !== EventType.RUN_STARTED) {
      out.push(withRunIdentity(event, run.threadId, run.runId));
      continue;
    }
    const { input: _input, ...rest } = event as RunStartedEvent;
    if (out.length === 0) {
      out.push({
        ...rest,
        threadId: rest.threadId ?? run.threadId,
        runId: rest.runId ?? run.runId,
        input: storedRunInput(run),
      } as BaseEvent);
    } else {
      out.push(rest as BaseEvent);
    }
  }
  if (out[0]?.type !== EventType.RUN_STARTED) out.unshift(startedEvent(run));
  return out;
}

/** Every messageId in the events plus RUN_STARTED input message ids. */
export function messageIdsOf(events: BaseEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const messageId = (event as Loose).messageId;
    if (typeof messageId === "string") ids.add(messageId);
    if (event.type === EventType.RUN_STARTED) {
      const messages = (event as RunStartedEvent).input?.messages;
      if (Array.isArray(messages)) {
        for (const message of messages) if (typeof message?.id === "string") ids.add(message.id);
      }
    }
  }
  return [...ids];
}

type Mutable = Message & {
  content?: unknown;
  toolCalls?: ToolCall[];
};

/** Conversation messages rebuilt from compacted events (closed runs, in order). */
export function messagesFromEvents(events: BaseEvent[]): Message[] {
  let messages: Mutable[] = [];
  const find = (id: string) => messages.find((message) => message.id === id);
  const owner = (toolCallId: string) =>
    messages.find((message) => message.toolCalls?.some((call) => call.id === toolCallId));
  for (const event of events) {
    const loose = event as Loose;
    switch (event.type) {
      case EventType.RUN_STARTED: {
        const input = (event as RunStartedEvent).input?.messages;
        if (!Array.isArray(input)) break;
        for (const message of input) {
          if (message && typeof message.id === "string" && !find(message.id)) {
            messages.push(structuredClone(message) as Mutable);
          }
        }
        break;
      }
      case EventType.TEXT_MESSAGE_START: {
        const start = event as TextMessageStartEvent;
        if (!find(start.messageId)) {
          messages.push({
            id: start.messageId,
            role: start.role ?? "assistant",
            content: "",
            ...(start.name !== undefined ? { name: start.name } : {}),
          } as Mutable);
        }
        break;
      }
      case EventType.REASONING_MESSAGE_START: {
        const start = event as ReasoningMessageStartEvent;
        if (!find(start.messageId)) {
          messages.push({ id: start.messageId, role: "reasoning", content: "" } as Mutable);
        }
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CONTENT: {
        const message = typeof loose.messageId === "string" ? find(loose.messageId) : undefined;
        if (!message || message.role === "activity" || typeof loose.delta !== "string") break;
        message.content = `${typeof message.content === "string" ? message.content : ""}${loose.delta}`;
        break;
      }
      case EventType.TOOL_CALL_START: {
        const start = event as ToolCallStartEvent;
        const existing = owner(start.toolCallId)?.toolCalls?.find(
          (call) => call.id === start.toolCallId,
        );
        if (existing) {
          existing.function.name = start.toolCallName;
          break;
        }
        let parent: Mutable | undefined;
        if (start.parentMessageId) {
          const found = find(start.parentMessageId);
          if (found?.role === "assistant") parent = found;
          else {
            parent = {
              id: found ? start.toolCallId : start.parentMessageId,
              role: "assistant",
              toolCalls: [],
            } as Mutable;
            messages.push(parent);
          }
        } else {
          parent = { id: start.toolCallId, role: "assistant", toolCalls: [] } as Mutable;
          messages.push(parent);
        }
        parent.toolCalls ??= [];
        parent.toolCalls.push({
          id: start.toolCallId,
          type: "function",
          function: { name: start.toolCallName, arguments: "" },
        });
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const toolCallId = loose.toolCallId;
        if (typeof toolCallId !== "string" || typeof loose.delta !== "string") break;
        const call = owner(toolCallId)?.toolCalls?.find((item) => item.id === toolCallId);
        if (call) call.function.arguments += loose.delta;
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        const result = event as ToolCallResultEvent;
        const message = {
          id: result.messageId,
          role: "tool",
          content: result.content,
          toolCallId: result.toolCallId,
        } as Mutable;
        const index = messages.findIndex(
          (item) =>
            item.role === "assistant" && item.toolCalls?.some((c) => c.id === result.toolCallId),
        );
        if (index === -1) messages.push(message);
        else {
          let at = index + 1;
          while (at < messages.length && messages[at]?.role === "tool") at++;
          messages.splice(at, 0, message);
        }
        break;
      }
      case EventType.MESSAGES_SNAPSHOT: {
        const snapshot = ((event as MessagesSnapshotEvent).messages ?? []).map(
          (message) => structuredClone(message) as Mutable,
        );
        const byId = new Map(snapshot.map((message) => [message.id, message]));
        const hasActivity = snapshot.some((message) => message.role === "activity");
        const hasReasoning = snapshot.some((message) => message.role === "reasoning");
        const keep = (message: Mutable) =>
          (message.role === "activity" && !hasActivity) ||
          (message.role === "reasoning" && !hasReasoning);
        messages = messages
          .filter((message) => keep(message) || byId.has(message.id))
          .map((message) => (keep(message) ? message : (byId.get(message.id) as Mutable)));
        const present = new Set(messages.map((message) => message.id));
        for (const message of snapshot) if (!present.has(message.id)) messages.push(message);
        break;
      }
      case EventType.ACTIVITY_SNAPSHOT: {
        const activity = event as ActivitySnapshotEvent;
        const message = {
          id: activity.messageId,
          role: "activity",
          activityType: activity.activityType,
          content: structuredClone(activity.content),
        } as unknown as Mutable;
        const index = messages.findIndex((item) => item.id === activity.messageId);
        if (index === -1) messages.push(message);
        else if (activity.replace ?? true) messages[index] = message;
        break;
      }
      default:
        break;
    }
  }
  return messages as Message[];
}

/** The runtime's /threads/:id/messages mapping (assistant tool calls become {id,name,args}). */
export function toWireMessages(messages: Message[]): WireMessage[] {
  return messages.map((message): WireMessage => {
    switch (message.role) {
      case "assistant": {
        const toolCalls = message.toolCalls ?? [];
        return {
          id: message.id,
          role: message.role,
          ...(message.content !== undefined ? { content: message.content } : {}),
          ...(toolCalls.length > 0
            ? {
                toolCalls: toolCalls.map((call) => ({
                  id: call.id,
                  name: call.function.name,
                  args: call.function.arguments,
                })),
              }
            : {}),
        };
      }
      case "tool":
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
        };
      default:
        return {
          id: message.id,
          role: message.role,
          ...("content" in message && message.content !== undefined
            ? { content: message.content }
            : {}),
        };
    }
  });
}

/** The latest STATE_SNAPSHOT in the events, or null. */
export function stateFromEvents(events: BaseEvent[]): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as Loose | undefined;
    if (event?.type !== EventType.STATE_SNAPSHOT) continue;
    const snapshot = event.snapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      return { ...(snapshot as Record<string, unknown>) };
    }
    return null;
  }
  return null;
}
