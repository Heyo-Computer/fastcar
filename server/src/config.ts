import path from "node:path";
import fs from "node:fs";

export interface Config {
  port: number;
  databaseUrl: string;
  mock: boolean;
  mockPort: number;
  workdir: string;
  dataDir: string;
  sessionDir: string;
  reposDir: string;
  gitName: string | undefined;
  gitEmail: string | undefined;
  maxcodingModel: string;
  minimodelModel: string;
  transcribeModel: string;
  tavilyApiKey: string | undefined;
  openrouterBaseUrl: string;
  inceptionBaseUrl: string;
}

export function loadConfig(): Config {
  const mock = process.env.FASTCAR_MOCK === "1";
  const mockPort = Number(process.env.FASTCAR_MOCK_PORT ?? 3210);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (!mock) {
    const missing = ["INCEPTION_API_KEY", "OPENROUTER_API_KEY"].filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(
        `Missing required env vars: ${missing.join(", ")} (set FASTCAR_MOCK=1 to run without keys)`,
      );
    }
  } else {
    // The Pi provider layer resolves "$VAR" references at request time; give the
    // mock run harmless values so auth resolution never fails.
    process.env.INCEPTION_API_KEY ??= "mock-key";
    process.env.OPENROUTER_API_KEY ??= "mock-key";
  }

  const dataDir = path.resolve(process.env.FASTCAR_DATA_DIR ?? "./.fastcar");
  const workdir = path.resolve(process.env.FASTCAR_WORKDIR || process.cwd());
  const sessionDir = path.join(dataDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });

  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl,
    mock,
    mockPort,
    workdir,
    dataDir,
    sessionDir,
    reposDir: path.resolve(process.env.FASTCAR_REPOS_DIR ?? path.join(workdir, "repos")),
    gitName: process.env.FASTCAR_GIT_NAME,
    gitEmail: process.env.FASTCAR_GIT_EMAIL,
    maxcodingModel: process.env.MAXCODING_MODEL ?? "anthropic/claude-sonnet-4.5",
    minimodelModel: process.env.MINIMODEL_MODEL ?? "google/gemini-2.5-flash-lite",
    transcribeModel: process.env.TRANSCRIBE_MODEL ?? "openai/whisper-large-v3",
    tavilyApiKey: process.env.TAVILY_API_KEY,
    openrouterBaseUrl: mock
      ? `http://127.0.0.1:${mockPort}/api/v1`
      : "https://openrouter.ai/api/v1",
    inceptionBaseUrl: mock
      ? `http://127.0.0.1:${mockPort}/v1`
      : "https://api.inceptionlabs.ai/v1",
  };
}
