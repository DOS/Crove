-- Crove Social: notes on calendar dates (issue #794). Idempotent.
--
-- calendar_note  a team's own mark on the calendar, such as a launch, a sale or a client event: a title over one day or
--                a range of up to 31 days, with a colour from the app's palette. Owners, admins and members add,
--                change and remove them; everyone in the org sees them. A note never blocks scheduling.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.calendar_note (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  color text NOT NULL DEFAULT 'blue' CHECK (color IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT calendar_note_range_ck CHECK (ends_on >= starts_on AND ends_on - starts_on <= 30)
);
-- The calendar reads the notes that overlap the days it shows.
CREATE INDEX IF NOT EXISTS calendar_note_days_idx ON crove_social.calendar_note (org_id, starts_on, ends_on);
SELECT crove_kernel.apply_tenant_rls('crove_social.calendar_note');
-- Who made it and when stay as they were.
REVOKE UPDATE ON crove_social.calendar_note FROM crove_tenant;
GRANT UPDATE (starts_on, ends_on, title, color, updated_by, updated_at) ON crove_social.calendar_note TO crove_tenant;
