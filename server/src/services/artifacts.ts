import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Artifact, ArtifactNode } from "@fastcar/shared";
import type { Config } from "../config.js";
import {
  deleteArtifactRow,
  getArtifact,
  insertArtifact,
  listArtifactsForThread,
  touchArtifact,
  type ArtifactRecord,
} from "../db/artifacts.js";
import { getThread } from "../db/threads.js";

/**
 * Artifact storage: metadata in Postgres, bytes/content under
 * `<dataDir>/artifacts/<threadId>/<artifactId>`. The on-disk filename is the
 * artifact id (stable, collision-free) while the user-facing name is kept in
 * the DB row. Deleting an artifact cascades to its children in the DB; we also
 * best-effort delete the stored file.
 */
/** Canonical public path prefix for serving artifacts (no auth). Keep in sync with deploy/fastcar.json `auth.public_paths`. */
export const PUBLIC_ARTIFACT_PREFIX = "/artifacts/";

/** Emits `changed` with the thread id whenever an artifact is created, updated or deleted. */
export const artifactEvents = new EventEmitter<{ changed: [threadId: string] }>();

/** Content types browsers can render inline; everything else is served as a download. */
const INLINE_TYPES = /^(text\/(html|markdown|plain|css|csv)|image\/|application\/(json|pdf)|video\/|audio\/)/;

export function isInlineContentType(contentType: string): boolean {
  return INLINE_TYPES.test(contentType);
}

/** Guess a content type from a filename extension (html and markdown are first-class). */
export function contentTypeForName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".html":
    case ".htm":
      return "text/html";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".css":
      return "text/css";
    case ".csv":
      return "text/csv";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ArtifactService {
  private readonly root: string;

  constructor(private readonly cfg: Config) {
    this.root = path.join(cfg.dataDir, "artifacts");
    fs.mkdirSync(this.root, { recursive: true });
  }

  /**
   * The canonical public URL for an artifact: `<publicUrl>/artifacts/<id>/<name>`.
   * The id is what resolves the artifact; the trailing name only gives browsers
   * a sensible filename/extension. Served without authentication by
   * `registerPublicArtifactRoutes` — and, behind app-lb, whitelisted via
   * `auth.public_paths` in the deployment JSON.
   */
  publicUrl(artifact: Pick<Artifact, "id" | "name">): string {
    return `${this.cfg.publicUrl}${this.publicPath(artifact)}`;
  }

  publicPath(artifact: Pick<Artifact, "id" | "name">): string {
    return `${PUBLIC_ARTIFACT_PREFIX}${artifact.id}/${encodeURIComponent(artifact.name)}`;
  }

  /** Public metadata view of a DB record (adds the public URL). */
  toArtifact(rec: ArtifactRecord): Artifact {
    return {
      id: rec.id,
      threadId: rec.threadId,
      parentArtifactId: rec.parentArtifactId,
      name: rec.name,
      contentType: rec.contentType,
      size: rec.size,
      ownerId: rec.ownerId,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      publicUrl: this.publicUrl(rec),
    };
  }

  private relativeStoragePath(threadId: string, artifactId: string): string {
    return path.join("artifacts", threadId, artifactId);
  }

  /**
   * Create an artifact from an inline text/markdown body.
   * Returns the metadata record (without content).
   */
  async createFromText(
    threadId: string,
    name: string,
    content: string,
    contentType: string,
    parentArtifactId: string | null,
    ownerId: string | null,
  ): Promise<Artifact> {
    const buf = Buffer.from(content, "utf8");
    const rec = await insertArtifact(
      threadId,
      parentArtifactId,
      name,
      contentType,
      buf.length,
      this.relativeStoragePath(threadId, "pending"),
      ownerId,
    );
    const abs = path.join(this.root, threadId, rec.id);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, buf);
    artifactEvents.emit("changed", threadId);
    return this.toArtifact(rec);
  }

  /**
   * Replace an artifact's content in place (same id, same public URL).
   * Returns null when the artifact does not exist.
   */
  async updateContent(id: string, content: string | Buffer): Promise<Artifact | null> {
    const rec = await this.getArtifact(id);
    if (!rec) return null;
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const abs = path.join(this.root, rec.threadId, rec.id);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, buf);
    const updated = await touchArtifact(id, buf.length);
    artifactEvents.emit("changed", rec.threadId);
    return this.toArtifact(updated ?? rec);
  }

  /**
   * Create an artifact from an uploaded file's buffer.
   */
  async createFromBuffer(
    threadId: string,
    name: string,
    buffer: Buffer,
    contentType: string,
    parentArtifactId: string | null,
    ownerId: string | null,
  ): Promise<Artifact> {
    const rec = await insertArtifact(
      threadId,
      parentArtifactId,
      name,
      contentType,
      buffer.length,
      this.relativeStoragePath(threadId, "pending"),
      ownerId,
    );
    const abs = path.join(this.root, threadId, rec.id);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, buffer);
    artifactEvents.emit("changed", threadId);
    return this.toArtifact(rec);
  }

  async getArtifact(id: string) {
    // Public URLs are user-typed: a non-UUID must be a clean 404, not a PG cast error.
    if (!UUID_RE.test(id)) return null;
    return getArtifact(id);
  }

  /** Read the raw bytes for an artifact (binary or text). */
  async readContent(id: string): Promise<Buffer | null> {
    const rec = await this.getArtifact(id);
    if (!rec) return null;
    const abs = path.join(this.root, rec.threadId, rec.id);
    try {
      return await fs.promises.readFile(abs);
    } catch {
      return null;
    }
  }

  async list(threadId: string): Promise<Artifact[]> {
    return (await listArtifactsForThread(threadId)).map((r) => this.toArtifact(r));
  }

  async listTree(threadId: string): Promise<ArtifactNode[]> {
    const records = await listArtifactsForThread(threadId);
    return buildTree(records.map((r) => this.toArtifact(r)));
  }

  async delete(id: string): Promise<boolean> {
    const rec = await this.getArtifact(id);
    if (!rec) return false;
    const ok = await deleteArtifactRow(id);
    if (ok) {
      const abs = path.join(this.root, rec.threadId, rec.id);
      await fs.promises.rm(abs, { force: true }).catch(() => {});
      artifactEvents.emit("changed", rec.threadId);
    }
    return ok;
  }

  /**
   * Permission gate for artifact creation: the caller is allowed if there is no
   * thread owner (single-user dev mode), or the caller matches the owner, or
   * the caller is flagged as an authorized agent (server-side callers).
   */
  async canCreateArtifact(
    threadId: string,
    callerId: string | null,
    isAgent: boolean,
  ): Promise<boolean> {
    const thread = await getThread(threadId);
    if (!thread) return false;
    if (thread.ownerId === null) return true;
    if (isAgent) return true;
    return callerId !== null && callerId === thread.ownerId;
  }
}

/** Build a forest of artifact nodes from a flat list, keyed by parent id. */
function buildTree(artifacts: Artifact[]): ArtifactNode[] {
  const byId = new Map<string, ArtifactNode>();
  for (const a of artifacts) byId.set(a.id, { ...a, children: [] });
  const roots: ArtifactNode[] = [];
  for (const node of byId.values()) {
    if (node.parentArtifactId && byId.has(node.parentArtifactId)) {
      byId.get(node.parentArtifactId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
