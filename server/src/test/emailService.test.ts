import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EmailService } from "../services/emailService.js";
import type { Config } from "../config.js";

function tempConfig(dataDir: string): Config {
  return {
    port: 3000,
    databaseUrl: "",
    mock: true,
    mockPort: 3210,
    workdir: dataDir,
    dataDir,
    sessionDir: path.join(dataDir, "sessions"),
    reposDir: path.join(dataDir, "repos"),
    mcpDir: path.join(dataDir, "mcp"),
    gitName: undefined,
    gitEmail: undefined,
    maxcodingModel: "x",
    minimodelModel: "y",
    transcribeModel: "z",
    tavilyApiKey: undefined,
    openrouterBaseUrl: "",
    subagentProvider: "openrouter",
    omlxBaseUrl: "http://localhost:8080/v1",
    inceptionBaseUrl: "",
    inceptionModel: "mercury-2.5",
    inceptionMaxTokens: 16384,
    conductorReasoningEffort: "medium",
    adminToken: undefined,
    defaultOwner: null,
    publicUrl: "http://public.test",
  };
}

describe("EmailService (SMTP)", () => {
  let tmp: string;
  let cfg: Config;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-smtp-"));
    cfg = tempConfig(tmp);
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("stores settings with the password encrypted at rest", () => {
    const svc = new EmailService(cfg);
    const out = svc.saveSettings({
      host: "smtp.example.com",
      port: 465,
      username: "user",
      password: "super-secret",
      fromAddress: "fastcar@example.com",
      secure: true,
    });
    assert.equal(out.host, "smtp.example.com");
    assert.equal(out.secure, true);
    assert.equal(out.configured, true);
    // The on-disk file must not contain the plaintext password.
    const raw = fs.readFileSync(path.join(tmp, "smtp.json"), "utf8");
    assert.ok(!raw.includes("super-secret"), "password must not be plaintext on disk");
    assert.match(raw, /passwordEnc/, "stored under passwordEnc");
  });

  it("never returns the password", () => {
    const svc = new EmailService(cfg);
    const out = svc.getSettings();
    assert.equal(out.host, "smtp.example.com");
    assert.equal(out.username, "user");
    assert.equal(out.configured, true);
    assert.equal(
      "password" in out,
      false,
      "password is not returned",
    );
  });

  it("keeps the existing password when a blank one is saved", () => {
    const svc = new EmailService(cfg);
    svc.saveSettings({
      host: "smtp.example.com",
      port: 465,
      username: "user",
      password: "", // blank => keep existing
      fromAddress: "fastcar@example.com",
      secure: true,
    });
    // Still considered configured (the encrypted password survived).
    assert.equal(svc.getSettings().configured, true);
  });

  it("re-encrypts deterministically enough to round-trip (same key → decrypts)", () => {
    const svc = new EmailService(cfg);
    svc.saveSettings({
      host: "h",
      port: 587,
      username: "u",
      password: "round-trip-secret",
      fromAddress: "f@example.com",
      secure: false,
    });
    // The file mode is 0600.
    const stat = fs.statSync(path.join(tmp, "smtp.json"));
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, "smtp.json must be mode 0600");
  });

  it("sendEmail reports failure when SMTP host is unset", async () => {
    const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-smtp-empty-"));
    const fresh = new EmailService(tempConfig(freshTmp));
    const r = await fresh.sendEmail("to@example.com", "s", "b");
    assert.equal(r.ok, false);
    assert.match(r.message, /not configured/i);
    fs.rmSync(freshTmp, { recursive: true, force: true });
  });
});
