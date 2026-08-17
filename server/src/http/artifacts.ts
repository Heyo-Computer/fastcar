import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import MarkdownIt from "markdown-it";

/**
 * Serves the rendered Markdown documentation that lives under
 * `artifacts/docs/<name>.md` at the repository root. Each request reads the
 * file, converts it to HTML with markdown-it, and returns it as `text/html`.
 *
 * The `artifacts/docs` directory is resolved from this file's location rather
 * than the process cwd: `npm run dev` runs the script with cwd=server/, so a
 * repo-root path would otherwise be invisible.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(here, "../../../artifacts/docs");

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
});

export const artifactsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{ Params: { name: string } }>("/api/artifacts/:name", async (req, reply) => {
    const { name } = req.params;

    // Guard against path traversal: only allow a bare document name, no
    // separators or parent references.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      return reply.code(400).send({ error: "invalid artifact name" });
    }

    const file = path.resolve(DOCS_DIR, `${name}.md`);
    // path.resolve collapses `..`, so re-check the result is still inside DOCS_DIR.
    if (!file.startsWith(DOCS_DIR + path.sep)) {
      return reply.code(400).send({ error: "invalid artifact name" });
    }

    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return reply.code(404).send({ error: `no such artifact: ${name}` });
      }
      throw err;
    }

    const html = md.render(source);
    reply.type("text/html").send(html);
  });
};

export default artifactsRoutes;
