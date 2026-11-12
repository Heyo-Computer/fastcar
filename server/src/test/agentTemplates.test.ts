/**
 * Sales agent templates: every template must name real tools and render its
 * CRM server name, and install must create an editable agent plus a disabled
 * schedule — refusing cleanly when the CRM isn't installed or it's a repeat.
 * Also covers the mcp_call result cap and the web_extract tool (mock Tavily).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { getPool, closePool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { AgentService } from "../services/agents.js";
import {
  AGENT_TEMPLATES,
  installAgentTemplate,
  listAgentTemplates,
  renderTemplatePrompt,
  TemplateInstallError,
} from "../services/agentTemplates.js";
import type { McpManager } from "../services/mcp.js";
import { Scheduler } from "../services/scheduler.js";
import { getTool } from "../tools/registry.js";
import { capMcpResult, MCP_RESULT_MAX_CHARS } from "../tools/mcp.js";
import { createWebExtractTool, EXTRACT_MAX_CHARS_PER_PAGE } from "../tools/webSearch.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastcar:fastcar@127.0.0.1:5433/fastcar";

const fakeMcp = (names: string[]) => ({ statuses: async () => names.map((name) => ({ name })) }) as unknown as McpManager;

test("agent templates: static checks", () => {
  for (const t of AGENT_TEMPLATES) {
    const unknown = t.tools.filter((n) => !getTool(n));
    assert.deepEqual(unknown, [], `${t.id} names unknown tools`);
    const p = renderTemplatePrompt(t, "crm-prod");
    assert.ok(!p.includes("{{CRM}}"), `${t.id} prompt still has a placeholder`);
    assert.ok(p.includes('"crm-prod"'), `${t.id} prompt names the CRM server`);
    assert.match(t.id, /^[a-z0-9][a-z0-9-]{1,31}$/, "template id doubles as the agent slug");
  }
  // The prospector must never be told it may contact people or convert prospects.
  const prospector = AGENT_TEMPLATES.find((t) => t.id === "prospector")!;
  assert.ok(!prospector.tools.includes("email_send"));
  assert.match(prospector.systemPrompt, /NEVER guess or construct/);
});

test("mcp_call result cap", () => {
  assert.equal(capMcpResult("short"), "short");
  const big = "x".repeat(MCP_RESULT_MAX_CHARS + 500);
  const capped = capMcpResult(big);
  assert.ok(capped.startsWith("x".repeat(MCP_RESULT_MAX_CHARS)));
  assert.match(capped, /truncated/);
  assert.ok(capped.length < big.length + 300);
});

test("web_extract (mock)", async () => {
  process.env.FASTCAR_MOCK = "1";
  const tool = createWebExtractTool(loadConfig());
  const out = await tool.execute("id", { urls: ["https://a.example", "https://b.example"] }, undefined, undefined, {} as never);
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /# https:\/\/a\.example/);
  assert.match(text, /# https:\/\/b\.example/);
  assert.ok(EXTRACT_MAX_CHARS_PER_PAGE > 1000);
});

test("agent templates: install", async (t) => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.FASTCAR_MOCK = "1";
  await migrate();
  const cfg = loadConfig();
  // Run-unique slugs: never touch agents a developer installed in this DB.
  const RUN = Date.now().toString(36).slice(-6);
  const slug = (id: string) => `${id}-t${RUN}`.slice(0, 32);
  const slugs = AGENT_TEMPLATES.map((x) => slug(x.id));
  const cleanup = async () => {
    await getPool().query(
      "DELETE FROM threads WHERE agent_id IN (SELECT id FROM agents WHERE slug = ANY($1))",
      [slugs],
    );
    await getPool().query(
      "DELETE FROM schedules WHERE agent_id IN (SELECT id FROM agents WHERE slug = ANY($1))",
      [slugs],
    );
    await getPool().query("DELETE FROM agents WHERE slug = ANY($1)", [slugs]);
  };
  await cleanup();
  const mcp = fakeMcp(["loopscrm"]);
  const agents = new AgentService(cfg, undefined, mcp);
  const scheduler = new Scheduler({} as never, agents, {} as never);
  const deps = { cfg, agents, scheduler, mcp };
  t.after(async () => {
    await cleanup();
    await closePool();
  });

  await t.test("refuses when the CRM server isn't installed", async () => {
    await assert.rejects(
      installAgentTemplate({ ...deps, mcp: fakeMcp([]) }, "prospector", { slug: slug("prospector") }, null),
      (e: unknown) => e instanceof TemplateInstallError && e.status === 400 && /MCP server named "loopscrm"/.test(e.message),
    );
  });

  await t.test("unknown template is a 404", async () => {
    await assert.rejects(
      installAgentTemplate(deps, "nope", {}, null),
      (e: unknown) => e instanceof TemplateInstallError && e.status === 404,
    );
  });

  await t.test("installs an agent and a disabled schedule", async () => {
    const { agent, scheduleId } = await installAgentTemplate(
      deps, "prospector", { timezone: "America/Denver", slug: slug("prospector") }, null,
    );
    assert.equal(agent.slug, slug("prospector"));
    assert.deepEqual(agent.mcpServers, ["loopscrm"]);
    assert.equal(agent.modelSlug, cfg.maxcodingModel);
    assert.equal(agent.supportsPlanMode, false);
    assert.ok(agent.tools?.includes("upsert_prospects") === false, "CRM tools are reached through mcp_call");
    assert.ok(agent.tools?.includes("mcp_call"));
    assert.ok(agent.systemPrompt?.includes('server "loopscrm"'));
    assert.ok(scheduleId);
    const { rows } = await getPool().query("SELECT enabled, timezone, mode FROM schedules WHERE id = $1", [scheduleId]);
    assert.deepEqual(rows[0], { enabled: false, timezone: "America/Denver", mode: "act" });

    const listing = await listAgentTemplates(deps);
    assert.ok(listing.templates.find((x) => x.id === "prospector")?.installedAgentId, "suffixed slug counts as installed");
    assert.ok(!("systemPrompt" in listing.templates[0]!), "the listing doesn't ship prompts");
  });

  await t.test("a second install is a 409", async () => {
    await assert.rejects(
      installAgentTemplate(deps, "prospector", { slug: slug("prospector") }, null),
      (e: unknown) => e instanceof TemplateInstallError && e.status === 409,
    );
  });

  await t.test("a custom CRM server name flows into the prompt and subset", async () => {
    const { agent } = await installAgentTemplate(
      { ...deps, mcp: fakeMcp(["crm-prod"]), agents: new AgentService(cfg, undefined, fakeMcp(["crm-prod"])) },
      "pipeline-reporter",
      { crmServer: "crm-prod", slug: slug("pipeline-reporter") },
      null,
    );
    assert.deepEqual(agent.mcpServers, ["crm-prod"]);
    assert.ok(agent.systemPrompt?.includes('"crm-prod"'));
  });
});

test("lastAssistantError: provider failures are not silent successes", async () => {
  const { lastAssistantError } = await import("../threads/manager.js");
  const user = { role: "user", content: [] };
  assert.equal(lastAssistantError([]), null);
  assert.equal(lastAssistantError([user, { role: "assistant", stopReason: "stop" }]), null);
  assert.equal(lastAssistantError([user, { role: "assistant", stopReason: "aborted" }]), null);
  assert.match(
    lastAssistantError([user, { role: "assistant", stopReason: "error", errorMessage: "404: model unavailable" }])!,
    /404: model unavailable/,
  );
  // A retried failure followed by a good answer is fine.
  assert.equal(
    lastAssistantError([user, { role: "assistant", stopReason: "error" }, { role: "toolResult" }, { role: "assistant", stopReason: "stop" }]),
    null,
  );
});

test("scheduled runs are told the date in their timezone", async () => {
  const { scheduledRunHeader } = await import("../threads/manager.js");
  // 2026-11-11 06:30 UTC is still the 10th in Denver.
  const at = new Date("2026-11-11T06:30:00Z");
  assert.equal(scheduledRunHeader(at, "America/Denver"), "[Scheduled run · Tuesday 2026-11-10 23:30 (America/Denver)]");
  assert.equal(scheduledRunHeader(at, "UTC"), "[Scheduled run · Wednesday 2026-11-11 06:30 (UTC)]");
});
