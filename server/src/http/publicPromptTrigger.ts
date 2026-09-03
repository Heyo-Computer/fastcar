import type { FastifyInstance, FastifyReply } from "fastify";
import { PUBLIC_PROMPT_TRIGGER_PREFIX, type ThreadManager } from "../threads/manager.js";

/**
 * The canonical, unauthenticated prompt-thread trigger endpoint:
 *
 *   POST /pt/:threadId              -> re-run a prompt thread
 *
 * The thread id identifies the thread; the secret trigger token is sent as a
 * `Bearer` token (or `X-Trigger-Token` header). The token is compared in
 * constant time against the stored trigger token (the URL capability).
 *
 * Everything under `/pt/` is meant to be public: deploy/fastcar.json lists the
 * prefix in `auth.public_paths` so app-lb's sign-in gate skips it. There is no
 * listing endpoint here and `/api/*` stays behind the gate.
 */
export function registerPublicPromptTriggerRoutes(app: FastifyInstance, manager: ThreadManager): void {
  app.post<{ Params: { threadId: string } }>(
    `${PUBLIC_PROMPT_TRIGGER_PREFIX}:threadId`,
    async (req, reply): Promise<FastifyReply> => {
      const auth = req.headers.authorization ?? "";
      const headerToken = req.headers["x-trigger-token"];
      const headerVal = Array.isArray(headerToken) ? headerToken[0] : headerToken;
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const token = (bearer || (headerVal ?? "")).trim();

      const result = await manager.triggerPromptThread(req.params.threadId, token);
      switch (result.status) {
        case "accepted":
          return reply.code(202).send({ ok: true, status: "accepted" });
        case "not_found":
          // Treat a non-prompt thread the same as a missing one: a clean 404
          // rather than revealing the thread's type to an unauthenticated caller.
          return reply.code(404).type("text/plain").send("no such prompt thread");
        case "unauthorized":
          return reply.code(401).type("text/plain").send("invalid trigger token");
        case "rate_limited":
          return reply.code(429).send({ error: result.message ?? "rate limited" });
        case "error":
        default:
          return reply.code(500).send({ error: result.message ?? "trigger failed" });
      }
    },
  );
}
