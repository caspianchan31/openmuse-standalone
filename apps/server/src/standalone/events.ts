// Standalone: pure helpers over AG-UI events for the local chat store.
import type { BaseEvent, Message } from "@ag-ui/client";
import { notImplemented } from "./chat-store.ts";
import type { WireMessage } from "./types.ts";

/**
 * The persisted form of one run: compacted, RUN_STARTED first with input reduced to
 * { threadId, runId, messages } (only messages new to the thread).
 */
export function persistedRunEvents(
  events: BaseEvent[],
  run: { threadId: string; runId: string; newMessages: Message[] },
): BaseEvent[] {
  void [events, run];
  return notImplemented("persistedRunEvents");
}

/** Every messageId in the events plus RUN_STARTED input message ids. */
export function messageIdsOf(events: BaseEvent[]): string[] {
  void events;
  return notImplemented("messageIdsOf");
}

/** Conversation messages rebuilt from compacted events (closed runs, in order). */
export function messagesFromEvents(events: BaseEvent[]): Message[] {
  void events;
  return notImplemented("messagesFromEvents");
}

/** The runtime's /threads/:id/messages mapping (assistant tool calls become {id,name,args}). */
export function toWireMessages(messages: Message[]): WireMessage[] {
  void messages;
  return notImplemented("toWireMessages");
}

/** The latest STATE_SNAPSHOT in the events, or null. */
export function stateFromEvents(events: BaseEvent[]): Record<string, unknown> | null {
  void events;
  return notImplemented("stateFromEvents");
}
