CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL DEFAULT 'New thread',
  mode            text NOT NULL DEFAULT 'act' CHECK (mode IN ('plan','act')),
  status          text NOT NULL DEFAULT 'idle'
                  CHECK (status IN ('idle','running','awaiting_input','awaiting_approval')),
  pi_session_file text,
  pending_json    jsonb,
  archived        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX threads_updated ON threads (archived, updated_at DESC);

-- UI render log ONLY. Pi's JSONL session file is the agent-context source of truth.
CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  thread_id  uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  agent      text NOT NULL DEFAULT 'conductor',
  task_id    text,
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, seq)
);
CREATE INDEX events_thread ON events (thread_id, seq);

CREATE TABLE memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content       text NOT NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  source_thread uuid REFERENCES threads(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX memories_tsv  ON memories USING gin (tsv);
CREATE INDEX memories_tags ON memories USING gin (tags);
