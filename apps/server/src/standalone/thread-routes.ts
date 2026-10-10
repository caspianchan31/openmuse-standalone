// Standalone: the thread menu's /api/copilotkit/threads* routes, served from this server's database
// and scoped to the signed-in owner. Mounted before the CopilotKit runtime in local mode only.
import type { BaseEvent } from "@ag-ui/client";
import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { messagesFromEvents, stateFromEvents, toWireMessages } from "./events.ts";
import { threadLockedMessage } from "./runtime-hooks.ts";
import { type StandaloneThreadStore, threadLockedCode, type WireMessage } from "./types.ts";

/** How stored events become the /messages and /state bodies (the runtime's local mapping). */
export interface ThreadView {
  messages(events: BaseEvent[]): WireMessage[];
  state(events: BaseEvent[]): Record<string, unknown> | null;
}

export const defaultThreadView: ThreadView = {
  messages: (events) => toWireMessages(messagesFromEvents(events)),
  state: (events) => stateFromEvents(events),
};

const agentId = z
  .string({ error: "agentId is required" })
  .min(1, "agentId is required")
  .max(128, "agentId is too long");
const threadId = z.string().min(1).max(256, "Thread id is too long");
const listQuery = z.object({
  agentId,
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
const mutationBody = z.object({ agentId });
const patchBody = z.object({
  agentId,
  name: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
});

/** Validation failures are 400 here (the runtime's thread routes answer 400 too). */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(result.error.issues.map((issue) => issue.message).join("; "), 400);
  return result.data;
}

const notFound = () => new AppError("Thread not found", 404);

/**
 * GET / (list), GET /:threadId/{messages,events,state}, PATCH /:threadId (rename/unarchive),
 * POST /:threadId/archive, DELETE /:threadId. Another owner's thread is 404. Owner-like fields in
 * the query or body (userId) are ignored: the owner is always the authenticated session's.
 */
export function standaloneThreadRoutes(
  threads: StandaloneThreadStore,
  view: ThreadView = defaultThreadView,
) {
  const routes = new Hono<{ Variables: { owner: string } }>();

  async function eventsOf(owner: string, id: string) {
    const events = await threads.threadEvents(owner, parse(threadId, id));
    if (!events) throw notFound();
    return events;
  }

  routes.get("/", async (c) => {
    const query = parse(listQuery, c.req.query());
    try {
      return c.json(
        await threads.listThreads(c.get("owner"), {
          agentId: query.agentId,
          includeArchived: c.req.query("includeArchived") === "true",
          limit: query.limit ?? 50,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "CursorError")
        throw new AppError("Invalid cursor", 400);
      throw error;
    }
  });
  routes.get("/:threadId/messages", async (c) => {
    const events = await eventsOf(c.get("owner"), c.req.param("threadId"));
    return c.json({ messages: view.messages(events) });
  });
  routes.get("/:threadId/events", async (c) =>
    c.json({ events: await eventsOf(c.get("owner"), c.req.param("threadId")) }),
  );
  routes.get("/:threadId/state", async (c) => {
    const events = await eventsOf(c.get("owner"), c.req.param("threadId"));
    return c.json({ state: view.state(events) });
  });
  routes.patch("/:threadId", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const body = parse(patchBody, await c.req.json());
    const thread = await threads.updateThread(c.get("owner"), id, body.agentId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
    });
    if (!thread) throw notFound();
    return c.json(thread);
  });
  routes.post("/:threadId/archive", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const body = parse(mutationBody, await c.req.json());
    if (!(await threads.updateThread(c.get("owner"), id, body.agentId, { archived: true })))
      throw notFound();
    return c.json({ threadId: id, archived: true });
  });
  routes.delete("/:threadId", async (c) => {
    const id = parse(threadId, c.req.param("threadId"));
    const body = parse(mutationBody, await c.req.json());
    const result = await threads.deleteThread(c.get("owner"), id, body.agentId);
    if (result === "not_found") throw notFound();
    if (result === "running")
      return c.json({ error: threadLockedMessage, code: threadLockedCode }, 409);
    return c.json({ threadId: id, deleted: true });
  });
  return routes;
}
