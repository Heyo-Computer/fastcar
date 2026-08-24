import crypto from "node:crypto";
import type { Config } from "../config.js";

/**
 * At-rest encryption for the few secrets fastcar stores itself (the SMTP
 * password, MCP server env vars and headers): AES-256-GCM with a key derived
 * from `FASTCAR_SECRET` (or a stable per-install default) via PBKDF2.
 *
 * The derivation constants predate this file — they were the email service's —
 * and must not change, or every existing smtp.json stops decrypting.
 */
function secretKey(cfg: Config): Buffer {
  const secret =
    process.env.FASTCAR_SECRET?.trim() ||
    // Stable per-deployment default: the data dir's absolute path salts the key
    // so two installs on the same host do not share a key.
    `fastcar-smtp:${cfg.dataDir}`;
  return crypto.pbkdf2Sync(secret, "fastcar-smtp-salt", 100_000, 32, "sha256");
}

/** base64(iv ‖ ciphertext ‖ tag); "" for an empty input. */
export function encryptSecret(plain: string, cfg: Config): string {
  if (!plain) return "";
  const key = secretKey(cfg);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

export function decryptSecret(encB64: string, cfg: Config): string {
  if (!encB64) return "";
  const key = secretKey(cfg);
  const buf = Buffer.from(encB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/** Encrypt a string map; an empty map encrypts to "". */
export function encryptMap(map: Record<string, string>, cfg: Config): string {
  return Object.keys(map).length ? encryptSecret(JSON.stringify(map), cfg) : "";
}

export function decryptMap(encB64: string, cfg: Config): Record<string, string> {
  if (!encB64) return {};
  const parsed: unknown = JSON.parse(decryptSecret(encB64, cfg));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
