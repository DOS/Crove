-- Prober alert de-duplication (issue #151, follow-up of #39). Idempotent; applied files stay untouched.
--
-- crove_kernel.prober_alert_state  one row for the deployment: the problem the prober last alerted about (the sorted
--                          names of the failing checks, NULL when healthy), when it started and when the last
--                          notification went out. Global machinery table without org_id: RLS on, no policy, no grants.
-- crove_kernel.prober_alert_gate()  the only way to read or change that row. It decides whether a probe result is
--                          worth a notification (a new problem, a changed one, a resolved one, or a repeat once
--                          p_repeat_seconds have passed) and records it. It locks the row with SKIP LOCKED: the caller
--                          keeps its transaction open while it delivers the alert and commits only when delivery
--                          worked (a failed delivery rolls back, so the next probe tries again), and a second prober
--                          that probes meanwhile gets 'busy' and sends nothing. EXECUTE for crove_prober only.

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.prober_alert_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  problem text CHECK (problem IS NULL OR (length(problem) BETWEEN 1 AND 256 AND problem ~ '^[a-z_]+(,[a-z_]+)*$')),
  started_at timestamptz,
  notified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((problem IS NULL) = (started_at IS NULL))
);
REVOKE ALL ON crove_kernel.prober_alert_state FROM PUBLIC;
ALTER TABLE crove_kernel.prober_alert_state ENABLE ROW LEVEL SECURITY;
INSERT INTO crove_kernel.prober_alert_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- p_problem: the comma-separated, sorted names of the failing checks, or NULL when every check passes.
-- p_repeat_seconds: how long the same problem stays quiet before it is repeated; 0 or NULL never repeats, other
-- values are clamped to 60 s..7 d.
-- decision: 'healthy' (nothing to say), 'new', 'changed' (another set of checks fails), 'repeat', 'resolved',
-- 'suppressed' (the same problem, alerted less than p_repeat_seconds ago) or 'busy' (another prober holds the row).
-- previous_problem, problem_since and last_notified_at describe the state before this call ('busy': all NULL).
CREATE OR REPLACE FUNCTION crove_kernel.prober_alert_gate(p_problem text, p_repeat_seconds int)
RETURNS TABLE (decision text, previous_problem text, problem_since timestamptz, last_notified_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_problem text := NULLIF(p_problem, '');
  v_now timestamptz := pg_catalog.now();
  v_repeat interval;
  v_state crove_kernel.prober_alert_state%ROWTYPE;
BEGIN
  IF v_problem IS NOT NULL AND (pg_catalog.length(v_problem) > 256 OR v_problem !~ '^[a-z_]+(,[a-z_]+)*$') THEN
    RAISE EXCEPTION 'INVALID_PROBLEM' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_repeat_seconds, 0) > 0 THEN
    v_repeat := pg_catalog.make_interval(secs => LEAST(GREATEST(p_repeat_seconds, 60), 604800));
  END IF;

  SELECT s.* INTO v_state FROM crove_kernel.prober_alert_state s WHERE s.id = 1 FOR UPDATE SKIP LOCKED;
  -- The migration seeds the row; it is restored only when it is really gone (an INSERT up front would wait on the
  -- row another prober holds, where SKIP LOCKED must answer at once).
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM crove_kernel.prober_alert_state s WHERE s.id = 1) THEN
    INSERT INTO crove_kernel.prober_alert_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    SELECT s.* INTO v_state FROM crove_kernel.prober_alert_state s WHERE s.id = 1 FOR UPDATE SKIP LOCKED;
  END IF;
  IF v_state.id IS NULL THEN
    decision := 'busy';
    RETURN NEXT;
    RETURN;
  END IF;
  previous_problem := v_state.problem;
  problem_since := v_state.started_at;
  last_notified_at := v_state.notified_at;

  IF v_problem IS NULL THEN
    IF v_state.problem IS NULL THEN
      decision := 'healthy';
    ELSE
      decision := 'resolved';
      UPDATE crove_kernel.prober_alert_state s
      SET problem = NULL, started_at = NULL, notified_at = v_now, updated_at = v_now WHERE s.id = 1;
    END IF;
  ELSIF v_state.problem IS NULL THEN
    decision := 'new';
    UPDATE crove_kernel.prober_alert_state s
    SET problem = v_problem, started_at = v_now, notified_at = v_now, updated_at = v_now WHERE s.id = 1;
  ELSIF v_state.problem <> v_problem THEN
    decision := 'changed';
    UPDATE crove_kernel.prober_alert_state s SET problem = v_problem, notified_at = v_now, updated_at = v_now WHERE s.id = 1;
  ELSIF v_repeat IS NOT NULL AND (v_state.notified_at IS NULL OR v_now - v_state.notified_at >= v_repeat) THEN
    decision := 'repeat';
    UPDATE crove_kernel.prober_alert_state s SET notified_at = v_now, updated_at = v_now WHERE s.id = 1;
  ELSE
    decision := 'suppressed';
  END IF;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.prober_alert_gate(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.prober_alert_gate(text, int) TO crove_prober;
-- Restated from 20261015234500 so this file holds on its own.
REVOKE ALL ON FUNCTION crove_kernel.health(int) FROM PUBLIC;
GRANT USAGE ON SCHEMA crove_kernel TO crove_prober;
GRANT EXECUTE ON FUNCTION crove_kernel.health(int) TO crove_prober;
