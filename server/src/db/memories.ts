import { getPool } from "./pool.js";

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

function toMemory(row: { id: string; content: string; tags: string[]; created_at: Date }): Memory {
  return {
    id: row.id,
    content: row.content,
    tags: row.tags,
    createdAt: row.created_at.toISOString(),
  };
}

export async function saveMemory(
  content: string,
  tags: string[],
  sourceThread?: string,
): Promise<Memory> {
  const { rows } = await getPool().query(
    "INSERT INTO memories (content, tags, source_thread) VALUES ($1, $2, $3) RETURNING *",
    [content, tags, sourceThread ?? null],
  );
  return toMemory(rows[0]);
}

export async function searchMemories(query: string, limit = 10): Promise<Memory[]> {
  const { rows } = await getPool().query(
    `SELECT *, ts_rank(tsv, websearch_to_tsquery('english', $1)) AS rank
     FROM memories
     WHERE tsv @@ websearch_to_tsquery('english', $1) OR $1 = ANY(tags)
     ORDER BY rank DESC, updated_at DESC
     LIMIT $2`,
    [query, limit],
  );
  return rows.map(toMemory);
}

export async function listMemories(limit = 50): Promise<Memory[]> {
  const { rows } = await getPool().query(
    "SELECT * FROM memories ORDER BY updated_at DESC LIMIT $1",
    [limit],
  );
  return rows.map(toMemory);
}

export async function deleteMemory(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query("DELETE FROM memories WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

/** Most recent memories, for injection into the conductor system prompt. */
export async function recentMemories(limit = 20): Promise<Memory[]> {
  return listMemories(limit);
}
