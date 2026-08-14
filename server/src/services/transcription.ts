import type { Config } from "../config.js";

/**
 * Speech-to-text via OpenRouter's dedicated transcription endpoint.
 * This is NOT a chat model and is never registered in the Pi ModelRuntime.
 */
export async function transcribeAudio(
  cfg: Config,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<string> {
  const base = cfg.mock ? `http://127.0.0.1:${cfg.mockPort}/api/v1` : "https://openrouter.ai/api/v1";
  const form = new FormData();
  form.append("model", cfg.transcribeModel);
  form.append(
    "file",
    new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
    file.filename,
  );
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`transcription failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { text?: string };
  if (typeof data.text !== "string") throw new Error("transcription response missing text");
  return data.text;
}
