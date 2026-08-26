import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  SUBAGENT_PROVIDERS,
  type SubagentProvider,
  type SubagentSettingsRequest,
  type SubagentSettingsResponse,
} from "@fastcar/shared";
import type { Config } from "../config.js";

const SETTINGS_FILE = "subagent-settings.json";

interface StoredSubagentSettings {
  provider?: SubagentProvider;
  omlxBaseUrl?: string;
  maxcodingModel?: string | null;
  minimodelModel?: string | null;
}

/** Emits "changed" (no payload) after every successful update. */
export const subagentSettingsEvents = new EventEmitter();

function isSubagentProvider(value: unknown): value is SubagentProvider {
  return typeof value === "string" && (SUBAGENT_PROVIDERS as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Runtime-editable subagent model configuration (the ⚙ modal, subagent tab).
 * Same shape as the AppSettings / SMTP stores: one JSON file under the data
 * dir, env vars supply the defaults, nothing in here is secret. Re-read on
 * every access so the file can be edited by hand while the server runs.
 *
 * The SubagentManager reads this on every run, so a POST here is picked up by
 * the next subagent turn without a restart. The OMLX API key is *not* stored
 * here — it is read from the environment (OMLX_API_KEY) by the Pi provider's
 * `$VAR` auth resolution, exactly like OPENROUTER_API_KEY.
 */
export class SubagentSettings {
  constructor(private readonly cfg: Config) {}

  private get file(): string {
    return path.join(this.cfg.dataDir, SETTINGS_FILE);
  }

  private loadStored(): StoredSubagentSettings {
    if (!fs.existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredSubagentSettings;
      return {
        provider: isSubagentProvider(raw.provider) ? raw.provider : undefined,
        omlxBaseUrl: isNonEmptyString(raw.omlxBaseUrl) ? raw.omlxBaseUrl : undefined,
        maxcodingModel:
          raw.maxcodingModel === null || isNonEmptyString(raw.maxcodingModel)
            ? (raw.maxcodingModel as string | null)
            : undefined,
        minimodelModel:
          raw.minimodelModel === null || isNonEmptyString(raw.minimodelModel)
            ? (raw.minimodelModel as string | null)
            : undefined,
      };
    } catch (err) {
      console.error("failed to parse subagent-settings.json, using defaults:", err);
      return {};
    }
  }

  private saveStored(s: StoredSubagentSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2));
  }

  /** Active provider, falling back to the env default. */
  provider(): SubagentProvider {
    return this.loadStored().provider ?? this.cfg.subagentProvider;
  }

  /** Active OMLX base URL, falling back to the env default. */
  omlxBaseUrl(): string {
    return this.loadStored().omlxBaseUrl ?? this.cfg.omlxBaseUrl;
  }

  /** Active maxcoding model slug, or null to use the env default. */
  maxcodingModel(): string | null {
    const stored = this.loadStored().maxcodingModel;
    return stored === undefined ? null : stored;
  }

  /** Active minimodel model slug, or null to use the env default. */
  minimodelModel(): string | null {
    const stored = this.loadStored().minimodelModel;
    return stored === undefined ? null : stored;
  }

  get(): SubagentSettingsResponse {
    const stored = this.loadStored();
    return {
      provider: stored.provider ?? this.cfg.subagentProvider,
      omlxBaseUrl: stored.omlxBaseUrl ?? this.cfg.omlxBaseUrl,
      maxcoding: { model: stored.maxcodingModel === undefined ? null : stored.maxcodingModel },
      minimodel: { model: stored.minimodelModel === undefined ? null : stored.minimodelModel },
      defaults: {
        provider: this.cfg.subagentProvider,
        maxcodingModel: this.cfg.maxcodingModel,
        minimodelModel: this.cfg.minimodelModel,
        omlxBaseUrl: this.cfg.omlxBaseUrl,
      },
    };
  }

  /** Validates and persists; throws on a bad value. Emits "changed" on success. */
  update(req: SubagentSettingsRequest): SubagentSettingsResponse {
    const next = this.loadStored();

    if (req.provider !== undefined) {
      if (!isSubagentProvider(req.provider)) {
        throw new Error(`provider must be one of ${SUBAGENT_PROVIDERS.join(", ")}`);
      }
      next.provider = req.provider;
    }

    if (req.omlxBaseUrl !== undefined) {
      if (!isNonEmptyString(req.omlxBaseUrl)) {
        throw new Error("omlxBaseUrl must be a non-empty string");
      }
      next.omlxBaseUrl = req.omlxBaseUrl;
    }

    if (req.maxcoding !== undefined) {
      const model = req.maxcoding.model;
      if (model !== null && !isNonEmptyString(model)) {
        throw new Error("maxcoding.model must be a non-empty string or null");
      }
      next.maxcodingModel = model;
    }

    if (req.minimodel !== undefined) {
      const model = req.minimodel.model;
      if (model !== null && !isNonEmptyString(model)) {
        throw new Error("minimodel.model must be a non-empty string or null");
      }
      next.minimodelModel = model;
    }

    this.saveStored(next);
    subagentSettingsEvents.emit("changed");
    return this.get();
  }
}