/**
 * CLI smoke test: drives a real conductor session (real Pi loop, real tools)
 * against the mock OpenAI server. Requires DATABASE_URL; no API keys.
 *
 *   DATABASE_URL=... npm run smoke -- "hello"
 *   DATABASE_URL=... npm run smoke -- "please delegate the exploration"
 *   DATABASE_URL=... FASTCAR_SMOKE_MODE=plan npm run smoke -- "plan a change"
 */
process.env.FASTCAR_MOCK ??= "1";

import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { closePool } from "../db/pool.js";
import { createConductorSession } from "../pi/conductor.js";
import { translateSessionEvent } from "../pi/events.js";
import { buildModels } from "../pi/runtime.js";
import { SubagentManager } from "../pi/subagents.js";
import { startMockOpenAI } from "./mock-openai.js";

const prompt = process.argv.slice(2).join(" ") || "hello, look around";
const mode = process.env.FASTCAR_SMOKE_MODE === "plan" ? "plan" : "act";

const cfg = loadConfig();
const mockServer = cfg.mock ? await startMockOpenAI(cfg.mockPort) : undefined;
await migrate();

const models = await buildModels(cfg);
console.log(
  `models: conductor=${models.conductor.provider}/${models.conductor.id} ` +
    `(reasoning_effort=${cfg.conductorReasoningEffort}), ` +
    `maxcoding=${models.maxcoding.provider}/${models.maxcoding.id}, ` +
    `minimodel=${models.minimodel.provider}/${models.minimodel.id}`,
);

const subagents = new SubagentManager(models, cfg);
let submittedPlan: string | undefined;

const { session } = await createConductorSession({
  cfg,
  models,
  subagents,
  threadId: "00000000-0000-0000-0000-000000000000",
  getMode: () => mode,
  askBridge: {
    ask: async (_id, question, options) => {
      console.log(`\n[ask_user] ${question} (options: ${options?.join(", ") ?? "none"})`);
      return options?.[0] ?? "yes";
    },
  },
  planBridge: {
    submit: (plan) => {
      submittedPlan = plan;
      console.log(`\n[submit_plan]\n${plan}`);
    },
  },
  onSubagentEvent: (kind, taskId, ev) => {
    if (ev.kind === "text_delta") process.stdout.write(`\x1b[36m${ev.text}\x1b[0m`);
    else console.log(`\n[subagent ${kind} ${taskId}] ${ev.kind}`);
  },
  sessionFile: null,
  reasoningEffort: cfg.conductorReasoningEffort,
});

session.subscribe((event) => {
  for (const ev of translateSessionEvent(event)) {
    if (ev.kind === "text_delta") process.stdout.write(ev.text);
    else if (ev.kind === "tool_start") console.log(`\n[tool_start] ${ev.name} ${JSON.stringify(ev.args)}`);
    else if (ev.kind === "tool_end") console.log(`\n[tool_end] ${ev.toolCallId} ok=${ev.ok}`);
    else if (ev.kind === "message_end")
      console.log(`\n[message_end] usage=${JSON.stringify(ev.usage)}`);
  }
});

console.log(`\n--- prompting (mode=${mode}): "${prompt}" ---\n`);
await session.prompt(prompt);
console.log(`\n--- done. sessionFile=${session.sessionFile} ---`);
if (submittedPlan) console.log("(plan was submitted)");

session.dispose();
mockServer?.close();
await closePool();
process.exit(0);
