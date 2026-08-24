import type { McpToolInfo, McpTransport } from "@fastcar/shared";
import { getPool } from "./pool.js";

export interface McpServerRecord {
  id: string;
  name: string;
  source: string;
  transport: McpTransport;
  url: string | null;
  path: string | null;
  command: string | null;
  args: string[];
  /** Encrypted JSON map (services/secrets.ts); "" when empty. */
  envEnc: string;
  headersEnc: string;
  tools: McpToolInfo[];
  createdAt: string;
}

interface Row {
  id: string;
  name: string;
  source: string;
  transport: string;
  url: string | null;
  path: string | null;
  command: string | null;
  args: unknown;
  env_enc: string;
  headers_enc: string;
  tools: unknown;
  created_at: Date;
}

function toRecord(row: Row): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    transport: row.transport === "http" ? "http" : "stdio",
    url: row.url,
    path: row.path,
    command: row.command,
    args: Array.isArray(row.args) ? row.args.map(String) : [],
    envEnc: row.env_enc,
    headersEnc: row.headers_enc,
    tools: Array.isArray(row.tools) ? (row.tools as McpToolInfo[]) : [],
    createdAt: row.created_at.toISOString(),
  };
}

export type NewMcpServer = Omit<McpServerRecord, "id" | "createdAt">;

export async function registerMcpServer(rec: NewMcpServer): Promise<McpServerRecord> {
  const { rows } = await getPool().query<Row>(
    `INSERT INTO mcp_servers (name, source, transport, url, path, command, args, env_enc, headers_enc, tools)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)
     ON CONFLICT (name) DO UPDATE SET
       source = EXCLUDED.source, transport = EXCLUDED.transport, url = EXCLUDED.url,
       path = EXCLUDED.path, command = EXCLUDED.command, args = EXCLUDED.args,
       env_enc = EXCLUDED.env_enc, headers_enc = EXCLUDED.headers_enc, tools = EXCLUDED.tools
     RETURNING *`,
    [
      rec.name,
      rec.source,
      rec.transport,
      rec.url,
      rec.path,
      rec.command,
      JSON.stringify(rec.args),
      rec.envEnc,
      rec.headersEnc,
      JSON.stringify(rec.tools),
    ],
  );
  return toRecord(rows[0]!);
}

export async function updateMcpServerTools(name: string, tools: McpToolInfo[]): Promise<void> {
  await getPool().query("UPDATE mcp_servers SET tools = $2::jsonb WHERE name = $1", [
    name,
    JSON.stringify(tools),
  ]);
}

export async function listMcpServers(): Promise<McpServerRecord[]> {
  const { rows } = await getPool().query<Row>("SELECT * FROM mcp_servers ORDER BY name");
  return rows.map(toRecord);
}

export async function getMcpServerByName(name: string): Promise<McpServerRecord | null> {
  const { rows } = await getPool().query<Row>("SELECT * FROM mcp_servers WHERE name = $1", [name]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function deleteMcpServer(name: string): Promise<boolean> {
  const { rowCount } = await getPool().query("DELETE FROM mcp_servers WHERE name = $1", [name]);
  return (rowCount ?? 0) > 0;
}
