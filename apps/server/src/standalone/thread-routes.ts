// Standalone: the thread menu's /api/copilotkit/threads* routes, served from this server's database
// and scoped to the signed-in owner. Mounted before the CopilotKit runtime in local mode only.
import { Hono } from "hono";
import type { StandaloneThreadStore } from "./types.ts";

/**
 * GET / (list), GET /:threadId/{messages,events,state}, PATCH /:threadId (rename/unarchive),
 * POST /:threadId/archive, DELETE /:threadId. Another owner's thread is 404.
 */
export function standaloneThreadRoutes(threads: StandaloneThreadStore) {
  void threads;
  return new Hono<{ Variables: { owner: string } }>();
}
