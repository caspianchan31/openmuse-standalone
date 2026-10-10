import "./config.ts";
import { randomUUID } from "node:crypto";
import { MessageSchema } from "@ag-ui/core";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  calendarRangeSchema,
  emailDraftSchema,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import { ActionService } from "./actions.ts";
import { agentConfigured, makeRuntime } from "./agent.ts";
import { createAuth } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { ComputerService, type DockerRunner } from "./computer.ts";
import { computerRoutes } from "./computer-routes.ts";
import { assertApiDeploymentConfig, type Config, chatBackend } from "./config.ts";
import type { Store } from "./db.ts";
import { agentRoutes } from "./engine/routes.ts";
import { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { Files } from "./files.ts";
import { GoogleAuth } from "./google-auth.ts";
import { rateLimit } from "./rate-limit.ts";
import { createStandaloneChat } from "./standalone/index.ts";
import { WorkspaceService } from "./workspace.ts";

export async function createApp(
  db: Store,
  config: Config,
  options: { docker?: DockerRunner } = {},
) {
  assertApiDeploymentConfig(config);
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    workspace = new WorkspaceService(db, config, files, google);
  const actions = new ActionService(db, {
    execute: (owner, input, connectionId, targetVersion) =>
      workspace.execute(owner, input, connectionId, targetVersion),
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner) => workspace.connection(owner),
  });
  const browser = new BrowserService(db, config, auth, files);
  const computer = new ComputerService(db, config, options.docker);
  const agent = new AgentService(db, config, workspace, files, actions, browser, computer);
  // Standalone: with no Intelligence key, chat runs on this server (local runner + thread routes).
  const intelligence =
    chatBackend(config) === "intelligence"
      ? new CopilotKitIntelligence({ apiKey: config.intelligenceApiKey as string })
      : undefined;
  const chat = intelligence ? undefined : await createStandaloneChat({ db, auth, config });
  const runtime = makeRuntime(config, agent, auth, intelligence, chat);
  const app = new Hono<{ Variables: { owner: string } }>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Origin is not allowed" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request is too large; PDFs must be 10 MB or smaller" }, 413),
    }),
  );
  app.use("/api/*", rateLimit(Boolean(config.trustProxy)));
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[OpenMuse] ${error.name}`);
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "Request failed. Check the server setup and try again.",
      },
      502,
    );
  });
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      agentConfigured: agentConfigured(config),
      browserConfigured: Boolean(config.workerUrl && config.workerToken),
    }),
  );
  let loginWindow = 0,
    loginAttempts = 0;
  app.post("/api/session", async (c) => {
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 30)
      throw new AppError("Too many sign-in attempts. Try again in a minute.", 429);
    const body = z.object({ accessKey: z.string().optional() }).parse(await c.req.json());
    const session = await auth.session(body.accessKey);
    await workspace.ensureSample("local-user", actions);
    await agent.ensure("local-user");
    if (config.mode === "sample") await agent.refreshIdeas("local-user");
    return c.json(session);
  });
  app.get("/api/google/callback", async (c) => {
    if (c.req.query("error"))
      return c.html("<h1>Google connection cancelled</h1><p>You can return to OpenMuse.</p>", 400);
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) throw new AppError("Google callback is incomplete");
    await google.callback(state, code);
    return c.html(
      "<h1>Google is connected</h1><p>Return to OpenMuse and refresh your workspace.</p>",
    );
  });
  app.use("/api/*", async (c, next) => {
    const signedRoute =
      /^\/api\/files\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$/.test(
        c.req.path,
      );
    const owner =
      signedRoute && c.req.query("signature")
        ? auth.verify(new URL(c.req.url))
        : await auth.owner(c.req.header("authorization"));
    c.set("owner", owner);
    await next();
  });
  app.get("/api/workspace", async (c) => {
    const [snapshot, reachable] = await Promise.all([
      workspace.snapshot(c.get("owner"), c.req.query("q")),
      browser.reachable(),
    ]);
    snapshot.browsers = snapshot.browsers.map((s) => browser.decorate(c.get("owner"), s));
    // A configured worker that does not answer is offline, not ready.
    snapshot.connections = snapshot.connections.map((connection) =>
      connection.id === "browser" && connection.status === "connected" && !reachable
        ? { ...connection, status: "unavailable" }
        : connection,
    );
    return c.json(snapshot);
  });
  app.route("/api/agent", agentRoutes(agent));
  app.route("/api/computer", computerRoutes(computer, files));
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (query.timeMin && query.timeMax) calendarRangeSchema.parse(query);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/actions", async (c) => {
    const input = proposalSchema.parse(await c.req.json());
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    return c.json(await actions.propose(c.get("owner"), input), 201);
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema
      .extend({ id: z.string().uuid().optional() })
      .parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("Draft not found", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  app.get("/api/main-thread", async (c) => {
    const owner = c.get("owner");
    await db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
      existing: false,
    });
    const main = await db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("Main conversation could not be loaded", 503);
    try {
      // Standalone: local mode records the main thread in this server's database.
      if (!intelligence) await chat?.ensureThread(owner, main.threadId, "default");
      else
        await intelligence.getOrCreateThread({
          threadId: main.threadId,
          userId: owner,
          agentId: "default",
        });
    } catch {
      throw new AppError(
        "Main conversation is unavailable. Check the Rich Threads connection and try again.",
        502,
      );
    }
    return c.json({ threadId: main.threadId, existing: true });
  });
  app.get("/api/conversation", async (c) =>
    c.json((await db.get(c.get("owner"), "conversations", "default")) ?? { messages: [] }),
  );
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const messages = z.array(z.unknown()).max(1000).parse(body.messages);
    for (const message of messages) MessageSchema.parse(message);
    await db.put(c.get("owner"), "conversations", { id: "default", messages });
    return c.json({ ok: true });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a PDF file");
    return c.json(
      await files.import(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  app.post("/api/browsers", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.create(c.get("owner"), body.url), 201);
  });
  app.get("/api/browsers/:id", async (c) => {
    const owner = c.get("owner");
    return c.json(browser.decorate(owner, await browser.get(owner, c.req.param("id"))));
  });
  app.post("/api/browsers/:id/navigate", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.navigate(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/close", async (c) =>
    c.json(await browser.close(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/read", async (c) =>
    c.json(await browser.read(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/:id/reopen", async (c) => {
    const raw = await c.req.text();
    const body = z.object({ url: z.url().max(4096).optional() }).parse(raw ? JSON.parse(raw) : {});
    return c.json(await browser.reopen(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/import-downloads", async (c) =>
    c.json(await browser.imports(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/preview", async (c) => {
    const response = await browser.preview(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "image/png");
    return c.body(await response.arrayBuffer());
  });
  app.get("/api/browsers/:id/console", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    );
    return c.html(browser.console(c.get("owner"), c.req.param("id")));
  });
  app.post("/api/browsers/:id/console", async (c) => {
    await browser.input(c.get("owner"), c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
  // Standalone: local mode serves the thread menu from this server's database.
  if (chat) app.route("/api/copilotkit/threads", chat.routes);
  app.all("/api/copilotkit/*", async (c) => {
    if (!agentConfigured(config))
      throw new AppError(
        "Configure a model and provider API key, or a valid AG-UI endpoint, to start chat",
        503,
      );
    const response = await runtime.fetch(c.req.raw);
    // Runtime 1.70 emits SSE strings; a WHATWG Response body requires byte chunks.
    const encoder = new TextEncoder();
    const body = response.body?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  });
  app.get("/", (c) =>
    c.json({ name: "OpenMuse", app: "http://localhost:8081", health: "/api/health" }),
  );
  // Standalone: `chat` is set in local mode; close it before the database.
  return { app, auth, files, actions, workspace, agent, computer, chat };
}
