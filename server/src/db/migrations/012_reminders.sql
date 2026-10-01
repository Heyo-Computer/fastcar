-- Follow-up reminders an agent sets for itself.
--
-- A reminder belongs to the thread that created it: when it comes due, the
-- sweep posts its message back into that thread as a new turn, so the agent
-- wakes with the full context of why it wanted reminding. Deleting the thread
-- takes its reminders with it.
CREATE TABLE reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  -- What the agent is told when the reminder fires.
  message     text NOT NULL,
  due_at      timestamptz NOT NULL,
  -- pending → firing (claimed by a sweep) → fired. A sweep that finds the
  -- thread busy hands it back to pending; one that cannot deliver at all
  -- (thread gone, conductor broken) marks it error.
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','firing','fired','cancelled','error')),
  attempts    integer NOT NULL DEFAULT 0,
  fired_at    timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Partial: the sweep only ever asks for pending reminders that are due.
CREATE INDEX reminders_due ON reminders (due_at) WHERE status = 'pending';
CREATE INDEX reminders_thread ON reminders (thread_id, due_at);
