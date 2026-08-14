import { useCallback, useRef, useState } from "react";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export interface MicRecorder {
  recording: boolean;
  transcribing: boolean;
  error: string | null;
  /** Start recording; resolves immediately. */
  start: () => Promise<void>;
  /** Stop, upload, and resolve with the transcript. */
  stop: () => Promise<string>;
  cancel: () => void;
}

export function useMicRecorder(): MicRecorder {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const cleanup = useCallback(() => {
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
    chunksRef.current = [];
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(250);
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "microphone unavailable");
      throw err;
    }
  }, []);

  const stop = useCallback(async (): Promise<string> => {
    const recorder = recorderRef.current;
    if (!recorder) return "";
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    const mimeType = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    cleanup();

    setTranscribing(true);
    try {
      const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
      const form = new FormData();
      form.append("file", blob, `recording.${ext}`);
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      if (!res.ok) throw new Error(`transcription failed (${res.status})`);
      const data = (await res.json()) as { text?: string };
      return data.text ?? "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "transcription failed");
      return "";
    } finally {
      setTranscribing(false);
    }
  }, [cleanup]);

  return { recording, transcribing, error, start, stop, cancel: cleanup };
}
