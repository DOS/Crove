-- Scheduled client report mail (issue #704). Idempotent; applied files stay untouched.
--
-- crove_social.report_schedule      an org's schedule for mailing the client report: weekly (an ISO weekday) or monthly
--                                   (a day, 1 to 28), at an hour of its time zone; the period each mail covers, the
--                                   channels (none: all) and up to 10 recipients. Owners and admins manage it; the
--                                   worker runs it when next_run_at comes.
-- crove_social.report_schedule_run  one time a schedule sent, or a test an owner or admin sent to themselves: the
--                                   period and how many mails were queued and suppressed. Each mail is a
--                                   crove_kernel.mail_message of source social.report_schedule.run naming the run.
-- crove_social.report_link.schedule_id  the schedule a link was made for: one per recipient and send, minted when the
--                                   mail goes out so its token is only in the mail. They do not count toward the
--                                   org's live manual links and are not listed with them.
-- crove_social.report_schedules_due the worker's scan, across active orgs, of the schedules due. Ids only.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.report_schedule (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  cadence text NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  weekday smallint,
  month_day smallint,
  send_hour smallint NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),
  time_zone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh' CHECK (length(time_zone) BETWEEN 1 AND 64),
  period text NOT NULL CHECK (period IN ('previous_week', 'previous_month', 'last_7_days', 'last_30_days')),
  connection_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(connection_ids) <= 50),
  -- Checked by the commands: normalized addresses, no duplicate.
  recipients text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 10),
  paused boolean NOT NULL DEFAULT false,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT report_schedule_day CHECK (
    (cadence = 'weekly' AND weekday BETWEEN 1 AND 7 AND month_day IS NULL)
    OR (cadence = 'monthly' AND month_day BETWEEN 1 AND 28 AND weekday IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS report_schedule_due_idx ON crove_social.report_schedule (next_run_at) WHERE NOT paused;
SELECT crove_kernel.apply_tenant_rls('crove_social.report_schedule');

CREATE TABLE IF NOT EXISTS crove_social.report_schedule_run (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  schedule_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scheduled', 'test')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  mails smallint NOT NULL DEFAULT 0 CHECK (mails BETWEEN 0 AND 10),
  suppressed smallint NOT NULL DEFAULT 0 CHECK (suppressed BETWEEN 0 AND 10),
  -- The owner or admin who sent a test; none for a scheduled send.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT report_schedule_run_period CHECK (period_end > period_start),
  CONSTRAINT report_schedule_run_schedule_fk FOREIGN KEY (org_id, schedule_id) REFERENCES crove_social.report_schedule (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS report_schedule_run_schedule_idx ON crove_social.report_schedule_run (org_id, schedule_id, created_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_social.report_schedule_run');
-- A run is a record of what was sent: written once, never changed (a schedule's deletion takes its runs with it).
REVOKE UPDATE ON crove_social.report_schedule_run FROM crove_tenant;
GRANT UPDATE (mails, suppressed) ON crove_social.report_schedule_run TO crove_tenant;

ALTER TABLE crove_social.report_link ADD COLUMN IF NOT EXISTS schedule_id uuid;
CREATE INDEX IF NOT EXISTS report_link_schedule_idx ON crove_social.report_link (org_id, schedule_id) WHERE schedule_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_social.report_schedules_due(p_limit int)
RETURNS TABLE (org_id uuid, schedule_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.org_id, s.id
  FROM crove_social.report_schedule s
  JOIN crove_kernel.tenant t ON t.org_id = s.org_id AND t.status = 'active'
  WHERE NOT s.paused AND s.next_run_at <= pg_catalog.now()
  ORDER BY s.next_run_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_social.report_schedules_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.report_schedules_due(int) TO crove_worker;
