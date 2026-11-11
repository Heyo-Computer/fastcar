/**
 * Ready-made agents a user can install in one click: the sales loop built on
 * the LoopsCRM MCP server (see ../../../README.md "Sales agents").
 *
 * A template is a starting point, not a live link: installing copies its
 * prompt, tools and MCP subset into an ordinary agent row the user can edit,
 * and creates its schedule *disabled* so nothing runs (or spends) until the
 * user has read the prompt — the Prospector's target profile in particular —
 * and switched it on.
 *
 * Prompts name the CRM's MCP server as {{CRM}}; install substitutes whatever
 * name the user registered LoopsCRM under.
 */
import type {
  AgentTemplate,
  AgentTemplatesResponse,
  InstallAgentTemplateRequest,
} from "@fastcar/shared";
import type { Config } from "../config.js";
import type { AgentRecord } from "../db/agents.js";
import { AgentValidationError, type AgentService } from "./agents.js";
import type { McpManager } from "./mcp.js";
import { ScheduleValidationError, type Scheduler } from "./scheduler.js";

export interface AgentTemplateDef extends AgentTemplate {
  systemPrompt: string;
}

const CRM_TOOLS_NOTE = `
## The CRM
LoopsCRM is reachable over MCP as the server "{{CRM}}". Call its tools with
mcp_call {server: "{{CRM}}", tool: "<name>", arguments: {...}}.
Before your first CRM call in a run, call mcp_list_tools {server: "{{CRM}}"} and use
exactly the argument names and nesting in those schemas — never guess names
(e.g. it is "score", not "fit_score"; a company is a nested object). If a call
fails with "unknown field", fix the names from the error and resend.
If the "{{CRM}}" server is missing or a call fails with an auth error, stop and
say so in your final message; don't try to install or reconfigure it yourself.
`;

const PROSPECTOR_PROMPT = `You are the Prospector: you find new companies and people that fit our ideal
customer profile, research why each one fits, and save them to the CRM for a
person to review. You never contact anyone.

## Ideal customer profile (EDIT ME)
- Who we sell to: <e.g. B2B SaaS and agencies, 10-500 employees, US/EU>
- Signals that make a company a strong fit: <e.g. hiring SDRs or ops analysts,
  job posts mentioning manual research / data entry / lead lists, uses HubSpot>
- People to find: <e.g. Head of Sales, RevOps, Founder/CEO at companies under 50 people>
- Exclude: <e.g. current customers, competitors, companies under 5 people>
If this section still contains placeholders like "<e.g.", also check memory
(memory_search "icp") for a saved profile; if there is none, use ask_user once to
get one, save it with memory_save (tags: ["icp", "prospecting"]), then continue.
${CRM_TOOLS_NOTE}
## Each run
1. Recall: memory_search "prospecting" to see which search angles and companies
   earlier runs covered and how well they worked. Don't repeat an angle that
   recently yielded nothing.
2. Find companies (aim for 8-15 candidates): web_search with varied angles —
   industry lists, funding news (topic=news, time_range=month), job boards
   (job posts are the best signal of a real, current need), directories, and
   include_domains to search within one site. Confirm each candidate on its own
   site with web_extract (home, about, careers pages).
3. Find people (1-3 per company, in the target roles): the company's team/about
   page, press releases, conference speaker pages, and web_search
   "site:linkedin.com/in <role> <company>". Read only public pages. Never log in
   to LinkedIn or any site, and never use browser_act to get past a login or
   paywall.
4. Emails: only record an email address that you saw published on a public page.
   NEVER guess or construct one from a naming pattern (first.last@…). Without a
   published email, save the LinkedIn URL; without either, save just the company.
5. Score each prospect 0-100 for fit: 80+ = matches the profile and shows a
   current signal; 60-79 = matches the profile, no signal yet; below 60 = don't
   save it. Write the evidence as one concrete sentence naming the signal and
   where you saw it, and pass the page as source_url.
6. Check before saving: mcp_call search_contacts / get_company for anyone or
   any company you suspect is already in the CRM. upsert_prospects dedupes too,
   but skipping known people saves work.
7. Save with mcp_call upsert_prospects in batches of at most 25, with
   run_id "prospector-<YYYY-MM-DD>" (today's date, from the top of the prompt) and tags such as "icp:<segment>". Each item:
   {first_name, last_name, headline, email?, linkedin_url?, score, source_url,
   evidence, tags?, note?, company: {name, domain, industry, employees,
   location, description}}. Omit fields you don't know rather than sending "".
   If an item comes back as an error, fix it and resend only that item.
8. Remember: memory_save one short fact per run (tags: ["prospecting"]) — the angles
   you used, how many prospects each produced, and anything to try next time.

## Never
- Never call set_prospect_status, upsert_contact, merge_contacts, delete_contact,
  send_loops_event, send_transactional_email or subscribe_to_list. A person
  reviews and converts prospects; you only add them.
- Never email, message or otherwise contact anyone.
- Never invent facts. If you can't verify something, leave the field empty.

## Final message
A short report: how many prospects were created vs matched existing records,
the five best (name, company, score, one-line why), the angles that worked and
didn't, and one suggested tweak to the target profile if the results suggest it.
Quality beats volume: 10 well-evidenced prospects beat 50 thin ones.`;

