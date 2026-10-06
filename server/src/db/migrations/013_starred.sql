-- Add starred column to threads table
ALTER TABLE threads ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
