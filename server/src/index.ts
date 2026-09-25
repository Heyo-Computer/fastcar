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
import { registerPublicPromptTriggerRoutes } from "./http/publicPromptTrigger.js";
import { registerWs } from "./ws/handler.js";
import { ArtifactService } from "./services/artifacts.js";
import { EmailService } from "./services/emailService.js";
import { AppSettings } from "./services/appSettings.js";
import { SubagentSettings } from "./services/subagentSettings.js";
import { McpManager } from "./services/mcp.js";
import { SignalService } from "./services/signal.js";
import { AgentService } from "./services/agents.js";
import { adoptUnregisteredRepos } from "./services/git.js";
import { Scheduler } from "./services/scheduler.js";
import { WebhookTokenStore } from "./services/webhookTokens.js";
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
const agents = new AgentService(cfg, settings, mcp);
// Undefined unless SIGNAL_ACCOUNT is set; the signal_* tools are dropped then.
const signalService = SignalService.fromConfig(cfg);
// New deps ride in a trailing options object: the ThreadManager is constructed
// with four positional args in three tests, and growing the positional list
// would break them for no reason.
const manager = new ThreadManager(cfg, models, subagents, email, artifacts, mcp, settings, {
  agents,
  signal: signalService,
});
const scheduler = new Scheduler(manager, agents, new WebhookTokenStore(cfg));
manager.attachScheduler(scheduler);
// Installed servers reconnect in the background; a broken one shows as "error" in the panel.
await mcp.start();
// signal-cli receives from here on; an unlinked account retries on a backoff.
signalService?.start();
// Unwedges schedules left mid-run by a previous process, then starts ticking.
await scheduler.start();
// Registers repos an agent cloned with raw `git clone` before this process started.
void adoptUnregisteredRepos(cfg).catch((err) => console.error("failed to adopt unregistered repos:", err));

const app = Fastify({ logger: { level: "info" } });
await app.register(fastifyWebsocket);
await app.register(fastifyMultipart);

registerRoutes(app, cfg, {
  artifacts, email, mcp, settings, subagentSettings, manager, agents, models, scheduler,
  signal: signalService,
});
// Public, unauthenticated artifact pages (see deploy/fastcar.json auth.public_paths).
registerPublicArtifactRoutes(app, artifacts);
// Public, unauthenticated prompt-thread trigger (`/pt/<id>`).
registerPublicPromptTriggerRoutes(app, manager);
registerWs(app, manager, cfg);

// Serve the built web UI in production (web/dist); Vite dev server proxies to us in dev.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/ws") || req.raw.url?.startsWith("/artifacts/") || req.raw.url?.startsWith("/pt/")) {
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
  scheduler.stop();
  await manager.shutdown().catch(() => {});
  await mcp.shutdown().catch(() => {});
  await signalService?.stop().catch(() => {});
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
