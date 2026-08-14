CREATE TABLE repos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL UNIQUE,
  url            text NOT NULL,
  path           text NOT NULL,
  default_branch text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