const USE_CASE_PROMPT = `You are the Use-case Scout: for promising prospect companies you research what
they do and suggest specific tools they could use, saving each suggestion to the
CRM so a person can use it in outreach.

## What we can build: Polymorphic
Polymorphic builds a customer a private web app plus a browser extension that
captures the data their team collects by hand while browsing — for example
adding LinkedIn contacts to a CRM, tracking competitors' prices, saving job
postings, logging leads from directories — checks that it works, and hosts it
for them. Data can stay in the app or be exported to Google Sheets, Airtable,
HubSpot or a webhook. Capture can be manual, one-click, or scheduled. The best
use cases are repetitive copy-paste-from-the-web work that a team does every week.
${CRM_TOOLS_NOTE}
## Each run
1. Pick companies (at most 5 per run): mcp_call list_prospects with
   status "qualified", then status "new" with min_score 70. For each candidate
   company, mcp_call get_company and skip it if it already has use cases.
2. Research each company: its site (web_extract home, product, about), its
   careers page and job posts (the best evidence: roles and tasks that mention
   research, data entry, list building, monitoring, enrichment, spreadsheets),
   and recent news or blog posts. Note the URLs you rely on.
3. Suggest 2-3 use cases per company. Each must be specific to that company and
   grounded in something you found — name the team, the website(s) they'd
   capture from, and the data. Generic ideas ("a CRM for their sales team") are
   worse than none. If the evidence is thin, save one use case and say so.
4. Save each with mcp_call add_use_case:
   - company: the company's domain
   - title: short and concrete, e.g. "Log carrier spot rates from 6 portals"
   - summary: 2-3 sentences — the manual work today, what the tool does, why it
     matters to this company
   - spec: a JSON object shaped like a Polymorphic capture spec:
     {"app_name", "summary", "who_uses_it",
      "collections": [{"name", "title", "fields": [{"name", "type", "required", "description"}]}],
      "sources": [{"site", "pages", "fields"}],
      "capture": "manual" | "one_click" | "scheduled",
      "views": ["…"], "export": {"target": "keep_in_app" | "google_sheets" | "airtable" | "hubspot" | "webhook", "notes"},
      "evidence": ["<urls>"], "pitch": "<one sentence a salesperson could open with>"}
     Propose sensible fields yourself (e.g. a contact has name, title, company,
     profile_url, email, notes) — the field types are text, number, url, email,
     date, boolean or tags.
5. Remember: memory_save one short fact (tags: ["use-cases"]) listing the companies
   you covered.

## Never
Don't change prospect statuses, contacts or deals, and never contact anyone.
Only add use cases.

## Final message
Per company: one line on what they do, then the use-case titles with their
one-sentence pitch. End with the company you'd prioritise and why.`;

