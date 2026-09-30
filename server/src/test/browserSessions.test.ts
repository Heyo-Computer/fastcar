import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Config } from "../config.js";
import { findChromium } from "../services/chromium.js";
import { BrowserSessions } from "../services/browserSessions.js";
import { createBrowserTools } from "../tools/browser.js";

// Drives the browser_* tools through a three-page "quote form" served from
// this process: a first page of mixed inputs, a second page whose field is
// rendered by JS and which raises an alert, and a result page with a table, a
// pop-up link and a download. Needs a Chromium binary (FASTCAR_CHROMIUM_PATH
// or a system install); skipped without one.

const PAGE1 = `<!doctype html><title>Get a quote</title>
<h1>Car insurance quote</h1>
<form action="/step2" method="get">
  <label for="zip">ZIP code</label><input id="zip" name="zip" required>
  <label for="cov">Coverage</label>
  <select id="cov" name="cov"><option value="">Choose…</option><option value="min">State minimum</option><option value="full">Full coverage</option></select>
  <fieldset><legend>Vehicle use</legend>
    <label><input type="radio" name="use" value="commute"> Commute</label>
    <label><input type="radio" name="use" value="pleasure"> Pleasure</label>
  </fieldset>
  <label><input type="checkbox" name="garaged"> Garaged overnight</label>
  <button type="submit">Next</button>
</form>`;

const PAGE2 = `<!doctype html><title>Driver details</title>
<h1>Driver</h1>
<div id="slot"></div>
<button id="go">See my quote</button>
<script>
  const q = new URLSearchParams(location.search);
  document.title = "Driver details for " + q.get("zip");
  setTimeout(() => {
    document.getElementById("slot").innerHTML = '<label for="age">Driver age</label><input id="age" type="number" min="16" required>';
  }, 300);
  document.getElementById("go").onclick = () => {
    alert("Calculating your quote");
    location.href = "/result?" + q.toString() + "&age=" + document.getElementById("age").value;
  };
</script>`;

const RESULT = `<!doctype html><title>Your quotes</title>
<h1>Your quotes</h1>
<table><caption>Monthly premiums</caption>
  <tr><th>Insurer</th><th>Premium</th><th>Deductible</th></tr>
  <tr><td>Acme Mutual</td><td>$123/mo</td><td>$500</td></tr>
  <tr><td>Zeta Direct</td><td>$141/mo</td><td>$250</td></tr>
</table>
<a href="/details" target="_blank">Coverage details</a>
<a href="/quote.pdf">Download quote</a>`;

function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    };
    if (url.pathname === "/") return html(PAGE1);
    if (url.pathname === "/step2") return html(PAGE2);
    if (url.pathname === "/result") return html(RESULT + `<p id="echo">${url.search}</p>`);
    if (url.pathname === "/details") return html("<title>Details</title><p>Liability 100/300/100</p>");
    if (url.pathname === "/quote.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="quote.pdf"' });
      return res.end("%PDF-1.4 fake");
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

type Tools = ReturnType<typeof createBrowserTools>;
async function run(tools: Tools, name: string, params: Record<string, unknown>) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (t.execute as any)(`call-${Date.now()}`, params, undefined, undefined, undefined);
  return { text: res.content.map((c: { text: string }) => c.text).join("\n") as string, details: res.details };
}

/** The ref of the first snapshot line with this role and accessible name. */
function ref(snapshot: string, role: string, name: string): string {
  const line = snapshot.split("\n").find((l) => l.includes(`${role} "${name}"`) && l.includes("[ref="));
  assert.ok(line, `no ${role} "${name}" in snapshot:\n${snapshot}`);
  return /\[ref=(\w+)\]/.exec(line)![1]!;
}

