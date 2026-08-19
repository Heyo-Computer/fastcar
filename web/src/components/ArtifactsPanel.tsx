import { useEffect, useState } from "react";
import type { ArtifactNode } from "@fastcar/shared";
import { useStore } from "../state/store.ts";

/**
 * Feature 1: nested user-created artifacts under a thread.
 * Shows a collapsible tree of artifacts with an "Add Artifact" button that
 * opens a modal for file upload or markdown entry and parent selection.
 */
export function ArtifactsPanel({ threadId }: { threadId: string }) {
  const tree = useStore((s) => s.artifactTrees[threadId] ?? []);
  const loadArtifacts = useStore((s) => s.loadArtifacts);
  const setModal = useStore((s) => s.setModal);

  useEffect(() => {
    void loadArtifacts(threadId);
  }, [threadId, loadArtifacts]);

  const flat = flatten(tree);
  return (
    <div className="border-t border-border">
      <div className="flex items-center px-4 pt-3 pb-1">
        <span className="text-[0.7rem] font-medium uppercase tracking-wider text-ink-faint">
          Artifacts
        </span>
        <button
          onClick={() => setModal("addArtifact")}
          title="Add an artifact (file upload or markdown)"
          className="ml-auto rounded px-1.5 text-sm text-ink-faint hover:bg-panel-2 hover:text-accent"
        >
          +
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto px-2 pb-3">
        {!flat.length && (
          <p className="px-2 py-1 text-[0.72rem] text-ink-faint">
            No artifacts yet — add one above.
          </p>
        )}
        {tree.map((node) => (
          <ArtifactRow key={node.id} node={node} depth={0} />
        ))}
      </div>
    </div>
  );
}

function ArtifactRow({ node, depth }: { node: ArtifactNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div
        className="group flex items-center gap-1.5 rounded-lg px-2 py-1 text-[0.78rem] text-ink-dim hover:bg-panel-2/60"
        style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
      >
        <button
          onClick={() => hasChildren && setOpen(!open)}
          className="w-3 shrink-0 text-ink-faint"
        >
          {hasChildren ? (open ? "▾" : "▸") : "·"}
        </button>
        <span className="shrink-0 text-[0.7rem]">{iconFor(node.contentType)}</span>
        <a
          href={`/api/artifacts/${node.id}`}
          target="_blank"
          rel="noreferrer"
          title={`${node.contentType} · ${formatSize(node.size)}`}
          className="truncate text-ink hover:text-accent"
        >
          {node.name}
        </a>
        <span className="ml-auto shrink-0 font-mono text-[0.66rem] text-ink-faint">
          {formatSize(node.size)}
        </span>
      </div>
      {open && hasChildren && node.children.map((c) => (
        <ArtifactRow key={c.id} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

function flatten(nodes: ArtifactNode[]): ArtifactNode[] {
  const out: ArtifactNode[] = [];
  const walk = (ns: ArtifactNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function iconFor(contentType: string): string {
  if (contentType.startsWith("text/markdown")) return "📝";
  if (contentType.startsWith("text/")) return "📄";
  if (contentType.startsWith("image/")) return "🖼️";
  return "📦";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
