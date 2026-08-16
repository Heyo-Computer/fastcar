import type { FastifyInstance } from "fastify";
import type {
  CommandsResponse,
  MentionsResponse,
  ThreadHistoryResponse,
} from "@fastcar/shared";
import type { Config } from "../config.js";
import { listEvents } from "../db/events.js";
import { getThread, listThreads, toMeta } from "../db/threads.js";
import { collectRepoStatuses, purgeRepo, PurgeRefusedError } from "../services/git.js";
import { searchMentions } from "../services/mentions.js";
import { transcribeAudio } from "../services/transcription.js";
import { COMMAND_SPECS } from "../threads/commands.js";

export function registerRoutes(app: FastifyInstance, cfg: Config): void {
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
}
