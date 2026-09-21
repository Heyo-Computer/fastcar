-- Inbox: one row per thread, latest reply.
--
-- Denormalised onto `threads` rather than given its own table. The inbox is
-- strictly 1:1 with threads, so a separate table would duplicate every
-- thread's lifecycle (create, rename, delete-cascade, archive) and add a class
-- of bug where the two disagree. Every write point already calls
-- threadsDb.updateThread(), so these columns join an UPDATE that was happening
-- anyway, and emitStatus() already re-reads the row and broadcasts
-- thread_updated — so the inbox live-updates with no new broadcast plumbing.
ALTER TABLE threads
  ADD COLUMN last_message_at      timestamptz,
  ADD COLUMN last_message_preview text,
  -- Slug of whoever produced that last message (an agent, or a subagent).
  ADD COLUMN last_message_agent   text,
  ADD COLUMN last_error           text,
  ADD COLUMN read_at              timestamptz,
  -- How the thread was started. Deliberately separate from thread_type, which
  -- is CHECK-constrained to ('chat','prompt') and asserted in the tests: a
  -- scheduled run is an ordinary chat thread with source='schedule'.
  ADD COLUMN source               text NOT NULL DEFAULT 'chat'
             CHECK (source IN ('chat','prompt','schedule','trigger'));

UPDATE threads SET source = 'prompt' WHERE thread_type = 'prompt';

-- Backfill from the last assistant message so the inbox is not empty on first
-- load. left(...) mirrors the 240-char preview the writer produces.
UPDATE threads t
SET last_message_at      = e.created_at,
    last_message_preview = left(regexp_replace(coalesce(e.payload->>'text', ''), '\s+', ' ', 'g'), 240),
    last_message_agent   = e.agent
FROM (
  SELECT DISTINCT ON (thread_id) thread_id, agent, payload, created_at
  FROM events
  WHERE kind = 'assistant_text'
  ORDER BY thread_id, seq DESC
) e
WHERE e.thread_id = t.id AND coalesce(e.payload->>'text', '') <> '';

-- Feed ordering, and the unread count. Unread is a rule, not a stored flag:
--   last_message_at IS NOT NULL AND (read_at IS NULL OR read_at < last_message_at)
-- so a new reply after you have read re-marks the thread unread with no
-- invalidation step anywhere.
CREATE INDEX threads_inbox  ON threads (archived, last_message_at DESC NULLS LAST);
CREATE INDEX threads_unread ON threads (agent_id) WHERE read_at IS NULL;
