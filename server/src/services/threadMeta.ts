/**
 * The single place a ThreadRecord becomes the ThreadMeta the UI sees.
 *
 * This used to be a private method on ThreadManager, which is why `hello` and
 * GET /api/threads — neither of which has a manager instance to hand — shipped
 * bare `toMeta()` rows with `publicUrl` undefined, while the WS broadcasts
 * shipped enriched ones. Everything that puts a ThreadMeta on the wire goes
 * through `threadMeta()` now, so a field added here appears on every path at
 * once.
 */
import type { ThreadMeta } from "@fastcar/shared";
import type { Config } from "../config.js";
import { toMeta, type ThreadRecord } from "../db/threads.js";

/**
 * Canonical public path prefix for triggering a prompt thread (no auth).
 * Keep in sync with deploy/fastcar.json `auth.public_paths`.
 */
export const PUBLIC_PROMPT_TRIGGER_PREFIX = "/pt/";

/**
 * Public, unauthenticated trigger URL for a prompt thread:
 * `<publicUrl>/pt/<threadId>`.
 */
export function threadPublicUrl(cfg: Config, threadId: string): string {
  return `${cfg.publicUrl}${PUBLIC_PROMPT_TRIGGER_PREFIX}${threadId}`;
}

/**
 * Wrap `toMeta()` and add the public trigger URL for prompt threads. The URL is
 * the capability that lets an unauthenticated caller re-run the thread via
 * `/pt/<id>`; chat threads get `null` so the UI can hide the affordance.
 */
export function threadMeta(cfg: Config, rec: ThreadRecord): ThreadMeta {
  const meta = toMeta(rec);
  meta.publicUrl = rec.threadType === "prompt" ? threadPublicUrl(cfg, rec.id) : null;
  return meta;
}
