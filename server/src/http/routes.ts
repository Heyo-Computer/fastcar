import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ArtifactNode,
  ArtifactResponse,
  ArtifactsTreeResponse,
  CommandsResponse,
  CreateArtifactResponse,
  MentionsResponse,
  PromptTemplatesResponse,
  SmtpSettingsRequest,
  SmtpSettingsResponse,
  ThreadHistoryResponse,
} from "@fastcar/shared";
import type { Config } from "../config.js";
import { listEvents } from "../db/events.js";
import { getThread, listThreads, toMeta } from "../db/threads.js";
import { collectRepoStatuses, purgeRepo, PurgeRefusedError } from "../services/git.js";
import { searchMentions } from "../services/mentions.js";
import { transcribeAudio } from "../services/transcription.js";
import { COMMAND_SPECS } from "../threads/commands.js";
import { callerFromRequest } from "./auth.js";
import { loadPromptTemplates } from "../services/promptTemplates.js";
import type { ArtifactService } from "../services/artifacts.js";
import type { EmailService } from "../services/emailService.js";

export interface RouteDeps {
  artifacts: ArtifactService;
  email: EmailService;
}

export function registerRoutes(
  app: FastifyInstance,
  cfg: Config,
  deps: RouteDeps = { artifacts: undefined!, email: undefined! },
): void {
  app.get("/api/health", async () => ({ ok: true, mock: cfg.mock }));

  app.get("/api/threads", async () => {
    const threads = await listThreads();
    return { threads: threads.map(toMeta) };
  });

  app.get<{ Params: { id: string } }>("/api/threads/:id/events", async (req, reply) => {
    const thread = await getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: "no such thread" });
    const events = await listEvents(req.params.id);
    const res: ThreadHistoryResponse = {
      thread: toMeta(thread),
      events,
      pending: thread.pending,
    };
    return res;
  });

  app.get("/api/repos", async () => ({ repos: await collectRepoStatuses() }));

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
