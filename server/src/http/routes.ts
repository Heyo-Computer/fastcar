import type { FastifyInstance } from "fastify";
import type { ThreadHistoryResponse } from "@fastcar/shared";
import type { Config } from "../config.js";
import { listEvents } from "../db/events.js";
import { getThread, listThreads, toMeta } from "../db/threads.js";
import { collectRepoStatuses } from "../services/git.js";
import { transcribeAudio } from "../services/transcription.js";

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
