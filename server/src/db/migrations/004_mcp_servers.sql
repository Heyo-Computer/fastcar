CREATE TABLE mcp_servers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  source      text NOT NULL,
  transport   text NOT NULL,
  url         text,
  path        text,
  command     text,
  args        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Encrypted JSON objects (see services/secrets.ts); blank when empty.
  env_enc     text NOT NULL DEFAULT '',
  headers_enc text NOT NULL DEFAULT '',
  -- Last tool list the server advertised, so the prompt can name them at boot
  -- even while the server is still starting.
  tools       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
