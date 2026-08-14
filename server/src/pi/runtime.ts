import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";

export interface FastcarModels {
  runtime: ModelRuntime;
  conductor: Model<any>;
  maxcoding: Model<any>;
  minimodel: Model<any>;
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
        id: "mercury-2",
        name: "Mercury 2",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0.25, output: 0.75, cacheRead: 0, cacheWrite: 0 },
        compat: {
          // Mercury is a diffusion LM behind an OpenAI-compatible API; keep the
          // request surface conservative.
          supportsStrictMode: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ],
  });

  // In mock mode, shadow the built-in OpenRouter provider with one pointed at
  // the local mock server so subagents need no real key either.
  if (cfg.mock) {
    registerMockOpenRouter(runtime, cfg);
  }

  const conductor = runtime.getModel("inceptionlabs", "mercury-2");
  if (!conductor) throw new Error("failed to register inceptionlabs/mercury-2");

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
