import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { postToWebhook, RateLimiter, validateWebhookUrl } from "../services/webhook.js";

describe("validateWebhookUrl", () => {
  it("accepts an https URL", () => {
    const r = validateWebhookUrl("https://example.com/hook");
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
  });

  it("rejects an http URL", () => {
    const r = validateWebhookUrl("http://example.com/hook");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /HTTPS/);
  });

  it("rejects a malformed URL", () => {
    const r = validateWebhookUrl("not-a-url");
    assert.equal(r.ok, false);
  });

  it("rejects a URL with no hostname", () => {
    const r = validateWebhookUrl("https://");
    assert.equal(r.ok, false);
  });
});

describe("postToWebhook", () => {
  it("returns an error result for a non-https URL without fetching", async () => {
    const r = await postToWebhook("http://example.com", "tok", { a: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.status, "error");
    assert.match(r.response, /HTTPS/);
  });

  it("returns an error result for a malformed URL without fetching", async () => {
    const r = await postToWebhook(":::not a url:::", "tok", { a: 1 });
    assert.equal(r.status, "error");
  });
});

describe("RateLimiter", () => {
  it("allows up to maxCalls then refuses within the window", () => {
    const lim = new RateLimiter(3, 60_000);
    assert.equal(lim.check("k").allowed, true);
    assert.equal(lim.check("k").allowed, true);
    assert.equal(lim.check("k").allowed, true);
    const refused = lim.check("k");
    assert.equal(refused.allowed, false);
    assert.ok((refused.retryAfterMs ?? 0) > 0);
  });

  it("tracks keys independently", () => {
    const lim = new RateLimiter(1, 60_000);
    assert.equal(lim.check("a").allowed, true);
    assert.equal(lim.check("b").allowed, true);
    assert.equal(lim.check("a").allowed, false);
  });

  it("re-allows after the window elapses", async () => {
    const lim = new RateLimiter(1, 20);
    assert.equal(lim.check("k").allowed, true);
    assert.equal(lim.check("k").allowed, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lim.check("k").allowed, true);
  });
});
