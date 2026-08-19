import fs from "node:fs";
import path from "node:path";
import type { Artifact, ArtifactNode } from "@fastcar/shared";
import type { Config } from "../config.js";
import {
  deleteArtifactRow,
  getArtifact,
  insertArtifact,
  listArtifactsForThread,
} from "../db/artifacts.js";
import { getThread } from "../db/threads.js";

/**
 * Artifact storage: metadata in Postgres, bytes/content under
 * `<dataDir>/artifacts/<threadId>/<artifactId>`. The on-disk filename is the
 * artifact id (stable, collision-free) while the user-facing name is kept in
 * the DB row. Deleting an artifact cascades to its children in the DB; we also
 * best-effort delete the stored file.
 */
export class ArtifactService {
  private readonly root: string;

  constructor(private readonly cfg: Config) {
    this.root = path.join(cfg.dataDir, "artifacts");
    fs.mkdirSync(this.root, { recursive: true });
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
    return toArtifact(rec);
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
    return toArtifact(rec);
  }

  async getArtifact(id: string) {
    return getArtifact(id);
  }

  /** Read the raw bytes for an artifact (binary or text). */
  async readContent(id: string): Promise<Buffer | null> {
    const rec = await getArtifact(id);
    if (!rec) return null;
    const abs = path.join(this.root, rec.threadId, rec.id);
    try {
      return await fs.promises.readFile(abs);
    } catch {
      return null;
    }
  }

  async listTree(threadId: string): Promise<ArtifactNode[]> {
    const records = await listArtifactsForThread(threadId);
    return buildTree(records.map(toArtifact));
  }

  async delete(id: string): Promise<boolean> {
    const rec = await getArtifact(id);
    if (!rec) return false;
    const ok = await deleteArtifactRow(id);
    if (ok) {
      const abs = path.join(this.root, rec.threadId, rec.id);
      await fs.promises.rm(abs, { force: true }).catch(() => {});
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

function toArtifact(rec: {
  id: string;
  threadId: string;
  parentArtifactId: string | null;
  name: string;
  contentType: string;
  size: number;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}): Artifact {
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
  };
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
