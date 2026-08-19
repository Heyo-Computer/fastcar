import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";

/**
 * Encrypted at-rest store for prompt-thread webhook bearer tokens (Feature 3).
 *
 * Tokens are keyed by thread id and persisted in `<dataDir>/webhook-tokens.json`,
 * each value encrypted with AES-256-GCM (the key is derived from the same
 * `FASTCAR_SECRET` used by the SMTP store). The token is never written to
 * Postgres and never returned to the client.
 */
interface TokenFile {
  [threadId: string]: string; // base64 iv:ciphertext:tag
}

function filePath(cfg: Config): string {
  return path.join(cfg.dataDir, "webhook-tokens.json");
}

function secretKey(cfg: Config): Buffer {
  const secret =
    process.env.FASTCAR_SECRET?.trim() || `fastcar-smtp:${cfg.dataDir}`;
  return crypto.pbkdf2Sync(secret, "fastcar-webhook-salt", 100_000, 32, "sha256");
}

function encrypt(plain: string, cfg: Config): string {
  if (!plain) return "";
  const key = secretKey(cfg);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

function decrypt(encB64: string, cfg: Config): string {
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

function loadAll(cfg: Config): TokenFile {
  const file = filePath(cfg);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as TokenFile;
  } catch {
    return {};
  }
}

function saveAll(cfg: Config, data: TokenFile): void {
  const file = filePath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export class WebhookTokenStore {
  constructor(private readonly cfg: Config) {}

  set(threadId: string, token: string): void {
    const all = loadAll(this.cfg);
    all[threadId] = encrypt(token, this.cfg);
    saveAll(this.cfg, all);
  }

  get(threadId: string): string {
    const all = loadAll(this.cfg);
    return all[threadId] ? decrypt(all[threadId]!, this.cfg) : "";
  }

  delete(threadId: string): void {
    const all = loadAll(this.cfg);
    delete all[threadId];
    saveAll(this.cfg, all);
  }
}