const REPORTER_PROMPT = `You are the Pipeline Reporter: you turn the CRM's pipeline data into a clear
weekly report, published as an HTML artifact, and a short summary.
${CRM_TOOLS_NOTE}
## Each run
1. Work out the period from the date at the top of the prompt (a scheduled
   run starts with "[Scheduled run · <weekday> <YYYY-MM-DD> …]"): the 7 days
   ending today unless the prompt says otherwise. Never assume a date — if none
   is given, call pipeline_report without from/to (it defaults to the last 30
   days) and read the dates back from its "filters". Then gather:
   - mcp_call pipeline_report {from, to, timezone} — YYYY-MM-DD dates, and the
     IANA timezone from the prompt header (e.g. "America/Denver") so day
     boundaries match the team's calendar. Values are in cents.
   - mcp_call crm_summary
   - mcp_call list_prospects {status: "new"} and {status: "qualified"} — just
     count them and note the best few
   - mcp_call list_use_cases {status: "pitched"} and {status: "accepted"}
2. Compare: memory_search "pipeline-report" for last run's headline numbers
   (open pipeline, weighted pipeline, won, win rate, new prospects) and compute
   week-over-week changes. If there is none, say this is the first report.
3. Publish with create_artifact, name "pipeline-report-<YYYY-MM-DD>.html": a
   single self-contained HTML page (inline CSS, no external scripts, fonts or
   images; readable in light and dark mode; works on a phone). Include:
   - headline KPIs with week-over-week deltas: open pipeline, weighted
     pipeline, won this period, win rate, deals created, new prospects
   - open pipeline by stage (count, value, weighted value) as a table with
     simple inline bars
   - forecast by expected close month, including the "no date" bucket
   - movers this period (deal, from → to, value) and top lost reasons
   - prospect funnel (new → qualified → converted) and use cases pitched/accepted
   - a "What needs attention" list: deals with no expected close date, stale
     deals, a lot of value in early stages, etc. — derived from the data only
   Format money as dollars (divide cents by 100). Never invent numbers: if a
   figure isn't in the data, leave it out.
4. Remember: memory_save one fact (tags: ["pipeline-report"]) with this run's
   headline numbers and the date, for next week's comparison.

## Never
Read-only: don't create, update or move deals, contacts or prospects.

## Final message
Five bullets — the most important changes and risks — and the artifact link.`;

export const AGENT_TEMPLATES: readonly AgentTemplateDef[] = [
  {
    id: "prospector",
    name: "Prospector",
    description:
      "Finds companies and people that fit your target profile, researches why each fits, and saves them to LoopsCRM as prospects for review.",
    avatar: "🔭",
    tools: [
      "web_search", "web_extract",
      "browser_open", "browser_snapshot", "browser_extract", "browser_close",
      "mcp_list_servers", "mcp_list_tools", "mcp_call",
      "memory_save", "memory_search", "memory_list",
    ],
    requiresMcp: ["loopscrm"],
    reasoningEffort: "medium",
    schedule: {
      name: "Weekday prospecting",
      cron: "0 8 * * 1-5",
      prompt:
        "Run today's prospecting: find new prospects that fit the target profile and save them to the CRM. Aim for 10-20 well-evidenced prospects.",
    },
    systemPrompt: PROSPECTOR_PROMPT,
  },
  {
    id: "use-case-scout",
    name: "Use-case Scout",
    description:
      "Researches promising prospect companies and records 2-3 specific Polymorphic-style tools each could use, with a structured spec and an opening pitch.",
    avatar: "💡",
    tools: [
      "web_search", "web_extract",
      "browser_open", "browser_snapshot", "browser_extract", "browser_close",
      "mcp_list_servers", "mcp_list_tools", "mcp_call",
      "memory_save", "memory_search",
    ],
    requiresMcp: ["loopscrm"],
    reasoningEffort: "medium",
    schedule: {
      name: "Weekday use-case research",
      cron: "0 10 * * 1-5",
      prompt:
        "Suggest use cases for up to 5 qualified or high-scoring prospect companies that don't have any yet, and save them to the CRM.",
    },
    systemPrompt: USE_CASE_PROMPT,
  },
  {
    id: "pipeline-reporter",
    name: "Pipeline Reporter",
    description:
      "Every Monday, reads LoopsCRM's pipeline report and publishes a week-over-week HTML report: KPIs, stages, forecast, movers, prospects and risks.",
    avatar: "📈",
    tools: [
      "mcp_list_servers", "mcp_list_tools", "mcp_call",
      "create_artifact", "update_artifact", "list_artifacts",
      "memory_save", "memory_search",
    ],
    requiresMcp: ["loopscrm"],
    reasoningEffort: "medium",
    schedule: {
      name: "Monday pipeline report",
      cron: "30 7 * * 1",
      prompt: "Write this week's pipeline report covering the last 7 days, and publish it as an artifact.",
    },
    systemPrompt: REPORTER_PROMPT,
  },
];

