import { useEffect, useState } from "react";
import type { ArtifactNode } from "@fastcar/shared";
import { useStore } from "../state/store.ts";

/**
 * Modal form for creating an artifact (Feature 1). Accepts either a file
 * upload (multipart) or a markdown body, and an optional parent artifact
 * chosen from a flattened tree dropdown.
 */
export function AddArtifactModal({ threadId }: { threadId: string }) {
  const setModal = useStore((s) => s.setModal);
  // Default outside the selector — see ArtifactsPanel; an inline `?? []` loops the render.
  const tree = useStore((s) => s.artifactTrees[threadId]) ?? [];
  const loadArtifacts = useStore((s) => s.loadArtifacts);

  const [mode, setMode] = useState<"markdown" | "file">("markdown");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [parent, setParent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadArtifacts(threadId);
  }, [threadId, loadArtifacts]);

  const parents = flatten(tree);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "file") {
        if (!file) {
          setError("Pick a file to upload.");
          setBusy(false);
          return;
        }
        const form = new FormData();
        form.append("file", file, file.name);
        if (parent) form.append("parentArtifactId", parent);
        const res = await fetch(`/api/threads/${threadId}/artifacts`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `upload failed (${res.status})`);
        }
      } else {
        if (!name.trim() || !content.trim()) {
          setError("Name and content are required.");
          setBusy(false);
          return;
        }
        const res = await fetch(`/api/threads/${threadId}/artifacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            content,
            contentType: "text/markdown",
            parentArtifactId: parent || undefined,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `create failed (${res.status})`);
        }
      }
      await loadArtifacts(threadId);
      setModal("none");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Add artifact" onClose={() => setModal("none")}>
      <div className="flex overflow-hidden rounded-lg border border-border text-[0.72rem]">
        {(["markdown", "file"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1 uppercase tracking-wide ${
              mode === m ? "bg-accent-dim/20 text-accent" : "text-ink-faint hover:text-ink-dim"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "markdown" ? (
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Artifact name (e.g. notes.md)"
            className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Markdown content…"
            rows={8}
            className="w-full resize-y rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
          />
        </div>
      ) : (
        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm text-ink-dim file:mr-3 file:rounded-lg file:border file:border-border file:bg-panel-2 file:px-3 file:py-1.5 file:text-sm file:text-ink"
        />
      )}

      <label className="block text-[0.72rem] text-ink-faint">
        Parent artifact (optional)
        <select
          value={parent}
          onChange={(e) => setParent(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
        >
          <option value="">(root — no parent)</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {"  ".repeat(p.depth)}{p.name}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="text-[0.72rem] text-danger">⚠ {error}</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={() => setModal("none")}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-dim hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-lg border border-accent-dim/50 bg-accent-dim/20 px-4 py-1.5 text-sm text-accent hover:bg-accent-dim/30 disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </ModalShell>
  );
}

function flatten(nodes: ArtifactNode[]): Array<{ id: string; name: string; depth: number }> {
  const out: Array<{ id: string; name: string; depth: number }> = [];
  const walk = (ns: ArtifactNode[], depth: number) => {
    for (const n of ns) {
      out.push({ id: n.id, name: n.name, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

export function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg space-y-3 rounded-2xl border border-border bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <h3 className="font-medium text-ink">{title}</h3>
          <button
            onClick={onClose}
            className="ml-auto rounded px-1.5 text-ink-faint hover:bg-panel-2 hover:text-ink"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
