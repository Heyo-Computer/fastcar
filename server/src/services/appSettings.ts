import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  REASONING_EFFORTS,
  type AppSettingsRequest,
  type AppSettingsResponse,
  type ReasoningEffort,
} from "@fastcar/shared";
import type { Config } from "../config.js";

const SETTINGS_FILE = "settings.json";

interface StoredAppSettings {
  conductorReasoningEffort?: ReasoningEffort;
}

/** Emits "changed" (no payload) after every successful update. */
export const appSettingsEvents = new EventEmitter();

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Runtime-editable app settings (the ⚙ modal). Same shape as the SMTP store:
 * one JSON file under the data dir, env vars supply the defaults. Nothing in
 * here is secret. Today it holds the conductor's reasoning effort; the file is
 * re-read on every access so it can be edited by hand while the server runs.
 */
export class AppSettings {
  constructor(private readonly cfg: Config) {}

  private get file(): string {
    return path.join(this.cfg.dataDir, SETTINGS_FILE);
  }

  private loadStored(): StoredAppSettings {
    if (!fs.existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredAppSettings;
      return {
        conductorReasoningEffort: isReasoningEffort(raw.conductorReasoningEffort)
          ? raw.conductorReasoningEffort
          : undefined,
      };
    } catch (err) {
      console.error("failed to parse settings.json, using defaults:", err);
      return {};
    }
  }

  private saveStored(s: StoredAppSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2));
  }

  conductorReasoningEffort(): ReasoningEffort {
    return this.loadStored().conductorReasoningEffort ?? this.cfg.conductorReasoningEffort;
  }

  get(): AppSettingsResponse {
    return {
      conductor: {
        model: `inceptionlabs/${this.cfg.inceptionModel}`,
        reasoningEffort: this.conductorReasoningEffort(),
        defaultReasoningEffort: this.cfg.conductorReasoningEffort,
        maxTokens: this.cfg.inceptionMaxTokens,
      },
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
    this.saveStored(next);
    appSettingsEvents.emit("changed");
    return this.get();
  }
}
