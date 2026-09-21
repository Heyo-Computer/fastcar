/**
 * FASTCAR_PUBLIC_URL, and what happens when it is missing.
 *
 * The bug this pins: with the variable unset (or set under another name, such
 * as BASE_URL), fastcar fell back to http://localhost:3000 in silence, and
 * the agent handed out artifact links nobody else could open. The fallback
 * itself is right for local development, so it stays — but it now announces
 * itself at boot, in /api/settings for the UI's banner, and in every artifact
 * link the agent receives.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../config.js";
import { ArtifactService } from "../services/artifacts.js";
import { AppSettings } from "../services/appSettings.js";

const VARS = ["FASTCAR_PUBLIC_URL", "BASE_URL", "PUBLIC_URL", "PORT", "FASTCAR_DATA_DIR"] as const;

describe("public URL configuration", () => {
  const saved: Record<string, string | undefined> = {};
  let tmp: string;
  let warnings: string[];
  let realWarn: typeof console.warn;

  beforeEach(() => {
    for (const v of VARS) saved[v] = process.env[v];
    for (const v of VARS) delete process.env[v];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-puburl-"));
    process.env.FASTCAR_DATA_DIR = tmp;
    process.env.FASTCAR_MOCK = "1";
    process.env.DATABASE_URL ??= "postgres://unused";
    warnings = [];
    realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  });

  afterEach(() => {
    console.warn = realWarn;
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("uses FASTCAR_PUBLIC_URL, trailing slash stripped, and stays quiet", () => {
    process.env.FASTCAR_PUBLIC_URL = "https://fastcar.us2.heyo.work/";
    const cfg = loadConfig();
    assert.equal(cfg.publicUrl, "https://fastcar.us2.heyo.work");
    assert.equal(cfg.publicUrlFromEnv, true);
    assert.equal(warnings.length, 0);
  });

  it("falls back to localhost on the configured port — and warns", () => {
    process.env.PORT = "4321";
    const cfg = loadConfig();
    assert.equal(cfg.publicUrl, "http://localhost:4321");
    assert.equal(cfg.publicUrlFromEnv, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /FASTCAR_PUBLIC_URL is not set/);
    assert.match(warnings[0]!, /Artifact links/);
  });

  it("names a lookalike variable that was set instead", () => {
    // "I set the base URL" is the usual way this happens.
    process.env.BASE_URL = "https://fastcar.us2.heyo.work";
    const cfg = loadConfig();
    assert.equal(cfg.publicUrl, "http://localhost:3000", "a lookalike is reported, never silently honoured");
    assert.match(warnings[0]!, /BASE_URL=https:\/\/fastcar\.us2\.heyo\.work is set, but fastcar reads FASTCAR_PUBLIC_URL/);
  });

  it("treats a blank value as unset", () => {
    process.env.FASTCAR_PUBLIC_URL = "   ";
    assert.equal(loadConfig().publicUrlFromEnv, false);
  });
});

describe("where the public URL surfaces", () => {
  const base = (publicUrl: string, publicUrlFromEnv: boolean): Config =>
    ({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-puburl2-")),
      publicUrl,
      publicUrlFromEnv,
      conductorReasoningEffort: "medium",
      inceptionModel: "mercury-2.5",
      inceptionMaxTokens: 1,
    }) as unknown as Config;

  it("artifact links carry a caveat only when using the fallback", () => {
    const configured = new ArtifactService(base("https://fastcar.us2.heyo.work", true));
    const fallback = new ArtifactService(base("http://localhost:3000", false));
    const a = { id: "abc", name: "brief.html" };

    assert.equal(configured.publicUrl(a), "https://fastcar.us2.heyo.work/artifacts/abc/brief.html");
    assert.equal(configured.localOnlyNote(), "");

    assert.equal(fallback.publicUrl(a), "http://localhost:3000/artifacts/abc/brief.html");
    assert.match(fallback.localOnlyNote(), /not shareable/);
    assert.match(fallback.localOnlyNote(), /FASTCAR_PUBLIC_URL/);
  });

  it("/api/settings exposes it for the UI's mismatch banner", () => {
    const s = new AppSettings(base("http://localhost:3000", false)).get();
    assert.deepEqual(s.server, { publicUrl: "http://localhost:3000", publicUrlFromEnv: false });
  });
});
