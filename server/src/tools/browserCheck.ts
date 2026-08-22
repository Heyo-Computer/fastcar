import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Config } from "../config.js";

/**
 * `browser_check`: load a page in headless Chromium, optionally interact with
 * it, and report what a person at the devtools console would see — JS page
 * errors, console errors/warnings, failed requests, and the rendered text.
 * This is how an agent reproduces "the UI throws and nothing renders" bugs
 * against the app it is working on (e.g. fastcar's own web UI on
 * http://localhost:3000).
 *
 * Uses the system Chromium (installed in the VM image) via playwright-core —
 * no browser download at runtime. Resolution order: FASTCAR_CHROMIUM_PATH,
 * then well-known install paths.
 */

const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

function findChromium(): string | undefined {
  const explicit = process.env.FASTCAR_CHROMIUM_PATH?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  return CHROMIUM_CANDIDATES.find((p) => fs.existsSync(p));
}

const Step = Type.Object({
  action: Type.Union(
    [
      Type.Literal("click"),
      Type.Literal("fill"),
      Type.Literal("press"),
      Type.Literal("wait"),
      Type.Literal("goto"),
    ],
    { description: "What to do: click / fill / press a key / wait / navigate" },
  ),
  selector: Type.Optional(
    Type.String({
      description:
        "CSS selector for click/fill, or `text=...` to target by visible text (e.g. text=+ New thread)",
    }),
  ),
  value: Type.Optional(
    Type.String({ description: "Text for fill, key name for press (e.g. Enter), URL for goto" }),
  ),
  ms: Type.Optional(Type.Number({ description: "Milliseconds to wait (wait action, max 10000)" })),
});

const MAX_TEXT = 3000;

interface BrowserCheckDetails {
  errorCount: number;
  screenshotPath?: string;
}

export function createBrowserCheckTool(cfg: Config) {
  return defineTool({
    name: "browser_check",
    label: "Browser Check",
    description:
      "Load a URL in headless Chromium, optionally interact (click/fill/press/wait), and report JS page errors, console errors/warnings, failed requests, and the rendered page text plus a screenshot file. Use it to reproduce and to verify fixes for web UI bugs.",
    parameters: Type.Object({
      url: Type.String({ description: "The page to load (e.g. http://localhost:3000)" }),
      steps: Type.Optional(
        Type.Array(Step, { description: "Interactions to run, in order, after the page loads" }),
      ),
      screenshot: Type.Optional(
        Type.Boolean({ description: "Save a screenshot and report its path (default true)" }),
      ),
    }),
    execute: async (toolCallId, params, signal) => {
      const executablePath = findChromium();
      if (!executablePath) {
        return {
          content: [
            {
              type: "text",
              text: "No Chromium binary found. Install chromium, or set FASTCAR_CHROMIUM_PATH to a Chrome/Chromium executable.",
            },
          ],
          details: { errorCount: 0 } as BrowserCheckDetails,
        };
      }

      const logs: string[] = [];
      const stepResults: string[] = [];
      let browser: Browser | undefined;
      // Chromium's sandbox needs privileges the Firecracker guest's root user
      // deliberately lacks; the VM is single-tenant, so run without it.
      const onAbort = () => void browser?.close().catch(() => {});
      signal?.addEventListener("abort", onAbort);
      try {
        browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
        const page = await browser.newPage();
        page.setDefaultTimeout(10_000);
        page.on("console", (m) => {
          if (m.type() === "error" || m.type() === "warning")
            logs.push(`[console.${m.type()}] ${m.text()}`);
        });
        page.on("pageerror", (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));
        page.on("requestfailed", (r) =>
          logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ""}`),
        );

        await page.goto(params.url, { waitUntil: "load", timeout: 20_000 });
        await page.waitForTimeout(750); // let SPAs settle before interacting

        for (const [i, step] of (params.steps ?? []).entries()) {
          if (signal?.aborted) throw new Error("aborted");
          await runStep(page, step);
          stepResults.push(`${i + 1}. ${describeStep(step)} — ok`);
        }
        await page.waitForTimeout(750); // and settle again after the last step

        let screenshotPath: string | undefined;
        if (params.screenshot !== false) {
          const dir = path.join(cfg.dataDir, "browser-checks");
          fs.mkdirSync(dir, { recursive: true });
          screenshotPath = path.join(dir, `${toolCallId}.png`);
          await page.screenshot({ path: screenshotPath });
        }

        const title = await page.title();
        let text = await page.innerText("body", { timeout: 3_000 }).catch(() => "");
        if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n…(truncated)`;

        const sections = [
          `URL: ${page.url()}`,
          `Title: ${title || "(none)"}`,
          stepResults.length ? `Steps:\n${stepResults.join("\n")}` : "",
          logs.length
            ? `Errors and warnings (${logs.length}):\n${logs.join("\n")}`
            : "No JS errors, console errors/warnings, or failed requests.",
          screenshotPath ? `Screenshot: ${screenshotPath}` : "",
          `Rendered text:\n${text.trim() || "(page rendered no text)"}`,
        ];
        return {
          content: [{ type: "text", text: sections.filter(Boolean).join("\n\n") }],
          details: { errorCount: logs.length, screenshotPath } as BrowserCheckDetails,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const sections = [
          `browser_check failed: ${message}`,
          stepResults.length ? `Steps completed before failure:\n${stepResults.join("\n")}` : "",
          logs.length ? `Errors captured before failure:\n${logs.join("\n")}` : "",
        ];
        return {
          content: [{ type: "text", text: sections.filter(Boolean).join("\n\n") }],
          details: { errorCount: logs.length } as BrowserCheckDetails,
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await browser?.close().catch(() => {});
      }
    },
  });
}

type StepParams = { action: string; selector?: string; value?: string; ms?: number };

async function runStep(page: Page, step: StepParams): Promise<void> {
  switch (step.action) {
    case "click": {
      if (!step.selector) throw new Error("click needs a selector");
      await locate(page, step.selector).click();
      break;
    }
    case "fill": {
      if (!step.selector) throw new Error("fill needs a selector");
      await locate(page, step.selector).fill(step.value ?? "");
      break;
    }
    case "press":
      await page.keyboard.press(step.value || "Enter");
      break;
    case "wait":
      await page.waitForTimeout(Math.min(step.ms ?? 1000, 10_000));
      break;
    case "goto": {
      if (!step.value) throw new Error("goto needs a value (the URL)");
      await page.goto(step.value, { waitUntil: "load", timeout: 20_000 });
      break;
    }
    default:
      throw new Error(`unknown action: ${step.action}`);
  }
}

function locate(page: Page, selector: string) {
  // `text=...` targets by visible text and tolerates markup changes; anything
  // else is a CSS selector. `.first()` keeps a multi-match from being an error.
  return selector.startsWith("text=")
    ? page.getByText(selector.slice(5), { exact: false }).first()
    : page.locator(selector).first();
}

function describeStep(step: StepParams): string {
  const target = step.selector ?? step.value ?? (step.ms != null ? `${step.ms}ms` : "");
  return `${step.action} ${target}`.trim();
}
