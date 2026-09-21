import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackHost } from "../components/PublicUrlBanner.tsx";

test("loopback detection drives the misconfiguration banner", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "app.localhost", "LOCALHOST"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  // A real deployment, and a LAN address someone else can reach, are not.
  for (const h of ["fastcar.us2.heyo.work", "10.0.0.4", "localhost.example.com"]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});
