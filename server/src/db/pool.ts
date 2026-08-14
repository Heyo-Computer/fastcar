import pg from "pg";

let pool: pg.Pool | undefined;

export function getPool(databaseUrl?: string): pg.Pool {
  if (!pool) {
    const connectionString = databaseUrl ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
