import type { FastifyInstance } from "fastify";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import {
  isInlineContentType,
  PUBLIC_ARTIFACT_PREFIX,
  type ArtifactService,
} from "../services/artifacts.js";

/**
 * The canonical, unauthenticated artifact endpoint:
 *
 *   GET /artifacts/:id            -> the artifact's bytes
 *   GET /artifacts/:id/:name      -> same; the name only decorates the URL
 *   GET /artifacts/:id?raw=1      -> skip markdown rendering
 *
 * Everything under `/artifacts/` is meant to be public: deploy/fastcar.json
 * lists the prefix in `auth.public_paths` so app-lb's sign-in gate skips it.
 * Artifact ids are UUIDs, so the URL itself is the capability — there is no
 * listing endpoint here and `/api/*` stays behind the gate.
 *
 * HTML artifacts are served as-is so they render (scripts included — they are
 * the agent's own pages). Markdown is rendered to a minimal standalone HTML
 * page unless `?raw=1` asks for the source.
 */
export function registerPublicArtifactRoutes(app: FastifyInstance, artifacts: ArtifactService): void {
  const handler = async (
    req: { params: { artifactId: string }; query: { raw?: string } },
    reply: import("fastify").FastifyReply,
  ) => {
    const rec = await artifacts.getArtifact(req.params.artifactId);
    if (!rec) return reply.code(404).type("text/plain").send("no such artifact");
    const bytes = await artifacts.readContent(rec.id);
    if (!bytes) return reply.code(404).type("text/plain").send("artifact content missing");

    const raw = req.query.raw === "1" || req.query.raw === "true";
    const base = rec.contentType.split(";")[0]!.trim().toLowerCase();

    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-cache");

    if (base === "text/markdown" && !raw) {
      return reply.type("text/html; charset=utf-8").send(renderMarkdownPage(rec.name, bytes.toString("utf8")));
    }
    if (base === "text/html") {
      return reply.type("text/html; charset=utf-8").send(bytes);
    }
    const isText = base.startsWith("text/") || base === "application/json";
    const type = isText && !rec.contentType.includes("charset") ? `${rec.contentType}; charset=utf-8` : rec.contentType;
    if (!isInlineContentType(base)) {
      reply.header("Content-Disposition", `attachment; filename="${safeFilename(rec.name)}"`);
    }
    return reply.type(type).send(bytes);
  };

  app.get<{ Params: { artifactId: string }; Querystring: { raw?: string } }>(
    `${PUBLIC_ARTIFACT_PREFIX}:artifactId`,
    handler,
  );
  app.get<{ Params: { artifactId: string; name: string }; Querystring: { raw?: string } }>(
    `${PUBLIC_ARTIFACT_PREFIX}:artifactId/:name`,
    handler,
  );
}

function safeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "artifact";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function renderMarkdownPage(title: string, markdown: string): string {
  const body = micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()], allowDangerousHtml: true });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 52rem; margin: 2rem auto; padding: 0 1.25rem; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  pre { overflow-x: auto; padding: .75rem 1rem; border-radius: 6px; background: rgba(127,127,127,.12); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
  table { border-collapse: collapse; } th, td { border: 1px solid rgba(127,127,127,.4); padding: .3rem .6rem; }
  img { max-width: 100%; }
  blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid rgba(127,127,127,.5); opacity: .9; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