describe("browser_* tools", { skip: findChromium() ? false : "no Chromium binary" }, () => {
  let server: http.Server;
  let base: string;
  let dataDir: string;
  let sessions: BrowserSessions;
  let tools: Tools;

  before(async () => {
    server = await serve();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-browser-"));
    sessions = new BrowserSessions({ dataDir } as Config, { idleMs: 60_000 });
    tools = createBrowserTools(sessions, "thread-1", dataDir);
  });

  after(async () => {
    await sessions.shutdown();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("walks a multi-page form, keeping state between calls", async () => {
    const opened = await run(tools, "browser_open", { url: `${base}/` });
    assert.match(opened.text, /Title: Get a quote/);

    const s = opened.text;
    const acted = await run(tools, "browser_act", {
      actions: [
        { action: "fill", ref: ref(s, "textbox", "ZIP code"), value: "94107" },
        { action: "select", ref: ref(s, "combobox", "Coverage"), value: "Full coverage" },
        { action: "check", ref: ref(s, "radio", "Pleasure") },
        { action: "check", ref: ref(s, "checkbox", "Garaged overnight") },
      ],
    });
    assert.equal(acted.details.ok, true, acted.text);

    const form = await run(tools, "browser_extract", { what: "form" });
    assert.match(form.text, /ZIP code \[text name=zip\]: "94107" · required/);
    assert.match(form.text, /Coverage \[select name=cov\]: Full coverage/);
    assert.match(form.text, /Pleasure \[radio name=use\]: checked/);

    const next = await run(tools, "browser_act", { actions: [{ action: "click", selector: "text=Next" }] });
    assert.match(next.text, /Title: Driver details for 94107/);

    // The age field is rendered by script after load; wait for it, then fill.
    const waited = await run(tools, "browser_act", { actions: [{ action: "wait", selector: "#age" }] });
    const age = ref(waited.text, "spinbutton", "Driver age");
    const done = await run(tools, "browser_act", {
      actions: [
        { action: "fill", ref: age, value: "34" },
        { action: "click", selector: "text=See my quote" },
      ],
    });
    assert.match(done.text, /\[dialog\] alert: "Calculating your quote" — accepted/);
    assert.match(done.text, /Title: Your quotes/);
    assert.match(done.text, /zip=94107&cov=full&use=pleasure&garaged=on&age=34/);
  });

  it("reports a stale ref instead of acting on the wrong element", async () => {
    const r = await run(tools, "browser_act", {
      actions: [{ action: "click", ref: "e9999" }, { action: "click", selector: "text=Download quote" }],
    });
    assert.equal(r.details.ok, false);
    assert.match(r.text, /1\. click \[e9999\] — FAILED: .*ref is stale/);
    assert.match(r.text, /1 later action\(s\) were not run/);
  });

  it("extracts tables as markdown and links as absolute URLs", async () => {
    const tables = await run(tools, "browser_extract", { what: "tables" });
    assert.match(tables.text, /Table 1 — Monthly premiums:/);
    assert.match(tables.text, /\| Acme Mutual \| \$123\/mo \| \$500 \|/);
    const links = await run(tools, "browser_extract", { what: "links" });
    assert.ok(links.text.includes(`- Coverage details — ${base}/details`), links.text);
  });

  it("follows a pop-up into a new tab and saves downloads", async () => {
    const popup = await run(tools, "browser_act", { actions: [{ action: "click", selector: "text=Coverage details" }] });
    assert.match(popup.text, /a new tab opened and is now active/);
    assert.match(popup.text, /Liability 100\/300\/100/);

    const tabs = await run(tools, "browser_tabs", { action: "switch", index: 0 });
    assert.match(tabs.text, /\* 0: Your quotes/);

    await run(tools, "browser_act", { actions: [{ action: "click", selector: "text=Download quote" }] });
    const dir = path.join(dataDir, "browser", "thread-1", "downloads");
    const deadline = Date.now() + 5_000;
    while (!(fs.existsSync(dir) && fs.readdirSync(dir).length) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith("quote.pdf")));
  });

  it("serialises parallel calls on one thread", async () => {
    // Run concurrently, the snapshot must see the navigation complete, never a half-loaded page.
    const [, snap] = await Promise.all([
      run(tools, "browser_open", { url: `${base}/details` }),
      run(tools, "browser_snapshot", { text_only: true }),
    ]);
    assert.match(snap.text, /Liability 100\/300\/100/);
  });

  it("keeps threads apart and closes a session on request", async () => {
    const other = createBrowserTools(sessions, "thread-2", dataDir);
    await assert.rejects(run(other, "browser_snapshot", {}), /No page is open/);
    assert.equal(sessions.has("thread-1"), true);
    const closed = await run(tools, "browser_close", {});
    assert.match(closed.text, /Browser session closed/);
    assert.equal(sessions.has("thread-1"), false);
  });

  it("closes an idle session", async () => {
    const quick = new BrowserSessions({ dataDir } as Config, { idleMs: 200 });
    const t = createBrowserTools(quick, "idle", dataDir);
    await run(t, "browser_open", { url: `${base}/details` });
    assert.equal(quick.has("idle"), true);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(quick.has("idle"), false);
    await quick.shutdown();
  });

  it("refuses non-http URLs", async () => {
    await assert.rejects(run(tools, "browser_open", { url: "file:///etc/passwd" }), /Only http\(s\) URLs/);
  });
});
