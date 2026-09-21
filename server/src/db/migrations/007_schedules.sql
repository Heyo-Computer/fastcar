-- Schedules: cron-triggered agent runs.
--
-- A run *is* a thread (threads.schedule_id), so there is no schedule_runs
-- table: run history is `SELECT ... FROM threads WHERE schedule_id = $1`, and
-- each run's full transcript and artifacts come along with it. The last_*
-- columns are the denormalised "latest" for the list view.
CREATE TABLE schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name               text NOT NULL,
  -- What the agent is told when the schedule fires.
  prompt             text NOT NULL,
  cron               text NOT NULL,
  timezone           text NOT NULL DEFAULT 'UTC',
  mode               text NOT NULL DEFAULT 'act' CHECK (mode IN ('plan','act')),
  enabled            boolean NOT NULL DEFAULT true,
  -- false: after downtime, fire once and re-base to the next future slot.
  -- Three stale morning briefs at once is worse than one fresh one.
  catch_up           boolean NOT NULL DEFAULT false,
  webhook_url        text,

  next_run_at        timestamptz,
  last_run_at        timestamptz,
  last_run_thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  last_status        text CHECK (last_status IN ('ok','error','skipped','running')),
  last_error         text,

  owner_id           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Partial: the tick only ever asks for enabled schedules that are due.
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled;

ALTER TABLE threads
  ADD COLUMN schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL;
CREATE INDEX threads_schedule ON threads (schedule_id, created_at DESC);
