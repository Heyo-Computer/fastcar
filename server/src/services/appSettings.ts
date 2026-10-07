import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  PROVIDER_KEY_IDS,
  REASONING_EFFORTS,
  type ApiKeyStatus,
  type AppSettingsRequest,
  type AppSettingsResponse,
  type ProviderKeyId,
  type ReasoningEffort,
} from "@fastcar/shared";
import { PROVIDER_KEY_ENV, type Config } from "../config.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

const SETTINGS_FILE = "settings.json";

interface StoredAppSettings {
  conductorReasoningEffort?: ReasoningEffort;
  conductorModel?: string;
  conductorMaxTokens?: number;
  /** Provider key overrides, each encrypted with services/secrets.ts. */
  apiKeys?: Partial<Record<ProviderKeyId, string>>;
}

/** Upper bound on the max_tokens override — a typo guard, not a provider limit. */
const MAX_TOKENS_LIMIT = 1_000_000;

/**
 * Key values this process wrote into process.env, so clearing an override
 * restores the env value instead of leaving the old override in place.
 */
const writtenKeys = new Map<string, string>();

/** "••••a1b2" — enough to tell keys apart, never enough to use one. */
export function maskKey(key: string): string {
  return key.length >= 12 ? `••••${key.slice(-4)}` : "••••";
}

/** Emits "changed" (no payload) after every successful update. */
export const appSettingsEvents = new EventEmitter();

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidMaxTokens(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_TOKENS_LIMIT;
}

/**
 * Runtime-editable app settings (the ⚙ modal). Same shape as the SMTP store:
 * one JSON file under the data dir, env vars supply the defaults. It holds the
 * conductor's reasoning effort, model id and max_tokens, plus provider API key
 * overrides — those are encrypted at rest and only ever leave the server as a
 * masked preview, whether they came from here or from the environment.
 *
 * Overrides take effect by being applied onto the live config / environment:
 * the conductor model and budget onto cfg.inceptionModel / inceptionMaxTokens
 * (the ThreadManager re-registers the provider on "changed"), the keys onto
 * process.env, where Pi resolves "$INCEPTION_API_KEY" & co. per request. The
 * constructor applies what is stored, so build this before buildModels().
 */
export class AppSettings {
  constructor(private readonly cfg: Config) {
    this.apply();
  }

  private get file(): string {
    return path.join(this.cfg.dataDir, SETTINGS_FILE);
  }

  private loadStored(): StoredAppSettings {
    if (!fs.existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredAppSettings;
      const apiKeys: Partial<Record<ProviderKeyId, string>> = {};
      for (const id of PROVIDER_KEY_IDS) {
        const enc = raw.apiKeys?.[id];
        if (typeof enc === "string" && enc) apiKeys[id] = enc;
      }
      return {
        conductorReasoningEffort: isReasoningEffort(raw.conductorReasoningEffort)
          ? raw.conductorReasoningEffort
          : undefined,
        conductorModel: isNonEmptyString(raw.conductorModel) ? raw.conductorModel.trim() : undefined,
        conductorMaxTokens: isValidMaxTokens(raw.conductorMaxTokens) ? raw.conductorMaxTokens : undefined,
        apiKeys,
      };
    } catch (err) {
      console.error("failed to parse settings.json, using defaults:", err);
      return {};
    }
  }

