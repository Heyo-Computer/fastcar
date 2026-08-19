import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";
import type { SmtpSettingsRequest, SmtpSettingsResponse } from "@fastcar/shared";
import type { Config } from "../config.js";

/**
 * SMTP settings + email sending (Feature 2).
 *
 * The whole config lives in `<dataDir>/smtp.json`. The password field is
 * encrypted at rest with AES-256-GCM; the key is derived from
 * `FASTCAR_SECRET` (or a stable default) with PBKDF2. The file is mode 0600.
 *
 * `sendEmail(to, subject, body)` reads the config and sends via nodemailer.
 */
const SMTP_FILE = "smtp.json";

interface StoredSmtpSettings {
  host: string;
  port: number;
  username: string;
  /** Encrypted (base64 iv:ciphertext:tag). Blank when no password set. */
  passwordEnc: string;
  fromAddress: string;
  secure: boolean;
}

export interface SendEmailResult {
  ok: boolean;
  message: string;
  messageId?: string;
}

function smtpPath(cfg: Config): string {
  return path.join(cfg.dataDir, SMTP_FILE);
}

function secretKey(cfg: Config): Buffer {
  const secret =
    process.env.FASTCAR_SECRET?.trim() ||
    // Stable per-deployment default: the data dir's absolute path salts the key
    // so two installs on the same host do not share a key.
    `fastcar-smtp:${cfg.dataDir}`;
  return crypto.pbkdf2Sync(secret, "fastcar-smtp-salt", 100_000, 32, "sha256");
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

function emptySettings(): StoredSmtpSettings {
  return { host: "", port: 587, username: "", passwordEnc: "", fromAddress: "", secure: false };
}

function loadStored(cfg: Config): StoredSmtpSettings {
  const file = smtpPath(cfg);
  if (!fs.existsSync(file)) return emptySettings();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredSmtpSettings>;
    return {
      host: raw.host ?? "",
      port: Number(raw.port) || 587,
      username: raw.username ?? "",
      passwordEnc: raw.passwordEnc ?? "",
      fromAddress: raw.fromAddress ?? "",
      secure: Boolean(raw.secure),
    };
  } catch (err) {
    console.error("failed to parse smtp.json, resetting:", err);
    return emptySettings();
  }
}

function saveStored(cfg: Config, s: StoredSmtpSettings): void {
  const file = smtpPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export class EmailService {
  constructor(private readonly cfg: Config) {}

  /** Read settings for the UI (password never returned). */
  getSettings(): SmtpSettingsResponse {
    const s = loadStored(this.cfg);
    const configured = Boolean(s.host && s.fromAddress && s.passwordEnc);
    return {
      host: s.host,
      port: s.port,
      username: s.username,
      fromAddress: s.fromAddress,
      secure: s.secure,
      configured,
    };
  }

  /** Persist settings. A blank password keeps the existing one. */
  saveSettings(req: SmtpSettingsRequest): SmtpSettingsResponse {
    const prev = loadStored(this.cfg);
    const passwordEnc =
      req.password && req.password.length ? encrypt(req.password, this.cfg) : prev.passwordEnc;
    const next: StoredSmtpSettings = {
      host: req.host.trim(),
      port: Number(req.port) || 587,
      username: req.username.trim(),
      passwordEnc,
      fromAddress: req.fromAddress.trim(),
      secure: Boolean(req.secure),
    };
    saveStored(this.cfg, next);
    return this.getSettings();
  }

  private buildTransport(): nodemailer.Transporter {
    const s = loadStored(this.cfg);
    if (!s.host || !s.fromAddress) {
      throw new Error("SMTP settings are not configured");
    }
    const password = decrypt(s.passwordEnc, this.cfg);
    return nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: password || s.username ? { user: s.username, pass: password } : undefined,
    });
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    log?: FastifyBaseLogger,
  ): Promise<SendEmailResult> {
    const s = loadStored(this.cfg);
    if (!s.host || !s.fromAddress) {
      return { ok: false, message: "SMTP settings are not configured" };
    }
    try {
      const transport = this.buildTransport();
      const info = await transport.sendMail({
        from: s.fromAddress,
        to,
        subject,
        text: body,
      });
      log?.info(`email sent to ${to}: ${info.messageId}`);
      return { ok: true, message: `sent to ${to}`, messageId: info.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.error({ err }, "email send failed");
      return { ok: false, message };
    }
  }
}
