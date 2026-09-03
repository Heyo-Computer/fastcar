import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ReasoningEffort, SubagentProvider } from "@fastcar/shared";
import type { Config } from "../config.js";

export interface FastcarModels {
  runtime: ModelRuntime;
  conductor: Model<any>;
  maxcoding: Model<any>;
  minimodel: Model<any>;
}

/** Provider id the Pi runtime uses for each subagent provider. */
export const SUBAGENT_PROVIDER_IDS: Record<SubagentProvider, string> = {
  openrouter: "openrouter",
  omlx: "omlx",
};

/**
 * The conductor's user-facing effort setting expressed as the Pi thinking level
 * that the model's thinkingLevelMap turns back into Mercury's reasoning_effort.
 */
export function conductorEffortToThinkingLevel(effort: ReasoningEffort): ThinkingLevel {
  switch (effort) {
    case "instant":
      return "low";
    case "high":
      return "high";
    default:
      return "medium";
  }
}

/**
 * One shared ModelRuntime for the whole app: the conductor and every subagent
 * session route through it. InceptionLabs is registered explicitly; OpenRouter
 * is a Pi built-in (reads OPENROUTER_API_KEY). Auth/model state lives under the
 * app's own data dir so we never touch ~/.pi.
 */
export async function buildModels(cfg: Config): Promise<FastcarModels> {
  const runtime = await ModelRuntime.create({
    authPath: path.join(cfg.dataDir, "pi-auth.json"),
    modelsPath: path.join(cfg.dataDir, "pi-models.json"),
    allowModelNetwork: false,
  });

  runtime.registerProvider("inceptionlabs", {
    name: "InceptionLabs",
    baseUrl: cfg.inceptionBaseUrl,
    apiKey: "$INCEPTION_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: cfg.inceptionModel,
        name: cfg.inceptionModel,
        // Mercury 2.5 takes OpenAI-style `reasoning_effort`; Pi only emits it
        // when the model is flagged as reasoning-capable.
        reasoning: true,
        // Pi thinking level -> Mercury reasoning_effort (instant | medium | high).
        // `off` is unsupported (null) so the session always sends an explicit
        // effort; see conductorEffortToThinkingLevel().
        thinkingLevelMap: {
          off: null,
          minimal: "instant",
          low: "instant",
          medium: "medium",
          high: "high",
        },
        input: ["text"],
        contextWindow: 128000,
        // Shared budget for reasoning + answer (InceptionLabs recommends 8192
        // by default; more is needed at high effort).
        maxTokens: cfg.inceptionMaxTokens,
        cost: { input: 0.25, output: 0.75, cacheRead: 0.025, cacheWrite: 0 },
        compat: {
          // Mercury is a diffusion LM behind an OpenAI-compatible API; keep the
          // request surface conservative apart from reasoning_effort.
          supportsStrictMode: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });

  // In mock mode, shadow the built-in OpenRouter provider with one pointed at
  // the local mock server so subagents need no real key either.
  if (cfg.mock) {
    registerMockOpenRouter(runtime, cfg);
  }

  // Register the OMLX provider (OpenAI-compatible, self-hosted) with the
  // boot-time base URL. The base URL can be changed at runtime via the
  // subagent settings; resolveSubagentModel re-registers it on demand so the
  // live setting always wins. Auth is resolved from OMLX_API_KEY at request
  // time via the "$VAR" reference, mirroring OPENROUTER_API_KEY. In mock
  // mode the provider is pointed at the local mock server so subagent runs
  // need no real OMLX endpoint either.
  registerOmlxProvider(runtime, cfg, cfg.mock ? cfg.inceptionBaseUrl : cfg.omlxBaseUrl);

  const conductor = runtime.getModel("inceptionlabs", cfg.inceptionModel);
  if (!conductor) throw new Error(`failed to register inceptionlabs/${cfg.inceptionModel}`);

  const maxcoding = getOrRegisterOpenRouterModel(runtime, cfg, cfg.maxcodingModel);
  const minimodel = getOrRegisterOpenRouterModel(runtime, cfg, cfg.minimodelModel);

  return { runtime, conductor, maxcoding, minimodel };
}

/**
 * Resolve an OpenRouter model by slug. Pi ships a static OpenRouter catalog;
 * user-specified slugs (MAXCODING_MODEL) may not be in it, so fall back to
 * registering the slug on a thin overlay provider with sane defaults.
 */
function getOrRegisterOpenRouterModel(
  runtime: ModelRuntime,
  cfg: Config,
  slug: string,
): Model<any> {
  const providerId = cfg.mock ? "openrouter-mock" : "openrouter";
  const existing = runtime.getModel(providerId, slug);
  if (existing) return existing;

  runtime.registerProvider("openrouter-extra", {
    name: "OpenRouter",
    baseUrl: cfg.openrouterBaseUrl,
    apiKey: "$OPENROUTER_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: [
      ...collectExtraModels(runtime),
      {
        id: slug,
        name: slug,
        reasoning: false,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 32000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { thinkingFormat: "openrouter" },
      },
    ],
  });
  const model = runtime.getModel("openrouter-extra", slug);
  if (!model) throw new Error(`failed to register OpenRouter model ${slug}`);
  return model;
}