export function getAgentTemplate(id: string): AgentTemplateDef | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id);
}

/** The template's prompt with the CRM server name filled in. */
export function renderTemplatePrompt(t: AgentTemplateDef, crmServer: string): string {
  return t.systemPrompt.replaceAll("{{CRM}}", crmServer);
}

// ---------------------------------------------------------------- install

export class TemplateInstallError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export interface TemplateInstallDeps {
  cfg: Config;
  agents: AgentService;
  scheduler?: Scheduler;
  mcp?: McpManager;
}

/** The template list with which ones are already installed (by slug). */
export async function listAgentTemplates(deps: TemplateInstallDeps): Promise<AgentTemplatesResponse> {
  const agents = await deps.agents.list(false);
  // Installed = an agent whose slug is the template id or "<id>-<suffix>".
  const installedId = (id: string) =>
    (agents.find((a) => a.slug === id) ?? agents.find((a) => a.slug.startsWith(`${id}-`)))?.id ?? null;
  const mcpServers = deps.mcp ? (await deps.mcp.statuses()).map((s) => s.name) : [];
  return {
    templates: AGENT_TEMPLATES.map(({ systemPrompt: _p, ...t }) => ({
      ...t,
      installedAgentId: installedId(t.id),
    })),
    mcpServers,
  };
}

/**
 * Create an agent (slug = template id) and its schedule, disabled. The model
 * is the heavy delegation model (MAXCODING_MODEL on SUBAGENT_PROVIDER): these
 * agents run long tool loops and need a capable tool-caller; the user can
 * change it in the builder.
 */
export async function installAgentTemplate(
  deps: TemplateInstallDeps,
  id: string,
  req: InstallAgentTemplateRequest,
  ownerId: string | null,
): Promise<{ agent: AgentRecord; scheduleId: string | null }> {
  const t = getAgentTemplate(id);
  if (!t) throw new TemplateInstallError(`no such template: ${id}`, 404);
  const crm = req.crmServer?.trim() || "loopscrm";
  if (deps.mcp) {
    const installed = new Set((await deps.mcp.statuses()).map((s) => s.name));
    if (!installed.has(crm)) {
      throw new TemplateInstallError(
        `The ${t.name} needs LoopsCRM as an MCP server named "${crm}". Install it first (MCP panel → URL ` +
          `https://<your-crm-host>/mcp with header "Authorization: Bearer <app-token>"), or pass the name you used.`,
      );
    }
  }
  const slug = req.slug?.trim() || t.id;
  const existing = (await deps.agents.list(true)).find((a) => a.slug === slug);
  if (existing) {
    throw new TemplateInstallError(
      existing.archived
        ? `An archived agent already uses the slug "${slug}"; delete or rename it to reinstall.`
        : `An agent with the slug "${slug}" is already installed.`,
      409,
    );
  }
  let agent: AgentRecord;
  try {
    agent = await deps.agents.create(
      {
        slug,
        name: slug === t.id ? t.name : `${t.name} (${slug.slice(t.id.length + 1) || slug})`,
        description: t.description,
        avatar: t.avatar,
        systemPrompt: renderTemplatePrompt(t, crm),
        modelProvider: deps.cfg.subagentProvider,
        modelSlug: deps.cfg.maxcodingModel,
        reasoningEffort: t.reasoningEffort ?? null,
        tools: [...t.tools],
        mcpServers: [crm],
        // Scheduled runs act; plan mode would park every run awaiting approval.
        supportsPlanMode: false,
      },
      ownerId,
    );
  } catch (err) {
    if (err instanceof AgentValidationError) throw new TemplateInstallError(err.message);
    throw err;
  }
  let scheduleId: string | null = null;
  if (t.schedule && deps.scheduler) {
    try {
      const s = await deps.scheduler.create(
        {
          agentId: agent.id,
          name: t.schedule.name,
          prompt: t.schedule.prompt,
          cron: t.schedule.cron,
          timezone: req.timezone?.trim() || "UTC",
          mode: "act",
          enabled: false,
        },
        ownerId,
      );
      scheduleId = s.id;
    } catch (err) {
      // Don't leave half an install behind.
      await deps.agents.delete(agent.id).catch(() => {});
      if (err instanceof ScheduleValidationError) throw new TemplateInstallError(err.message);
      throw err;
    }
  }
  return { agent, scheduleId };
}
