-- Agents: user-created, first-class owners of threads.
--
-- An agent replaces the conductor for the threads it owns: its own system
-- prompt, model, reasoning effort, tool allowlist and MCP subset. The existing
-- conductor is seeded here as a builtin so every current thread keeps working.
--
-- NULL on a builtin row means "resolve from code" rather than "unset". That is
-- deliberate: baking today's prompt, model and tool list into the seeded row
-- would freeze the deployed conductor at migration time, and INCEPTION_MODEL /
-- CONDUCTOR_REASONING_EFFORT / edits to CONDUCTOR_BASE would silently stop
-- taking effect. The CHECK below still requires user-created agents to be
-- complete.
CREATE TABLE agents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- URL-safe, stable, and the value written to events.agent.
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  avatar             text,

  system_prompt      text,
  model_provider     text CHECK (model_provider IN ('inceptionlabs','openrouter','omlx')),
  model_slug         text,
  -- NULL = follow the global ⚙ setting (AppSettings.conductorReasoningEffort).
  reasoning_effort   text CHECK (reasoning_effort IN ('instant','medium','high')),
  max_tokens         integer,

  -- Tool names from server/src/tools/registry.ts.
  tools              jsonb,
  -- Subset of mcp_servers.name; NULL = every installed server.
  mcp_servers        jsonb,

  supports_plan_mode boolean NOT NULL DEFAULT true,
  is_builtin         boolean NOT NULL DEFAULT false,
  archived           boolean NOT NULL DEFAULT false,
  owner_id           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agents_user_complete CHECK (
    is_builtin OR (
      system_prompt  IS NOT NULL AND
      model_provider IS NOT NULL AND
      model_slug     IS NOT NULL AND
      tools          IS NOT NULL
    )
  )
);
CREATE INDEX agents_active ON agents (archived, updated_at DESC);

INSERT INTO agents (slug, name, description, is_builtin, supports_plan_mode, avatar)
VALUES (
  'conductor',
  'Conductor',
  'The built-in orchestrator: delegates to the maxcoding and minimodel subagents.',
  true, true, '🏎️'
);

-- Nullable on purpose: createThread(mode) with no agent must keep working for
-- addRepo() and the existing tests. Unowned threads resolve to the builtin at
-- runtime. No ON DELETE: deleting an agent that still owns threads is refused
-- in the service layer rather than silently orphaning history.
ALTER TABLE threads ADD COLUMN agent_id uuid REFERENCES agents(id);
UPDATE threads SET agent_id = (SELECT id FROM agents WHERE slug = 'conductor');
CREATE INDEX threads_agent ON threads (agent_id, updated_at DESC);