  private saveStored(s: StoredAppSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Owner-only: the file may hold (encrypted) API keys.
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  conductorReasoningEffort(): ReasoningEffort {
    return this.loadStored().conductorReasoningEffort ?? this.cfg.conductorReasoningEffort;
  }

  /** Push the stored overrides (or the env defaults) onto cfg and process.env. */
  private apply(): void {
    const stored = this.loadStored();
    this.cfg.inceptionModel = stored.conductorModel ?? this.cfg.conductorDefaults.model;
    this.cfg.inceptionMaxTokens = stored.conductorMaxTokens ?? this.cfg.conductorDefaults.maxTokens;

    for (const id of PROVIDER_KEY_IDS) {
      const envVar = PROVIDER_KEY_ENV[id];
      const override = this.decryptKey(stored.apiKeys?.[id]);
      if (override) {
        process.env[envVar] = override;
        writtenKeys.set(envVar, override);
      } else if (writtenKeys.has(envVar)) {
        // Only undo what we wrote; never touch a value we did not set.
        if (process.env[envVar] === writtenKeys.get(envVar)) {
          const envDefault = this.cfg.envApiKeys[id];
          if (envDefault) process.env[envVar] = envDefault;
          else delete process.env[envVar];
        }
        writtenKeys.delete(envVar);
      }
    }
  }

  private decryptKey(enc: string | undefined): string | undefined {
    if (!enc) return undefined;
    try {
      return decryptSecret(enc, this.cfg) || undefined;
    } catch (err) {
      // A changed FASTCAR_SECRET makes the stored key unreadable; fall back to env.
      console.error("failed to decrypt a stored API key, using the env value:", err);
      return undefined;
    }
  }

  private keyStatus(id: ProviderKeyId, stored: StoredAppSettings): ApiKeyStatus {
    const envVar = PROVIDER_KEY_ENV[id];
    const override = this.decryptKey(stored.apiKeys?.[id]);
    if (override) return { envVar, source: "settings", preview: maskKey(override) };
    const fromEnv = this.cfg.envApiKeys[id];
    if (fromEnv) return { envVar, source: "env", preview: maskKey(fromEnv) };
    return { envVar, source: "unset", preview: null };
  }

  get(): AppSettingsResponse {
    const stored = this.loadStored();
    return {
      server: {
        publicUrl: this.cfg.publicUrl,
        publicUrlFromEnv: this.cfg.publicUrlFromEnv,
      },
      conductor: {
        model: `inceptionlabs/${this.cfg.inceptionModel}`,
        reasoningEffort: this.conductorReasoningEffort(),
        defaultReasoningEffort: this.cfg.conductorReasoningEffort,
        maxTokens: this.cfg.inceptionMaxTokens,
        modelId: this.cfg.inceptionModel,
        defaultModelId: this.cfg.conductorDefaults.model,
        defaultMaxTokens: this.cfg.conductorDefaults.maxTokens,
      },
      keys: Object.fromEntries(
        PROVIDER_KEY_IDS.map((id) => [id, this.keyStatus(id, stored)]),
      ) as Record<ProviderKeyId, ApiKeyStatus>,
    };
  }

  /** Validates and persists; throws on a bad value. Emits "changed" on success. */
  update(req: AppSettingsRequest): AppSettingsResponse {
    const next = this.loadStored();
    const effort = req.conductor?.reasoningEffort;
    if (effort !== undefined) {
      if (!isReasoningEffort(effort)) {
        throw new Error(`reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}`);
      }
      next.conductorReasoningEffort = effort;
    }

    const modelId = req.conductor?.modelId;
    if (modelId !== undefined) {
      if (modelId !== null && typeof modelId !== "string") {
        throw new Error("modelId must be a string or null");
      }
      // Blank, or the env model itself, clears the override.
      const trimmed = modelId?.trim();
      next.conductorModel =
        trimmed && trimmed !== this.cfg.conductorDefaults.model ? trimmed : undefined;
    }

    const maxTokens = req.conductor?.maxTokens;
    if (maxTokens !== undefined) {
      if (maxTokens !== null && !isValidMaxTokens(maxTokens)) {
        throw new Error(`maxTokens must be an integer between 1 and ${MAX_TOKENS_LIMIT}, or null`);
      }
      next.conductorMaxTokens =
        maxTokens !== null && maxTokens !== this.cfg.conductorDefaults.maxTokens ? maxTokens : undefined;
    }

    if (req.keys !== undefined) {
      if (!req.keys || typeof req.keys !== "object") throw new Error("keys must be an object");
      const apiKeys = { ...next.apiKeys };
      for (const [id, value] of Object.entries(req.keys)) {
        if (!(PROVIDER_KEY_IDS as readonly string[]).includes(id)) {
          throw new Error(`unknown key ${id}; expected one of ${PROVIDER_KEY_IDS.join(", ")}`);
        }
        if (value !== null && value !== undefined && typeof value !== "string") {
          throw new Error(`keys.${id} must be a string or null`);
        }
        const trimmed = value?.trim();
        if (trimmed) apiKeys[id as ProviderKeyId] = encryptSecret(trimmed, this.cfg);
        else if (value !== undefined) delete apiKeys[id as ProviderKeyId];
      }
      next.apiKeys = apiKeys;
    }

    this.saveStored(next);
    this.apply();
    appSettingsEvents.emit("changed");
    return this.get();
  }
}
