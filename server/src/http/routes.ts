import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  CronPreviewResponse,
  InboxFilter,
  InboxResponse,
  AppSettingsRequest,
  AppSettingsResponse,
  ArtifactNode,
  ArtifactResponse,
  ArtifactsTreeResponse,
  CommandsResponse,
  CreateArtifactResponse,
  InstallMcpRequest,
  McpServersResponse,
  MentionsResponse,
  PromptTemplatesResponse,
  SmtpSettingsRequest,
  SmtpSettingsResponse,
  SubagentSettingsRequest,
  SubagentSettingsResponse,
  ThreadHistoryResponse,
} from "@fastcar/shared";
import type { Config } from "../config.js";
import { listEvents } from "../db/events.js";
import { getThread, listThreads } from "../db/threads.js";
import { threadMeta } from "../services/threadMeta.js";
import { inboxCounts, listInbox } from "../db/inbox.js";
import { listArtifactsForAgent } from "../db/artifacts.js";
import {
  previewRuns,
  ScheduleValidationError,
  validateCron,
  type Scheduler,
} from "../services/scheduler.js";
import { collectRepoStatuses, purgeRepo, PurgeRefusedError } from "../services/git.js";
import { searchMentions } from "../services/mentions.js";
import { transcribeAudio } from "../services/transcription.js";
import { COMMAND_SPECS } from "../threads/commands.js";
import { listTools } from "../tools/registry.js";
import type { ThreadManager } from "../threads/manager.js";
import { callerFromRequest } from "./auth.js";
import { loadPromptTemplates } from "../services/promptTemplates.js";
import type { ArtifactService } from "../services/artifacts.js";
import type { EmailService } from "../services/emailService.js";
import type { McpManager } from "../services/mcp.js";
import type { AppSettings } from "../services/appSettings.js";
import type { SubagentSettings } from "../services/subagentSettings.js";
import { AgentValidationError, type AgentService } from "../services/agents.js";
import { listAgentModels } from "../pi/runtime.js";
import type { FastcarModels } from "../pi/runtime.js";

export interface RouteDeps {
  artifacts: ArtifactService;
  email: EmailService;
  mcp?: McpManager;
  settings?: AppSettings;
  subagentSettings?: SubagentSettings;
  /**
   * Thread manager — required for the prompt-thread create endpoint (Feature 3).
   * Optional so unit tests that only exercise artifact/subagent routes can omit
   * it; the create endpoint returns 503 when it is absent.
   */
  manager?: ThreadManager;
  /** Agent registry. Optional so narrow unit tests can omit it. */
  agents?: AgentService;
  /** Shared model runtime, for the agent builder's model picker. */
  models?: FastcarModels;
  /** Cron scheduler. Optional so narrow unit tests can omit it. */
  scheduler?: Scheduler;
}