/** registerProvider replaces the provider config, so re-collect prior extras. */
function collectExtraModels(runtime: ModelRuntime) {
  const provider = runtime.getProvider("openrouter-extra");
  if (!provider) return [];
  return runtime.getModels("openrouter-extra").map((m: Model<any>) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input as ("text" | "image")[],
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: m.cost,
    compat: m.compat,
  }));
}

function registerMockOpenRouter(runtime: ModelRuntime, cfg: Config): void {
  const models = [cfg.maxcodingModel, cfg.minimodelModel].map((id) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  runtime.registerProvider("openrouter-mock", {
    name: "OpenRouter (mock)",
    baseUrl: cfg.openrouterBaseUrl,
    apiKey: "$OPENROUTER_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models,
  });
}

/**
 * Register (or replace) the OMLX provider with the given base URL. OMLX is an
 * OpenAI-compatible endpoint, so it uses the same completions API and bearer
 * auth as OpenRouter; the model catalog is thin overlays registered on demand
 * by resolveSubagentModel.
 */
export function registerOmlxProvider(runtime: ModelRuntime, cfg: Config, baseUrl: string): void {
  const providerId = cfg.mock ? "omlx-mock" : SUBAGENT_PROVIDER_IDS.omlx;
  runtime.registerProvider(providerId, {
    name: "OMLX",
    baseUrl,
    apiKey: "$OMLX_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: collectProviderModels(runtime, providerId),
  });
}

/** Collect a provider's existing model defs so re-registering keeps them. */
function collectProviderModels(runtime: ModelRuntime, providerId: string) {
  const provider = runtime.getProvider(providerId);
  if (!provider) return [];
  return runtime.getModels(providerId).map((m: Model<any>) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input as ("text" | "image")[],
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: m.cost,
    compat: m.compat,
  }));
}

/**
 * Resolve the Pi model for a subagent run, honouring the live settings:
 * - provider picks the OpenRouter vs OMLX provider;
 * - the per-kind model slug overrides the env default (null = env default);
 * - unknown slugs are registered as thin overlays with sane defaults, exactly
 *   like the env-slug path in getOrRegisterOpenRouterModel.
 *
 * Falls back to the boot-time models[kind] when settings are absent.
 */
export function resolveSubagentModel(
  runtime: ModelRuntime,
  cfg: Config,
  kind: "maxcoding" | "minimodel",
  opts: {
    provider: SubagentProvider;
    omlxBaseUrl: string;
    model: string | null;
  },
): Model<any> {
  const envDefault = kind === "maxcoding" ? cfg.maxcodingModel : cfg.minimodelModel;
  const slug = opts.model ?? envDefault;

  if (opts.provider === "omlx") {
    const providerId = cfg.mock ? "omlx-mock" : SUBAGENT_PROVIDER_IDS.omlx;
    // In mock mode, ignore the configured base URL and point at the local
    // mock server (mirroring openrouter-mock) so keyless dev/test runs work.
    const baseUrl = cfg.mock ? cfg.inceptionBaseUrl : opts.omlxBaseUrl;
    // The base URL may have changed since buildModels ran; re-register to be
    // sure the live setting is in effect. Re-registering replaces the config
    // but preserves the model list via collectProviderModels.
    if (runtime.getProvider(providerId)?.baseUrl !== baseUrl) {
      registerOmlxProvider(runtime, cfg, baseUrl);
    }
    const existing = runtime.getModel(providerId, slug);
    if (existing) return existing;
    runtime.registerProvider(providerId, {
      name: "OMLX",
      baseUrl,
      apiKey: "$OMLX_API_KEY",
      api: "openai-completions",
      authHeader: true,
      models: [
        ...collectProviderModels(runtime, providerId),
        {
          id: slug,
          name: slug,
          reasoning: false,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 32000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const model = runtime.getModel(providerId, slug);
    if (!model) throw new Error(`failed to register OMLX model ${slug}`);
    return model;
  }

  // openrouter: same thin-overlay path the env config already uses.
  return getOrRegisterOpenRouterModel(runtime, cfg, slug);
}
