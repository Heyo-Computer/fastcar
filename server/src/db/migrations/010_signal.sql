-- Signal messages seen by the linked signal-cli account.
--
-- signal-cli keeps no message history: a message is handed over once, as a
-- JSON-RPC `receive` notification, and is gone from the Signal server after
-- that. So this table *is* the history an agent reads a thread back from —
-- incoming messages, messages sent from the account's other devices (sync
-- messages), and the ones the signal_send tool sent. It starts empty the
-- first time fastcar receives for an account.
--
-- thread_key is `group:<base64 id>` for a group and the other party's ACI
-- (uuid) for a direct conversation, falling back to their number when Signal
-- withheld the uuid. sent_at is Signal's own message timestamp (ms): it is the
-- message's identity on the wire, the value quotes and reactions point at.
CREATE TABLE signal_messages (
  id            bigserial PRIMARY KEY,
  account       text NOT NULL,
  thread_key    text NOT NULL,
  group_id      text,
  -- Group name, or the other party's profile name on a direct thread.
  thread_name   text,
  -- The other party's number on a direct thread, for number -> thread lookups.
  peer_number   text,
  direction     text NOT NULL CHECK (direction IN ('in', 'out')),
  -- uuid (or number) of whoever wrote it; the account itself for 'out'.
  sender        text NOT NULL,
  sender_number text,
  sender_name   text,
  sent_at       bigint NOT NULL,
  body          text NOT NULL DEFAULT '',
  attachments   jsonb NOT NULL DEFAULT '[]'::jsonb,
  quote         jsonb,
  reaction      jsonb,
  edited        boolean NOT NULL DEFAULT false,
  -- An agent has been shown this message (signal_read). Drives the unread
  -- counts and what "wait for a reply" treats as new.
  seen          boolean NOT NULL DEFAULT false,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account, thread_key, sender, sent_at)
);

CREATE INDEX signal_messages_thread_idx ON signal_messages (account, thread_key, id DESC);