export function registerRoutes(
  app: FastifyInstance,
  cfg: Config,
  deps: RouteDeps,
): void {
  app.get("/api/health", async () => ({ ok: true, mock: cfg.mock }));

  app.get<{ Querystring: { agentId?: string; limit?: string } }>("/api/threads", async (req) => {
    const threads = await listThreads({
      agentId: req.query.agentId,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    return { threads: threads.map((t) => threadMeta(cfg, t)) };
  });

  app.get<{ Params: { id: string } }>("/api/threads/:id/events", async (req, reply) => {
    const thread = await getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: "no such thread" });
    const events = await listEvents(req.params.id);
    const res: ThreadHistoryResponse = {
      thread: threadMeta(cfg, thread),
      events,
      pending: thread.pending,
    };
    return res;
  });

  app.get("/api/repos", async () => ({ repos: await collectRepoStatuses() }));

  // ---------------------------------------------------------------- MCP servers
  app.get("/api/mcp", async (): Promise<McpServersResponse> => ({
    servers: deps.mcp ? await deps.mcp.statuses() : [],
  }));

  /** Install directly (the sidebar form); agents use the mcp_install tool instead. */
  app.post<{ Body: InstallMcpRequest }>("/api/mcp", async (req, reply) => {
    if (!deps.mcp) return reply.code(503).send({ error: "MCP is not enabled" });
    if (!callerFromRequest(cfg, req).isAdmin) return reply.code(403).send({ error: "admin only" });
    const body = req.body ?? ({} as InstallMcpRequest);
    if (!body.source?.trim()) return reply.code(400).send({ error: "source is required" });
    try {
      return { server: await deps.mcp.install(body) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete<{ Params: { name: string } }>("/api/mcp/:name", async (req, reply) => {
    if (!deps.mcp) return reply.code(503).send({ error: "MCP is not enabled" });
    if (!callerFromRequest(cfg, req).isAdmin) return reply.code(403).send({ error: "admin only" });
    try {
      return await deps.mcp.remove(req.params.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(message.startsWith("No MCP server") ? 404 : 400).send({ error: message });
    }
  });

  /**
   * Purge a repository: delete the clone and drop it from the registry.
   * 409 means it still holds unsaved work — retry with ?force=1 to delete it.
   */
  app.delete<{ Params: { name: string }; Querystring: { force?: string } }>(
    "/api/repos/:name",
    async (req, reply) => {
      const force = req.query.force === "1" || req.query.force === "true";
      try {
        return await purgeRepo(cfg, req.params.name, { force });
      } catch (err) {
        if (err instanceof PurgeRefusedError) {
          return reply.code(409).send({ error: err.message, reasons: err.reasons });
        }
        if (err instanceof Error && err.message.startsWith("No registered repository")) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  /** Backs the composer's `/` menu. */
  app.get("/api/commands", async (): Promise<CommandsResponse> => ({ commands: COMMAND_SPECS }));

  // The agent builder's tool checklist. Ungated like /api/commands: knowing
  // which tools exist is not privileged, and the builder needs it before the
  // user has an agent to save.
  // --- schedules -----------------------------------------------------------

  app.get<{ Querystring: { agentId?: string } }>("/api/schedules", async (req, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: "scheduler is not enabled" });
    return { schedules: await deps.scheduler.list(req.query.agentId) };
  });

  /** Validate a cron expression and show what it actually means. */
  app.get<{ Querystring: { cron?: string; timezone?: string } }>(
    "/api/schedules/preview",
    async (req): Promise<CronPreviewResponse> => {
      const cron = req.query.cron ?? "";
      const timezone = req.query.timezone ?? "UTC";
      const v = validateCron(cron, timezone);
      if (!v.ok) return { valid: false, error: v.error, nextRuns: [] };
      return { valid: true, nextRuns: previewRuns(cron, timezone, 5) };
    },
  );

  app.post("/api/schedules", async (req, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: "scheduler is not enabled" });
    const caller = callerFromRequest(cfg, req);
    if (!caller.isAdmin) return reply.code(403).send({ error: "admin only" });
    try {
      const rec = await deps.scheduler.create(req.body as never, caller.ownerId ?? null);
      return reply.code(201).send({ schedule: deps.scheduler.toWire(rec) });
    } catch (err) {
      if (err instanceof ScheduleValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: "scheduler is not enabled" });
    if (!callerFromRequest(cfg, req).isAdmin) return reply.code(403).send({ error: "admin only" });
    try {
      const rec = await deps.scheduler.update(req.params.id, req.body as never);
      return { schedule: deps.scheduler.toWire(rec) };
    } catch (err) {
      if (err instanceof ScheduleValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: "scheduler is not enabled" });
    if (!callerFromRequest(cfg, req).isAdmin) return reply.code(403).send({ error: "admin only" });
    await deps.scheduler.remove(req.params.id);
    return { ok: true };
  });

  /** Manual "run now" — the same path a tick takes, minus the due check. */
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: "scheduler is not enabled" });
    if (!callerFromRequest(cfg, req).isAdmin) return reply.code(403).send({ error: "admin only" });
    const result = await deps.scheduler.runNow(req.params.id);
    if ("skipped" in result) return reply.code(409).send({ error: result.skipped });
    return reply.code(202).send(result);
  });

  // --- inbox ---------------------------------------------------------------

  app.get<{ Querystring: { agentId?: string; filter?: InboxFilter; limit?: string } }>(
    "/api/inbox",
    async (req): Promise<InboxResponse> => {
      const [items, counts] = await Promise.all([
        listInbox({
          agentId: req.query.agentId,
          filter: req.query.filter,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          publicUrlBase: cfg.publicUrl,
        }),
        inboxCounts(),
      ]);
      return { items, ...counts };
    },
  );

  app.post<{ Params: { threadId: string } }>("/api/inbox/:threadId/read", async (req, reply) => {
    if (!deps.manager) return reply.code(503).send({ error: "thread manager is not available" });
    await deps.manager.markRead(req.params.threadId);
    return { ok: true };
  });

  app.post<{ Querystring: { agentId?: string } }>("/api/inbox/read-all", async (req, reply) => {
    if (!deps.manager) return reply.code(503).send({ error: "thread manager is not available" });
    await deps.manager.markAllRead(req.query.agentId);
    return { ok: true };
  });

  // --- agents --------------------------------------------------------------
  // Reads are ungated (the builder needs them before anything is saved);
  // writes are admin-only, matching /api/mcp and /api/settings.

  app.get("/api/agents", async (_req, reply) => {
    if (!deps.agents) return reply.code(503).send({ error: "agents are not enabled" });
    const rows = await deps.agents.list(true);
    return { agents: rows.map((r) => deps.agents!.toDef(r)) };
  });

  app.post("/api/agents", async (req, reply) => {
    if (!deps.agents) return reply.code(503).send({ error: "agents are not enabled" });
    const caller = callerFromRequest(cfg, req);
    if (!caller.isAdmin) return reply.code(403).send({ error: "admin only" });
    try {
      const rec = await deps.agents.create(req.body as never, caller.ownerId ?? null);
      return reply.code(201).send({ agent: deps.agents.toDef(rec) });
    } catch (err) {
      if (err instanceof AgentValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    if (!deps.agents) return reply.code(503).send({ error: "agents are not enabled" });
    if (!callerFromRequest(cfg, req).isAdmin) return reply.code(403).send({ error: "admin only" });
    try {
      const rec = await deps.agents.update(req.params.id, req.body as never);
      return { agent: deps.agents.toDef(rec) };
    } catch (err) {
      if (err instanceof AgentValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { archive?: string } }>(
    "/api/agents/:id",
    async (req, reply) => {
      if (!deps.agents) return reply.code(503).send({ error: "agents are not enabled" });
      if (!callerFromRequest(cfg, req).isAdmin) return reply.code(403).send({ error: "admin only" });
      try {
        if (req.query.archive === "1") {
          return { agent: deps.agents.toDef(await deps.agents.archive(req.params.id)) };
        }
        await deps.agents.delete(req.params.id);
        return { ok: true };
      } catch (err) {
        if (err instanceof AgentValidationError) {
          // 409, not 400: the request is well formed, the agent is just still
          // in use. The UI turns this into an "Archive instead?" prompt.
          return reply.code(409).send({ error: err.message, canArchive: true });
        }
        throw err;
      }
    },
  );

  /** Everything this agent has published, newest first — its "Output" tab. */
  app.get<{ Params: { id: string } }>("/api/agents/:id/artifacts", async (req) => {
    const rows = await listArtifactsForAgent(req.params.id);
    return {
      artifacts: rows.map((r) => ({
        ...r,
        publicUrl: deps.artifacts.publicUrl(r),
        children: [],
      })),
    };
  });

  app.get("/api/models", async (_req, reply) => {
    if (!deps.models) return reply.code(503).send({ error: "model runtime is not available" });
    return listAgentModels(deps.models.runtime, cfg);
  });

  app.get("/api/tools", async () => ({
    tools: listTools({
      email: Boolean(deps.email),
      artifacts: Boolean(deps.artifacts),
      mcp: Boolean(deps.mcp),
    }),
  }));

  /** Backs the composer's `@` menu; queried on every keystroke. */
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/mentions",
    async (req): Promise<MentionsResponse> => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
      return { items: await searchMentions(cfg, req.query.q ?? "", limit) };
    },
  );

  app.post("/api/transcribe", async (req, reply) => {
    const file = await req.file({ limits: { fileSize: 25 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: "no audio file uploaded" });
    const buffer = await file.toBuffer();
    const text = await transcribeAudio(cfg, {
      buffer,
      filename: file.filename || "recording.webm",
      mimetype: file.mimetype || "audio/webm",
    });
    return { text };
  });

  // ------------------------------------------------------------------ artifacts

  /** POST /api/threads/:threadId/artifacts — multipart upload or JSON markdown body. */
  app.post<{ Params: { threadId: string } }>(
    "/api/threads/:threadId/artifacts",
    async (req, reply): Promise<CreateArtifactResponse | FastifyReply> => {
      const caller = callerFromRequest(cfg, req);
      const allowed = await deps.artifacts.canCreateArtifact(
        req.params.threadId,
        caller.ownerId,
        caller.isAdmin,
      );
      if (!allowed) return reply.code(403).send({ error: "not allowed to create artifacts on this thread" });

      const parentArtifactId =
        (req.body as { parentArtifactId?: string } | undefined)?.parentArtifactId ?? null;

      // Multipart upload: a file field.
      const contentTypeHdr = req.headers["content-type"] ?? "";
      if (contentTypeHdr.startsWith("multipart/")) {
        const file = await req.file({ limits: { fileSize: 50 * 1024 * 1024 } });
        if (!file) return reply.code(400).send({ error: "no file uploaded" });
        const buffer = await file.toBuffer();
        const artifact = await deps.artifacts.createFromBuffer(
          req.params.threadId,
          file.filename || "artifact",
          buffer,
          file.mimetype || "application/octet-stream",
          parentArtifactId,
          caller.ownerId,
        );
        return { artifact };
      }

      // JSON body: { name, content, contentType?, parentArtifactId? }
      const body = req.body as {
        name?: string;
        content?: string;
        contentType?: string;
      } | null;
      if (!body || !body.name || body.content === undefined) {
        return reply.code(400).send({ error: "body must include name and content" });
      }
      const artifact = await deps.artifacts.createFromText(
        req.params.threadId,
        body.name,
        body.content,
        body.contentType || "text/markdown",
        parentArtifactId,
        caller.ownerId,
      );
      return { artifact };
    },
  );

  /** GET /api/threads/:threadId/artifacts — the artifact tree for a thread. */
  app.get<{ Params: { threadId: string } }>(
    "/api/threads/:threadId/artifacts",
    async (req, reply): Promise<ArtifactsTreeResponse | FastifyReply> => {
      const thread = await getThread(req.params.threadId);
      if (!thread) return reply.code(404).send({ error: "no such thread" });
      const artifacts = await deps.artifacts.listTree(req.params.threadId);
      return { artifacts };
    },
  );

  /** GET /api/artifacts/:artifactId — fetch a single artifact (text inline). */
  app.get<{ Params: { artifactId: string } }>(
    "/api/artifacts/:artifactId",
    async (req, reply): Promise<ArtifactResponse | FastifyReply> => {
      const rec = await deps.artifacts.getArtifact(req.params.artifactId);
      if (!rec) return reply.code(404).send({ error: "no such artifact" });
      const content = rec.contentType.startsWith("text/")
        ? ((await deps.artifacts.readContent(rec.id))?.toString("utf8") ?? undefined)
        : undefined;
      const response: ArtifactResponse = {
        id: rec.id,
        threadId: rec.threadId,
        parentArtifactId: rec.parentArtifactId,
        name: rec.name,
        contentType: rec.contentType,
        size: rec.size,
        ownerId: rec.ownerId,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        content,
        storagePath: rec.storagePath,
        publicUrl: deps.artifacts.publicUrl(rec),
      };
      return response;
    },
  );

  /** DELETE /api/artifacts/:artifactId — remove an artifact (and its subtree). */
  app.delete<{ Params: { artifactId: string } }>(
    "/api/artifacts/:artifactId",
    async (req, reply) => {
      const ok = await deps.artifacts.delete(req.params.artifactId);
      if (!ok) return reply.code(404).send({ error: "no such artifact" });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ prompts

  /** GET /api/prompt-templates — the predefined prompt templates (Feature 3). */
  app.get("/api/prompt-templates", async (): Promise<PromptTemplatesResponse> => ({
    templates: loadPromptTemplates(),
  }));

  /**
   * POST /api/threads/prompt — create a prompt thread (admin only). Mirrors the
   * `create_prompt_thread` WS message: resolve a template, run the LLM, POST the
   * result to the webhook, and record delivery status. Returns the thread meta
   * (with its public trigger URL).
   */
  app.post("/api/threads/prompt", async (req, reply) => {
    if (!deps.manager) return reply.code(503).send({ error: "prompt threads not available" });
    const caller = callerFromRequest(cfg, req);
    if (!caller.isAdmin) return reply.code(403).send({ error: "admin only" });
    const body = req.body as {
      title?: string;
      templateId?: string;
      variables?: Record<string, string>;
      webhookUrl?: string;
      webhookToken?: string;
    } | null;
    if (!body || !body.templateId || !body.webhookUrl) {
      return reply.code(400).send({ error: "templateId and webhookUrl are required" });
    }
    try {
      const thread = await deps.manager.createPromptThread({
        title: body.title,
        templateId: body.templateId,
        variables: body.variables,
        webhookUrl: body.webhookUrl,
        webhookToken: body.webhookToken ?? "",
      });
      return reply.code(201).send({ thread });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /no such prompt template|webhook URL invalid|rate limit/.test(message) ? 400 : 500;
      return reply.code(code).send({ error: message });
    }
  });

  // -------------------------------------------------------------- settings

  /** GET /api/settings — conductor model + reasoning effort. Nothing secret; any caller. */
  app.get("/api/settings", async (_req, reply): Promise<AppSettingsResponse | FastifyReply> => {
    if (!deps.settings) return reply.code(404).send({ error: "settings not available" });
    return deps.settings.get();
  });

  /** POST /api/settings — persist; live conductors pick the change up next turn. Admin only. */
  app.post("/api/settings", async (req, reply): Promise<AppSettingsResponse | FastifyReply> => {
    if (!deps.settings) return reply.code(404).send({ error: "settings not available" });
    const caller = callerFromRequest(cfg, req);
    if (!caller.isAdmin) return reply.code(403).send({ error: "admin only" });
    const body = req.body as AppSettingsRequest | null;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "invalid body" });
    try {
      return deps.settings.update(body);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ------------------------------------------------------- subagent models

  /** GET /api/subagent-models — subagent provider + per-kind model overrides. */
  app.get("/api/subagent-models", async (_req, reply): Promise<SubagentSettingsResponse | FastifyReply> => {
    if (!deps.subagentSettings) return reply.code(404).send({ error: "subagent settings not available" });
    return deps.subagentSettings.get();
  });

  /** POST /api/subagent-models — persist; the next subagent run picks it up. Admin only. */
  app.post("/api/subagent-models", async (req, reply): Promise<SubagentSettingsResponse | FastifyReply> => {
    if (!deps.subagentSettings) return reply.code(404).send({ error: "subagent settings not available" });
    const caller = callerFromRequest(cfg, req);
    if (!caller.isAdmin) return reply.code(403).send({ error: "admin only" });
    const body = req.body as SubagentSettingsRequest | null;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "invalid body" });
    try {
      return deps.subagentSettings.update(body);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ------------------------------------------------------------------ smtp

  /** GET /api/smtp — SMTP settings (password never returned). Admin only. */
  app.get("/api/smtp", async (req, reply): Promise<SmtpSettingsResponse | FastifyReply> => {
    const caller = callerFromRequest(cfg, req);
    if (!caller.isAdmin) return reply.code(403).send({ error: "admin only" });
    return deps.email.getSettings();
  });

  /** POST /api/smtp — persist SMTP settings. Admin only. */
  app.post("/api/smtp", async (req, reply): Promise<SmtpSettingsResponse | FastifyReply> => {
    const caller = callerFromRequest(cfg, req);
    if (!caller.isAdmin) return reply.code(403).send({ error: "admin only" });
    const body = req.body as SmtpSettingsRequest | null;
    if (!body || !body.host || !body.fromAddress) {
      return reply.code(400).send({ error: "host and fromAddress are required" });
    }
    return deps.email.saveSettings(body);
  });
}
