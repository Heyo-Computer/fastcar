import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { WebhookTokenStore, generateTriggerToken } from "../services/webhookTokens.js";

// Unit tests for the trigger-token methods on WebhookTokenStore (Feature 3):
// generate, set, get, delete, and isolation from the webhook bearer token.

describe("WebhookTokenStore trigger tokens", () => {
  let dataDir: string;
  let store: WebhookTokenStore;

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastcar-tokens-"));
    // loadConfig reads env; we only need dataDir/publicUrl, so build a minimal cfg.
    process.env.FASTCAR_DATA_DIR = dataDir;
    const cfg = loadConfig();
    store = new WebhookTokenStore(cfg);
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("generateTriggerToken returns ~32 url-safe chars", () => {
    const t = generateTriggerToken();
    assert.ok(t.length >= 30 && t.length <= 34, `len=${t.length}`);
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    // randomness: two calls differ
    assert.notEqual(generateTriggerToken(), generateTriggerToken());
  });

  it("returns empty for an unset trigger token", () => {
    assert.equal(store.getTriggerToken("nope"), "");
  });

  it("round-trips a trigger token", () => {
    store.setTriggerToken("t1", "secret-trigger-1");
    assert.equal(store.getTriggerToken("t1"), "secret-trigger-1");
  });

  it("deletes a trigger token", () => {
    store.setTriggerToken("t2", "secret-trigger-2");
    assert.equal(store.getTriggerToken("t2"), "secret-trigger-2");
    store.deleteTriggerToken("t2");
    assert.equal(store.getTriggerToken("t2"), "");
  });

  it("isolates the trigger token from the webhook bearer token", () => {
    store.set("t3", "bearer-secret");
    store.setTriggerToken("t3", "trigger-secret");
    assert.equal(store.get("t3"), "bearer-secret");
    assert.equal(store.getTriggerToken("t3"), "trigger-secret");
    // Deleting the trigger token must not touch the bearer token.
    store.deleteTriggerToken("t3");
    assert.equal(store.getTriggerToken("t3"), "");
    assert.equal(store.get("t3"), "bearer-secret");
  });

  it("persists across a new store instance (same dataDir)", () => {
    store.setTriggerToken("t4", "persisted-trigger");
    const cfg = loadConfig();
    const reopened = new WebhookTokenStore(cfg);
    assert.equal(reopened.getTriggerToken("t4"), "persisted-trigger");
  });
});
