-- Email seen by the configured mailbox (IMAP) plus what the email_send tool
-- sent (SMTP).
--
-- fastcar reads the mailbox over IMAP and copies each message here, so an
-- agent can list threads, read them back and wait for replies without going
-- to the server every time. Reading here never touches the server-side \Seen
-- flag: `seen` is fastcar's own bookkeeping (what an agent has been shown),
-- exactly like signal_messages.seen.
--
-- account is the mailbox login, lowercased. thread_key is the Message-ID that
-- started the conversation: a message inherits the thread of any stored
-- message it names in In-Reply-To/References, else the first References
-- entry, else its own Message-ID.
CREATE TABLE email_messages (
  id             bigserial PRIMARY KEY,
  account        text NOT NULL,
  -- IMAP coordinates of an incoming message; NULL for outgoing ones.
  mailbox        text,
  uidvalidity    bigint,
  uid            bigint,
  message_id     text NOT NULL,
  thread_key     text NOT NULL,
  in_reply_to    text,
  refs           text[] NOT NULL DEFAULT '{}',
  direction      text NOT NULL CHECK (direction IN ('in', 'out')),
  from_addr      text,
  from_name      text,
  -- [{address, name}]
  to_addrs       jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addrs       jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_to_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject        text NOT NULL DEFAULT '',
  sent_at        timestamptz NOT NULL,
  body_text      text NOT NULL DEFAULT '',
  -- [{filename, contentType, size}] — metadata only, content is not kept.
  attachments    jsonb NOT NULL DEFAULT '[]'::jsonb,
  seen           boolean NOT NULL DEFAULT false,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account, message_id)
);

CREATE INDEX email_messages_thread_idx ON email_messages (account, thread_key, id DESC);
CREATE INDEX email_messages_unread_idx ON email_messages (account, direction, seen);

-- How far the IMAP sync has got in each mailbox. A changed uidvalidity means
-- the server renumbered the mailbox, so the sync starts over (message_id
-- dedupes whatever it fetches again).
CREATE TABLE email_sync_state (
  account     text NOT NULL,
  mailbox     text NOT NULL,
  uidvalidity bigint NOT NULL,
  last_uid    bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, mailbox)
);

-- The send-only `email` tool became email_send; agents that could send mail
-- can now also read it. The builtin conductor stores NULL (tools from code)
-- and is untouched here.
UPDATE agents
SET tools = (
  SELECT jsonb_agg(CASE WHEN t = 'email' THEN 'email_send' ELSE t END ORDER BY i)
  FROM jsonb_array_elements_text(tools) WITH ORDINALITY AS x(t, i)
) || '["email_list", "email_read"]'::jsonb
WHERE tools IS NOT NULL AND tools ? 'email';
