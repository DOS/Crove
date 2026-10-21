-- A daily cap per recipient on scheduled report mail, across orgs (issue #735). Idempotent; applied files stay
-- untouched.
--
-- An owner or admin may mail the client report to addresses that never opted in. Each org is bounded (5 schedules of
-- 10 addresses a week), but nothing bounded one address across many orgs. crove_social.report_mail_recipient_gate
-- says whether one more scheduled report may go to an address today: fewer than p_per_day report mails to its inbox
-- (crove_kernel.invite_cap_key: no +tag, no dots at Gmail) in the last 24 hours, from every org. It takes a lock on the
-- inbox until the transaction ends, so two runs at once count each other; the caller gates its recipients in one
-- order (sorted by address) so two runs never wait on each other in a cycle, and a wait is bounded at 3 seconds.
-- Only a system context (the worker's run of a schedule) may ask; the answer is a yes or no, never a count or an org.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS mail_message_report_recipient_idx
  ON crove_kernel.mail_message (crove_kernel.invite_cap_key(to_address), created_at DESC)
  WHERE source = 'social.report_schedule.run';

CREATE OR REPLACE FUNCTION crove_social.report_mail_recipient_gate(p_email text, p_per_day integer)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text;
  v_count integer;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'REPORT_MAIL_GATE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR p_per_day IS NULL OR p_per_day NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'REPORT_MAIL_GATE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_key := crove_kernel.invite_cap_key(p_email);
  -- The lock key holds a hash of the inbox, never the address.
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('social.report.recipient:' || v_key, 0));
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
  SELECT pg_catalog.count(*)::integer INTO v_count
  FROM (
    SELECT 1 FROM crove_kernel.mail_message m
    WHERE m.source = 'social.report_schedule.run'
      AND m.status <> 'suppressed'
      AND crove_kernel.invite_cap_key(m.to_address) = v_key
      AND m.created_at > pg_catalog.clock_timestamp() - interval '24 hours'
    LIMIT p_per_day
  ) recent;
  RETURN v_count < p_per_day;
END $$;

REVOKE ALL ON FUNCTION crove_social.report_mail_recipient_gate(text, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.report_mail_recipient_gate(text, integer) TO crove_worker;
