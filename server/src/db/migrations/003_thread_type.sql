-- Feature 3: prompt threads + Feature 1 artifact linking.
-- thread_type distinguishes interactive "chat" threads from "prompt" threads
-- that auto-run a template and POST the result to a webhook. prompt_config_json
-- holds the PromptThreadConfig (template id, webhook url, encrypted token flag,
-- delivery status + response). The bearer token itself is never stored in PG;
-- it lives encrypted in the app's data dir and is referenced by status only.
-- owner_id records who created the thread, used by the artifact permission
-- check (only the thread owner or an authorized agent may create artifacts).
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS thread_type text NOT NULL DEFAULT 'chat'
    CHECK (thread_type IN ('chat','prompt')),
  ADD COLUMN IF NOT EXISTS prompt_config_json jsonb,
  ADD COLUMN IF NOT EXISTS owner_id text;

-- Feature 1: user-created nested artifacts under a thread.
-- Binary/content lives under data/artifacts/; this table is metadata only.
CREATE TABLE artifacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id          uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
  name               text NOT NULL,
  content_type       text NOT NULL DEFAULT 'application/octet-stream',
  size               bigint NOT NULL DEFAULT 0,
  storage_path       text NOT NULL,
  owner_id           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_thread ON artifacts (thread_id);
CREATE INDEX artifacts_parent ON artifacts (parent_artifact_id);
