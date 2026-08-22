/**
 * Smoke for the browser_check agent tool: point it at a URL (arg 1), run
 * optional steps (arg 2, JSON), print the tool's text output. Needs a
 * Chromium — system package or FASTCAR_CHROMIUM_PATH.
 *
 *     npm run smoke:browser -- http://localhost:3000 '[{"action":"click","selector":"text=+ New thread"}]'
 */
import { loadConfig } from "../config.js";
import { createBrowserCheckTool } from "../tools/browserCheck.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: smoke:browser <url> [steps-json]");
  process.exit(1);
}
const steps = process.argv[3] ? JSON.parse(process.argv[3]) : undefined;

const tool = createBrowserCheckTool(loadConfig());
// The trailing ExtensionContext is unused by this tool; the smoke has none.
const result = await tool.execute(
  `smoke-${Date.now()}`,
  { url, steps, screenshot: true },
  undefined,
  () => {},
  undefined as unknown as Parameters<typeof tool.execute>[4],
);
const first = result.content[0];
console.log(first && "text" in first ? first.text : JSON.stringify(result.content));
