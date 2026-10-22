-- Crove Social: monthly goals per org or channel, and an agency note on client report links (issue #1056).
-- Idempotent; applied files stay untouched.
--
-- crove_social.goal  the org's monthly targets, as an agency's contract states them ("12 posts and 50k reach a
--                    month"): one row for the whole org (connection_id NULL) and at most one per channel. Each count is
--                    a target from 1 to 10^12 or NULL (no target); a row has at least one. time_zone is the zone the
--                    months are counted in, the same on every row of an org (social.goal.set keeps it so). Owners and
--                    admins set and remove goals (the commands check the role); every member reads them. A channel's
--                    goals go with the channel. Progress is worked out when it is shown, never stored.
-- crove_social.report_link.note  the agency's own comment on a client report (plain text, at most 2000 characters),
--                    set when the link is made; the report page shows it as text. The public view of the report
--                    (report_link_view) returns it in its own migration.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.goal (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- NULL: the whole org, every channel together.
  connection_id uuid,
  time_zone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh' CHECK (length(time_zone) BETWEEN 1 AND 64),
  posts bigint CHECK (posts IS NULL OR posts BETWEEN 1 AND 1000000000000),
  reach bigint CHECK (reach IS NULL OR reach BETWEEN 1 AND 1000000000000),
  impressions bigint CHECK (impressions IS NULL OR impressions BETWEEN 1 AND 1000000000000),
  engagement bigint CHECK (engagement IS NULL OR engagement BETWEEN 1 AND 1000000000000),
  followers_gained bigint CHECK (followers_gained IS NULL OR followers_gained BETWEEN 1 AND 1000000000000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT goal_some_target CHECK (num_nonnulls(posts, reach, impressions, engagement, followers_gained) > 0),
  CONSTRAINT goal_connection_fk FOREIGN KEY (org_id, connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE CASCADE
);
-- One row per scope: the org's, and each channel's.
CREATE UNIQUE INDEX IF NOT EXISTS goal_scope_uq ON crove_social.goal (org_id, connection_id) NULLS NOT DISTINCT;
SELECT crove_kernel.apply_tenant_rls('crove_social.goal');
-- A goal changes its targets and zone; never its org, scope or author.
REVOKE UPDATE ON crove_social.goal FROM crove_tenant;
GRANT UPDATE (time_zone, posts, reach, impressions, engagement, followers_gained, updated_by, updated_at) ON crove_social.goal TO crove_tenant;

ALTER TABLE crove_social.report_link ADD COLUMN IF NOT EXISTS note text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'report_link_note_length' AND conrelid = 'crove_social.report_link'::regclass) THEN
    ALTER TABLE crove_social.report_link ADD CONSTRAINT report_link_note_length CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000);
  END IF;
END $$;
