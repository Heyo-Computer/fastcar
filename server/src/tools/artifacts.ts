import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { contentTypeForName, type ArtifactService } from "../services/artifacts.js";

export const ARTIFACT_TOOL_NAMES = ["create_artifact", "update_artifact", "list_artifacts"] as const;
export const ARTIFACT_MUTATING_TOOLS = ["create_artifact", "update_artifact"] as const;

/**
 * Agent-facing artifact tools. An artifact is a file (HTML, markdown, text,
 * JSON, ...) attached to the current thread, shown in the UI's artifacts panel
 * and served on a public URL (`/artifacts/<id>/<name>`) that needs no login.
 */
export function createArtifactTools(artifacts: ArtifactService, threadId: string) {
  const create = defineTool({
    name: "create_artifact",
    label: "Create Artifact",
    description:
      "Create an artifact — an HTML page, markdown document, or other text file — attached to this thread and published on a public URL that anyone with the link can open without signing in. Use it to deliver reports, docs, dashboards, mockups, or any rendered page. HTML must be self-contained (inline CSS/JS; no local file references). Returns the artifact id and its public URL — give that URL to the user.",
    parameters: Type.Object({
      name: Type.String({
        description: "Filename with extension, e.g. report.html or notes.md. The extension picks the content type.",
      }),
      content: Type.String({ description: "The full file content" }),
      contentType: Type.Optional(
        Type.String({ description: "MIME type override (default: inferred from the name, e.g. text/html, text/markdown)" }),
      ),
      parentArtifactId: Type.Optional(
        Type.String({ description: "Nest under an existing artifact (from list_artifacts)" }),
      ),
    }),
    execute: async (_id, params) => {
      const contentType = params.contentType?.trim() || contentTypeForName(params.name);
      const artifact = await artifacts.createFromText(
        threadId,
        params.name,
        params.content,
        contentType,
        params.parentArtifactId ?? null,
        null,
      );
      const url = artifacts.publicUrl(artifact);
      return {
        content: [
          {
            type: "text",
            text: `Created artifact ${artifact.id} (${artifact.name}, ${contentType}, ${artifact.size} bytes)\nPublic URL: ${url}`,
          },
        ],
        details: { id: artifact.id, name: artifact.name, contentType, url },
      };
    },
  });

  const update = defineTool({
    name: "update_artifact",
    label: "Update Artifact",
    description:
      "Replace the content of an existing artifact. The id and public URL stay the same, so use this to iterate on a page you already shared instead of creating a new one.",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact id (from create_artifact or list_artifacts)" }),
      content: Type.String({ description: "The full new file content" }),
    }),
    execute: async (_id, params) => {
      const artifact = await artifacts.updateContent(params.id, params.content);
      if (!artifact) {
        return { content: [{ type: "text", text: `No artifact with id ${params.id}.` }], details: { updated: false, id: params.id, url: null as string | null } };
      }
      const url = artifacts.publicUrl(artifact);
      return {
        content: [{ type: "text", text: `Updated artifact ${artifact.id} (${artifact.size} bytes)\nPublic URL: ${url}` }],
        details: { updated: true, id: artifact.id, url: url as string | null },
      };
    },
  });

  const list = defineTool({
    name: "list_artifacts",
    label: "List Artifacts",
    description: "List the artifacts attached to this thread with their ids, content types, and public URLs.",
    parameters: Type.Object({}),
    execute: async () => {
      const items = await artifacts.list(threadId);
      const text = items.length
        ? items
            .map(
              (a) =>
                `- [${a.id}] ${a.name} (${a.contentType}, ${a.size} bytes${a.parentArtifactId ? `, parent ${a.parentArtifactId}` : ""}) ${artifacts.publicUrl(a)}`,
            )
            .join("\n")
        : "No artifacts on this thread yet.";
      return { content: [{ type: "text", text }], details: { count: items.length } };
    },
  });

  return [create, update, list];
}
