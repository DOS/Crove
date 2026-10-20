-- Queued outbound mail, step E1b of the Email plan (docs/plan/email.md §3.2, ADR-0034, issue #548). Idempotent;
-- applied files stay untouched.
--
-- Added here:
--   kernel-mail-send, kernel-mail-bulk  the worker's queues: system and transactional mail at once, marketing one at a
--                       time, so a campaign never delays an invoice. 'stately' with the mail's id as singleton key: a
--                       mail is queued once and sent by one job at a time.
--   mail_queued_due     the worker's scan, across the active orgs: mail waiting to be sent ('queued'), mail whose send
--                       was started and never recorded ('sending' with its external_call still 'started' past the
--                       stale time; the worker records it 'ambiguous'), and, only when the deployment's mailer
--                       dedupes, transactional mail whose last send is unknown ('ambiguous', a few attempts at most).
--                       Marketing is never sent again after an unknown outcome. Mail the request sent itself (the
--                       invite) has no external_call and is never in it. Queued marketing comes last, so a campaign
--                       of any size never keeps an invoice or a lost send out of a pass.
--   mail_retention_purge  the 13-month and 30-day purges of mail_message: the address and subject go 13 months after
--                       the mail was written (the hash stays, so a suppression still matches), the merge data 30 days
--                       after a final status (or after an unknown outcome nobody sent again). The row guard already allows only dropping these columns.
SET LOCAL lock_timeout = '2s';

SELECT crove_jobs.create_queue(q, '{"policy":"stately","expireInSeconds":300}'::jsonb)
FROM pg_catalog.unnest(ARRAY['kernel-mail-send', 'kernel-mail-bulk']) AS q;

CREATE INDEX IF NOT EXISTS mail_message_sending_idx ON crove_kernel.mail_message (updated_at) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS mail_message_address_kept_idx ON crove_kernel.mail_message (created_at) WHERE to_address IS NOT NULL OR subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_message_payload_kept_idx ON crove_kernel.mail_message (updated_at) WHERE payload IS NOT NULL;

-- state: 'queued' (send it), 'stale' (record the lost send as ambiguous) or 'ambiguous' (send it again). attempts is the
-- mail's attempt count as read, so the worker records the attempt it found.
CREATE OR REPLACE FUNCTION crove_kernel.mail_queued_due(p_limit int, p_stale_seconds int, p_retry_ambiguous boolean)
RETURNS TABLE (org_id uuid, message_id uuid, stream text, state text, attempts int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.org_id, d.id, d.stream, d.state, d.attempts FROM (
    SELECT m.org_id, m.id, m.stream, 'queued'::text AS state, m.attempts, m.created_at
    FROM crove_kernel.mail_message m
    WHERE m.status = 'queued'
    UNION ALL
    SELECT m.org_id, m.id, m.stream, 'stale', m.attempts, m.created_at
    FROM crove_kernel.mail_message m
    JOIN crove_kernel.external_call e ON e.org_id = m.org_id AND e.key = 'mail:' || m.id::text || ':' || m.attempts::text
    WHERE m.status = 'sending' AND e.state = 'started'
      AND e.started_at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(COALESCE(p_stale_seconds, 600), 60))
    UNION ALL
    SELECT m.org_id, m.id, m.stream, 'ambiguous', m.attempts, m.created_at
    FROM crove_kernel.mail_message m
    WHERE COALESCE(p_retry_ambiguous, false) AND m.status = 'ambiguous' AND m.stream <> 'marketing' AND m.attempts < 3
      AND m.updated_at < pg_catalog.now() - interval '5 minutes'
      AND EXISTS (SELECT 1 FROM crove_kernel.external_call e WHERE e.org_id = m.org_id AND e.key = 'mail:' || m.id::text || ':' || m.attempts::text)
  ) d
  JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status = 'active'
  ORDER BY (d.state = 'queued' AND d.stream = 'marketing'), d.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000)
$$;

CREATE OR REPLACE FUNCTION crove_kernel.mail_retention_purge(p_batch int DEFAULT 10000)
RETURNS TABLE (store text, deleted int, more boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_batch int := LEAST(GREATEST(COALESCE(p_batch, 10000), 1), 10000);
  v_now timestamptz := pg_catalog.now();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'RETENTION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  store := 'kernel.mail_message.address';
  UPDATE crove_kernel.mail_message m SET to_address = NULL, subject = NULL
  WHERE (m.org_id, m.id) IN (
    SELECT e.org_id, e.id FROM crove_kernel.mail_message e
    WHERE (e.to_address IS NOT NULL OR e.subject IS NOT NULL) AND e.created_at < v_now - interval '13 months'
    LIMIT v_batch FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  more := EXISTS (
    SELECT 1 FROM crove_kernel.mail_message e
    WHERE (e.to_address IS NOT NULL OR e.subject IS NOT NULL) AND e.created_at < v_now - interval '13 months'
  );
  RETURN NEXT;

  -- A final status, or an unknown outcome left for 30 days: nothing will render the mail again.
  store := 'kernel.mail_message.payload';
  UPDATE crove_kernel.mail_message m SET payload = NULL
  WHERE (m.org_id, m.id) IN (
    SELECT e.org_id, e.id FROM crove_kernel.mail_message e
    WHERE e.payload IS NOT NULL AND e.updated_at < v_now - interval '30 days'
      AND e.status IN ('sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'ambiguous')
    LIMIT v_batch FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  more := EXISTS (
    SELECT 1 FROM crove_kernel.mail_message e
    WHERE e.payload IS NOT NULL AND e.updated_at < v_now - interval '30 days'
      AND e.status IN ('sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'ambiguous')
  );
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.mail_queued_due(int, int, boolean), crove_kernel.mail_retention_purge(int)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mail_queued_due(int, int, boolean), crove_kernel.mail_retention_purge(int) TO crove_worker;
