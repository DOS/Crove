-- Crove kernel: the text of a forwarded mail, kept with the inbound message (issue #779). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.inbound_message.body_text  the mail's text part (its text/plain part, or its HTML reduced to text), at
--                              most 20,000 characters, as the extract container read it; NULL for a mail received
--                              before this column, or with no text. A member may start an AI draft of a Social post
--                              from it (*Soạn bài đăng từ thư này*), where it is tainted, untrusted input fenced in the
--                              writer's prompt; nothing posts from a mail by itself. The row's row-level security, org
--                              purge (the whole row) and offboarding export (every column) do not change. A person's
--                              erasure clears it with the sender's address (packages/kernel/src/personal-data.ts).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.inbound_message ADD COLUMN IF NOT EXISTS body_text text;

-- NOT VALID: added without scanning the table under its exclusive lock; validated below (every existing row is NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.inbound_message'::regclass AND conname = 'inbound_message_body_text_check'
  ) THEN
    ALTER TABLE crove_kernel.inbound_message ADD CONSTRAINT inbound_message_body_text_check
      CHECK (body_text IS NULL OR (pg_catalog.char_length(body_text) BETWEEN 1 AND 20000)) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_kernel.inbound_message VALIDATE CONSTRAINT inbound_message_body_text_check;
