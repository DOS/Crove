-- Weekly usage report for the MVP goal (issue #311, backlog review 2026-10-17 section 3 and M1-11). Idempotent;
-- applied files stay untouched.
--
-- crove_reporter           LOGIN role the image's `usage-report` role connects as. Member of no role, owns nothing, and
--                          may do exactly one thing: execute crove_kernel.usage_weekly(). It is separate from
--                          crove_prober on purpose: the prober's credentials sit in a long-running container and stay
--                          limited to health and alert state, while this report reads business activity (counts per
--                          org, and org names on request), which is the deployment owner's to see, not the monitor's.
-- crove_kernel.usage_weekly(p_weeks, p_by_org, p_time_zone)
--                          counts per ISO week (Monday 00:00 in p_time_zone) for the last p_weeks weeks, the current
--                          one included: one deployment row per week (org_id and org_name NULL), and with p_by_org one
--                          row per org that had any activity that week. Counts only: no file names, titles, payloads,
--                          emails or user ids leave the function. Sources:
--   active_users / active_orgs   distinct users with at least one successful command (audit_event, actor_type 'user',
--                          outcome 'ok') that week, and the orgs they acted in. Reads are queries and leave no audit
--                          row, so a user who only looked counts as inactive.
--   documents_uploaded / documents_emailed  new files (crove_kernel.file by source and created_at). The file table
--                          keeps one row per distinct content per org, so a re-uploaded duplicate does not count again;
--                          the ingest audit row would count it.
--   proposals_approved     successful kernel.proposal.approve rows; approved_without_edits those whose proposal has no
--                          successful kernel.proposal.edit row that changed it (detail carries `revision` only when an
--                          edit made a new revision). A re-extraction also makes a new revision but is not an edit.
--   proposals_rejected     successful kernel.proposal.reject rows.
--   median_upload_to_approval_seconds  median over that week's approvals of a proposal read from a file: approval time
--                          minus the file's created_at. NULL when there were none.
--   journal_exports        successful finance.journal.export rows (the Excel journal export).
--   org_exports            successful kernel.org.export.record rows (full org exports).
-- p_weeks is clamped to 1..104. p_time_zone is any name PostgreSQL accepts (default Asia/Ho_Chi_Minh).
-- Its password is set by `migrate` from CROVE_REPORTER_DB_PASSWORD, never here.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crove_reporter') THEN
    CREATE ROLE crove_reporter LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  -- Drift guard: the reporter only ever reads usage_weekly().
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'crove_reporter' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR NOT rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'role crove_reporter must be LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = 'crove_reporter'
  ) THEN
    RAISE EXCEPTION 'role crove_reporter must not be a member of any role';
  END IF;
  -- Defense in depth only (usage_weekly() is called schema-qualified and pins its own search_path).
  IF pg_catalog.pg_has_role(current_user, 'crove_reporter', 'MEMBER WITH ADMIN OPTION') THEN
    ALTER ROLE crove_reporter SET search_path = pg_catalog, pg_temp;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.usage_weekly(
  p_weeks int DEFAULT 8,
  p_by_org boolean DEFAULT false,
  p_time_zone text DEFAULT 'Asia/Ho_Chi_Minh'
)
RETURNS TABLE (
  week_start date,
  iso_week text,
  org_id uuid,
  org_name text,
  active_orgs int,
  active_users int,
  documents_uploaded int,
  documents_emailed int,
  proposals_approved int,
  approved_without_edits int,
  proposals_rejected int,
  median_upload_to_approval_seconds double precision,
  journal_exports int,
  org_exports int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tz text := COALESCE(NULLIF(p_time_zone, ''), 'Asia/Ho_Chi_Minh');
  v_weeks int := LEAST(GREATEST(COALESCE(p_weeks, 8), 1), 104);
  v_last date;
  v_first date;
  v_since timestamptz;
BEGIN
  -- Also refuses a definer owner reached through a mistaken grant: only the reporter login (or a superuser) reads it.
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_reporter', 'MEMBER') THEN
    RAISE EXCEPTION 'REPORTER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- An unknown zone name raises 22023 here, before any table is read.
  v_last := pg_catalog.date_trunc('week', pg_catalog.timezone(v_tz, pg_catalog.now()))::date;
  v_first := v_last - (v_weeks - 1) * 7;
  v_since := pg_catalog.timezone(v_tz, v_first::timestamp);

  RETURN QUERY
  WITH weeks AS (
    SELECT (v_first + 7 * g)::date AS week FROM pg_catalog.generate_series(0, v_weeks - 1) g
  ),
  -- Proposals an edit changed, read once rather than once per approval (an edit may predate the report's range).
  edited AS (
    SELECT DISTINCT e.org_id, e.target_id
    FROM crove_kernel.audit_event e
    WHERE e.command = 'kernel.proposal.edit' AND e.outcome = 'ok' AND e.target_id IS NOT NULL AND e.detail ? 'revision'
  ),
  ev AS (
    SELECT a.org_id, 'active'::text AS kind, a.actor_id, a.occurred_at AS happened, NULL::double precision AS seconds
    FROM crove_kernel.audit_event a
    WHERE a.occurred_at >= v_since AND a.actor_type = 'user' AND a.outcome = 'ok'
    UNION ALL
    SELECT f.org_id, 'file_' || f.source, NULL, f.created_at, NULL
    FROM crove_kernel.file f
    WHERE f.created_at >= v_since
    UNION ALL
    SELECT a.org_id,
           CASE WHEN ed.target_id IS NOT NULL THEN 'approved_edited' ELSE 'approved_unedited' END,
           NULL, a.occurred_at,
           (SELECT EXTRACT(EPOCH FROM a.occurred_at - f.created_at)::double precision
            FROM crove_kernel.proposal p
            JOIN crove_kernel.file f ON f.org_id = p.org_id AND f.id = p.source_file_id
            WHERE p.org_id = a.org_id AND p.id = a.target_id)
    FROM crove_kernel.audit_event a
    LEFT JOIN edited ed ON ed.org_id = a.org_id AND ed.target_id = a.target_id
    WHERE a.occurred_at >= v_since AND a.command = 'kernel.proposal.approve' AND a.outcome = 'ok'
    UNION ALL
    SELECT a.org_id,
           CASE a.command
             WHEN 'kernel.proposal.reject' THEN 'rejected'
             WHEN 'finance.journal.export' THEN 'journal_export'
             ELSE 'org_export'
           END,
           NULL, a.occurred_at, NULL
    FROM crove_kernel.audit_event a
    WHERE a.occurred_at >= v_since AND a.outcome = 'ok'
      AND a.command IN ('kernel.proposal.reject', 'finance.journal.export', 'kernel.org.export.record')
  ),
  bucketed AS (
    SELECT pg_catalog.date_trunc('week', pg_catalog.timezone(v_tz, ev.happened))::date AS week, ev.*
    FROM ev
  ),
  agg AS (
    SELECT b.week,
           b.org_id AS org,
           GROUPING(b.org_id) = 1 AS total,
           pg_catalog.count(DISTINCT b.org_id) FILTER (WHERE b.kind = 'active')::int AS active_orgs,
           pg_catalog.count(DISTINCT b.actor_id) FILTER (WHERE b.kind = 'active')::int AS active_users,
           pg_catalog.count(*) FILTER (WHERE b.kind = 'file_upload')::int AS documents_uploaded,
           pg_catalog.count(*) FILTER (WHERE b.kind = 'file_email')::int AS documents_emailed,
           pg_catalog.count(*) FILTER (WHERE b.kind IN ('approved_edited', 'approved_unedited'))::int AS proposals_approved,
           pg_catalog.count(*) FILTER (WHERE b.kind = 'approved_unedited')::int AS approved_without_edits,
           pg_catalog.count(*) FILTER (WHERE b.kind = 'rejected')::int AS proposals_rejected,
           pg_catalog.percentile_cont(0.5) WITHIN GROUP (ORDER BY b.seconds)
             FILTER (WHERE b.kind IN ('approved_edited', 'approved_unedited') AND b.seconds IS NOT NULL) AS median_seconds,
           pg_catalog.count(*) FILTER (WHERE b.kind = 'journal_export')::int AS journal_exports,
           pg_catalog.count(*) FILTER (WHERE b.kind = 'org_export')::int AS org_exports
    FROM bucketed b
    WHERE b.week >= v_first
    GROUP BY GROUPING SETS ((b.week), (b.week, b.org_id))
  )
  SELECT w.week, pg_catalog.to_char(w.week, 'IYYY-"W"IW'), NULL::uuid, NULL::text,
         COALESCE(t.active_orgs, 0), COALESCE(t.active_users, 0), COALESCE(t.documents_uploaded, 0),
         COALESCE(t.documents_emailed, 0), COALESCE(t.proposals_approved, 0), COALESCE(t.approved_without_edits, 0),
         COALESCE(t.proposals_rejected, 0), t.median_seconds, COALESCE(t.journal_exports, 0), COALESCE(t.org_exports, 0)
  FROM weeks w
  LEFT JOIN agg t ON t.week = w.week AND t.total
  UNION ALL
  SELECT o.week, pg_catalog.to_char(o.week, 'IYYY-"W"IW'), o.org, tn.name,
         o.active_orgs, o.active_users, o.documents_uploaded, o.documents_emailed, o.proposals_approved,
         o.approved_without_edits, o.proposals_rejected, o.median_seconds, o.journal_exports, o.org_exports
  FROM agg o
  JOIN crove_kernel.tenant tn ON tn.org_id = o.org
  WHERE p_by_org AND NOT o.total
  ORDER BY 1, 3 NULLS FIRST;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.usage_weekly(int, boolean, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA crove_kernel TO crove_reporter;
GRANT EXECUTE ON FUNCTION crove_kernel.usage_weekly(int, boolean, text) TO crove_reporter;
