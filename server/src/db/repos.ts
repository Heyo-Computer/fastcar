import { getPool } from "./pool.js";

export interface RepoRecord {
  id: string;
  name: string;
  url: string;
  path: string;
  defaultBranch: string | null;
  createdAt: string;
}

function toRecord(row: {
  id: string;
  name: string;
  url: string;
  path: string;
  default_branch: string | null;
  created_at: Date;
}): RepoRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    path: row.path,
    defaultBranch: row.default_branch,
    createdAt: row.created_at.toISOString(),
  };
}

export async function registerRepo(
  name: string,
  url: string,
  path: string,
  defaultBranch: string | null,
): Promise<RepoRecord> {
  const { rows } = await getPool().query(
    `INSERT INTO repos (name, url, path, default_branch) VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET url = $2, path = $3, default_branch = $4
     RETURNING *`,
    [name, url, path, defaultBranch],
  );
  return toRecord(rows[0]);
}

export async function listRepos(): Promise<RepoRecord[]> {
  const { rows } = await getPool().query("SELECT * FROM repos ORDER BY name");
  return rows.map(toRecord);
}

export async function getRepoByName(name: string): Promise<RepoRecord | null> {
  const { rows } = await getPool().query("SELECT * FROM repos WHERE name = $1", [name]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function deleteRepo(name: string): Promise<boolean> {
  const { rowCount } = await getPool().query("DELETE FROM repos WHERE name = $1", [name]);
  return (rowCount ?? 0) > 0;
}
