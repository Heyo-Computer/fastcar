import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { closePool } from "./db/pool.js";
import { resetTransientStatuses } from "./db/threads.js";
import { buildModels } from "./pi/runtime.js";
import { SubagentManager } from "./pi/subagents.js";
import { ThreadManager } from "./threads/manager.js";
import { registerRoutes } from "./http/routes.js";
import { registerPublicArtifactRoutes } from "./http/publicArtifacts.js";
import { registerWs } from "./ws/handler.js";
import { ArtifactService } from "./services/artifacts.js";
import { EmailService } from "./services/emailService.js";
import { AppSettings } from "./services/appSettings.js";
import { SubagentSettings } from "./services/subagentSettings.js";
import { McpManager } from "./services/mcp.js";
import { startMockOpenAI } from "./dev/mock-openai.js";

const cfg = loadConfig();
const mockServer = cfg.mock ? await startMockOpenAI(cfg.mockPort) : undefined;

await migrate();
// Questions/runs from a previous process cannot be resumed; unstick their threads.
await resetTransientStatuses();

const models = await buildModels(cfg);
const mcp = new McpManager(cfg);
const subagentSettings = new SubagentSettings(cfg);
const subagents = new SubagentManager(models, cfg, mcp, subagentSettings);
const artifacts = new ArtifactService(cfg);
const email = new EmailService(cfg);
const settings = new AppSettings(cfg);
const manager = new ThreadManager(cfg, models, subagents, email, artifacts, mcp, settings);
// Installed servers reconnect in the background; a broken one shows as "error" in the panel.
await mcp.start();

const app = Fastify({ logger: { level: "info" } });
await app.register(fastifyWebsocket);
await app.register(fastifyMultipart);

registerRoutes(app, cfg, { artifacts, email, mcp, settings, subagentSettings });
// Public, unauthenticated artifact pages (see deploy/fastcar.json auth.public_paths).
registerPublicArtifactRoutes(app, artifacts);
registerWs(app, manager, cfg);

// Serve the built web UI in production (web/dist); Vite dev server proxies to us in dev.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/ws") || req.raw.url?.startsWith("/artifacts/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  await manager.shutdown().catch(() => {});
  await mcp.shutdown().catch(() => {});
  await app.close().catch(() => {});
  mockServer?.close();
  await closePool().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: cfg.port, host: "0.0.0.0" });
console.log(
  `fastcar listening on :${cfg.port} (mock=${cfg.mock}, workdir=${cfg.workdir})`,
);
