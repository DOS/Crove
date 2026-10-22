-- Detective security alerts (issue #996, plan §7.8 "Detective controls (with alerts)"). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.security_signal_seen   what the worker last alerted about, one row per signal and subject, so several
--                                     workers alert once and a lasting signal repeats only after p_repeat_seconds.
--                                     Global machinery table without org_id: RLS on, no policy, no grants.
-- crove_kernel.security_signals(...)  the signals over the last p_window_seconds that are worth an alert now:
--   actor_many_orgs    a user with successful or refused commands in more than p_org_threshold orgs (cross-org probing,
--                      or a stolen account walking the orgs it can reach); subject is the user id.
--   refusal_spike      refusals across the deployment above p_refusal_threshold: the refusal tally (#162, every
--                      refusal counted, NOT_A_MEMBER and permission errors included); subject 'deployment'.
--   privileged_grant   an owner or admin role given in an org, by a role change or an invite acceptance (org creation
--                      is not a grant); subject is the audit row's id.
--   It answers ids and counts only: no email, name or command input. Only the worker login role may execute it, and it
--   refuses any other session even with EXECUTE granted by mistake.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.security_signal_seen (
  signal text NOT NULL CHECK (signal IN ('actor_many_orgs', 'refusal_spike', 'privileged_grant')),
  subject text NOT NULL CHECK (pg_catalog.length(subject) BETWEEN 1 AND 100),
  alerted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signal, subject)
);
CREATE INDEX IF NOT EXISTS security_signal_seen_alerted_idx ON crove_kernel.security_signal_seen (alerted_at);
REVOKE ALL ON crove_kernel.security_signal_seen FROM PUBLIC, crove_tenant, crove_app, crove_worker;
ALTER TABLE crove_kernel.security_signal_seen ENABLE ROW LEVEL SECURITY;
-- An agent context never writes it (T18): the guard every crove_* table carries.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.security_signal_seen');

-- The check reads the last minutes of audit rows across every org; the existing index leads with org_id.
CREATE INDEX IF NOT EXISTS audit_event_occurred_idx ON crove_kernel.audit_event (occurred_at);

-- p_window_seconds is clamped to 60 s..1 d, p_repeat_seconds to 5 min..7 d; thresholds to 1..1000000.
CREATE OR REPLACE FUNCTION crove_kernel.security_signals(
  p_window_seconds int, p_org_threshold int, p_refusal_threshold int, p_repeat_seconds int)
RETURNS TABLE (signal text, subject text, value bigint, org_id uuid, detail text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_since timestamptz := pg_catalog.now() - pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_window_seconds, 300), 60), 86400));
  v_repeat interval := pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_repeat_seconds, 3600), 300), 604800));
  v_orgs int := LEAST(GREATEST(COALESCE(p_org_threshold, 20), 1), 1000000);
  v_refusals int := LEAST(GREATEST(COALESCE(p_refusal_threshold, 500), 1), 1000000);
  v_row record;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SECURITY_SIGNALS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- Old memory goes: a signal not seen for a week alerts again as new.
  DELETE FROM crove_kernel.security_signal_seen s WHERE s.alerted_at < pg_catalog.now() - interval '7 days';

  FOR v_row IN
    SELECT 'actor_many_orgs'::text AS sig, a.actor_id::text AS subj, pg_catalog.count(DISTINCT a.org_id) AS val, NULL::uuid AS org,
           'orgs touched in the window'::text AS what
    FROM crove_kernel.audit_event a
    WHERE a.occurred_at >= v_since AND a.actor_type = 'user' AND a.actor_id IS NOT NULL
    GROUP BY a.actor_id
    HAVING pg_catalog.count(DISTINCT a.org_id) > v_orgs
    UNION ALL
    SELECT 'refusal_spike', 'deployment', t.total, NULL, 'refusals in the window'
    FROM (
      SELECT coalesce(pg_catalog.sum(r.refusals), 0)::bigint AS total
      FROM crove_kernel.refusal_tally r WHERE r.last_at >= v_since
    ) t
    WHERE t.total > v_refusals
    UNION ALL
    SELECT 'privileged_grant', a.id::text, 1, a.org_id, a.detail ->> 'role'
    FROM crove_kernel.audit_event a
    WHERE a.occurred_at >= v_since AND a.outcome = 'ok'
      AND a.command IN ('kernel.member.change_role', 'kernel.member.invite.accept')
      AND a.detail ->> 'role' IN ('owner', 'admin')
      AND (a.detail ->> 'previous_role') IS DISTINCT FROM (a.detail ->> 'role')
  LOOP
    -- Alert when the signal is new or its last alert is older than the repeat interval; a grant alerts once.
    INSERT INTO crove_kernel.security_signal_seen AS s (signal, subject, alerted_at)
    VALUES (v_row.sig, v_row.subj, pg_catalog.now())
    ON CONFLICT ON CONSTRAINT security_signal_seen_pkey DO UPDATE SET alerted_at = excluded.alerted_at
      WHERE s.alerted_at < pg_catalog.now() - v_repeat AND s.signal <> 'privileged_grant';
    IF FOUND THEN
      signal := v_row.sig;
      subject := v_row.subj;
      value := v_row.val;
      org_id := v_row.org;
      detail := v_row.what;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- EXECUTE matrix: only the worker login role.
REVOKE ALL ON FUNCTION crove_kernel.security_signals(int, int, int, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.security_signals(int, int, int, int) TO crove_worker;
