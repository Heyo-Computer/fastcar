import type { Artifact } from "@fastcar/shared";
import { getPool } from "./pool.js";

interface ArtifactRow {
  id: string;
  thread_id: string;
  parent_artifact_id: string | null;
  name: string;
  content_type: string;
  size: string | number;
  storage_path: string;
  owner_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** DB row view; the public URL is derived by ArtifactService, not stored. */
export interface ArtifactRecord extends Omit<Artifact, "publicUrl"> {
  storagePath: string;
}

function toRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    parentArtifactId: row.parent_artifact_id,
    name: row.name,
    contentType: row.content_type,
    size: Number(row.size),
    storagePath: row.storage_path,
    ownerId: row.owner_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function insertArtifact(
  threadId: string,
  parentArtifactId: string | null,
  name: string,
  contentType: string,
  size: number,
  storagePath: string,
  ownerId: string | null,
): Promise<ArtifactRecord> {
  const { rows } = await getPool().query<ArtifactRow>(
    `INSERT INTO artifacts (thread_id, parent_artifact_id, name, content_type, size, storage_path, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [threadId, parentArtifactId, name, contentType, size, storagePath, ownerId],
  );
  return toRecord(rows[0]!);
}

export async function getArtifact(id: string): Promise<ArtifactRecord | null> {
  const { rows } = await getPool().query<ArtifactRow>(
    "SELECT * FROM artifacts WHERE id = $1",
    [id],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listArtifactsForThread(threadId: string): Promise<ArtifactRecord[]> {
  const { rows } = await getPool().query<ArtifactRow>(
    "SELECT * FROM artifacts WHERE thread_id = $1 ORDER BY created_at ASC",
    [threadId],
  );
  return rows.map(toRecord);
}

export async function touchArtifact(id: string, size: number): Promise<ArtifactRecord | null> {
  const { rows } = await getPool().query<ArtifactRow>(
    "UPDATE artifacts SET size = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, size],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function deleteArtifactRow(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query("DELETE FROM artifacts WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

export async function getThreadOwner(threadId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ owner_id: string | null }>(
    "SELECT owner_id FROM threads WHERE id = $1",
    [threadId],
  );
  return rows[0]?.owner_id ?? null;
}
