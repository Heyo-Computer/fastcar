-- Dismissing a notification: hides the thread's inbox row without touching the
-- thread itself (it stays in the thread list, unlike `archived`).
--
-- A timestamp rather than a flag, for the same reason unread is a rule and not
-- a stored bit: a reply landing after the dismissal (last_message_at >
-- inbox_dismissed_at) brings the row back with nothing to invalidate.
ALTER TABLE threads ADD COLUMN inbox_dismissed_at timestamptz;
