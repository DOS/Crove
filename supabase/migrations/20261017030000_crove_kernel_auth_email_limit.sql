-- Per-client budget for the emails Supabase Auth sends (issue #190, plan §5 `/auth/v1/*`). Idempotent.
--
-- Supabase Auth counts sent emails in one deployment-wide bucket (GOTRUE_RATE_LIMIT_EMAIL_SENT), so one client
-- could use it up and block confirmation and recovery emails for everyone for an hour. The kernel's /auth/v1 proxy
-- now reserves a slot here before it forwards a request that sends an email, and releases it when Supabase Auth
-- refuses the request (nothing was sent).
--
-- crove_kernel.auth_email_send       one row per reserved email: the SHA-256 of the client bucket (an IPv4 address
--                                    or an IPv6 /64), the SHA-256 of the recipient (NULL when unknown) and the time.
--                                    No address or email is stored. Global machinery table without org_id: RLS on,
--                                    no policy, no grants. Rows older than an hour are swept by every reservation
--                                    (up to 100 at a time), so the table holds about one hour of traffic.
-- crove_kernel.auth_email_reserve()  refuses (no row written) when the client bucket reserved p_client_limit in the
--                                    last hour (rule auth_email_per_client) or the recipient got one within
--                                    p_target_interval_seconds (rule auth_email_per_address); otherwise writes a row
--                                    and returns its id. retry_after_seconds says when the oldest slot frees up.
-- crove_kernel.auth_email_release()  deletes a reservation of the same client bucket.
--
-- Both run under per-client and per-recipient advisory locks (always in that order, so two calls never wait on
-- each other in a cycle), taken under a 3 s lock_timeout set around the lock and restored after it (the hardening
-- check allows no function setting beyond search_path): of concurrent requests at the limit exactly one wins, the
-- limit holds across API instances, and a wait past the timeout is refused (rule auth_email_busy, retry after 1 s)
-- instead of parking a pooled connection. Only crove_app may execute them; it already chooses the limits, which
-- come from the kernel's configuration (AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR, AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.auth_email_send (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_hash text NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
  target_hash text CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  reserved_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX IF NOT EXISTS auth_email_send_client_idx ON crove_kernel.auth_email_send (client_hash, reserved_at);
CREATE INDEX IF NOT EXISTS auth_email_send_target_idx ON crove_kernel.auth_email_send (target_hash, reserved_at)
  WHERE target_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_email_send_reserved_at_idx ON crove_kernel.auth_email_send (reserved_at);
REVOKE ALL ON TABLE crove_kernel.auth_email_send FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
ALTER TABLE crove_kernel.auth_email_send ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION crove_kernel.auth_email_reserve(
  p_client text, p_target text, p_client_limit integer, p_target_interval_seconds integer)
RETURNS TABLE (reserved_id bigint, rule text, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_window interval := interval '1 hour';
  v_count integer;
  v_oldest timestamptz;
  v_last timestamptz;
  v_id bigint;
BEGIN
  IF p_client IS NULL OR p_client !~ '^[0-9a-f]{64}$' OR (p_target IS NOT NULL AND p_target !~ '^[0-9a-f]{64}$')
     OR p_client_limit IS NULL OR p_client_limit NOT BETWEEN 1 AND 100000
     OR p_target_interval_seconds IS NULL OR p_target_interval_seconds NOT BETWEEN 0 AND 3600 THEN
    RAISE EXCEPTION 'AUTH_EMAIL_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auth.email.client:' || p_client, 0));
    IF p_target IS NOT NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auth.email.target:' || p_target, 0));
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
    RETURN QUERY SELECT NULL::bigint, 'auth_email_busy'::text, 1;
    RETURN;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);

  -- Expired rows of any client; SKIP LOCKED so concurrent sweeps never wait on each other.
  DELETE FROM crove_kernel.auth_email_send s
  WHERE s.id IN (
    SELECT x.id FROM crove_kernel.auth_email_send x
    WHERE x.reserved_at < pg_catalog.now() - v_window
    ORDER BY x.reserved_at LIMIT 100
    FOR UPDATE SKIP LOCKED);

  SELECT pg_catalog.count(*)::integer, pg_catalog.min(s.reserved_at) INTO v_count, v_oldest
  FROM crove_kernel.auth_email_send s
  WHERE s.client_hash = p_client AND s.reserved_at > pg_catalog.now() - v_window;
  IF v_count >= p_client_limit THEN
    -- With fewer rows than the limit left after the oldest expires, a slot frees up at that time.
    RETURN QUERY SELECT NULL::bigint, 'auth_email_per_client'::text,
      GREATEST(1, pg_catalog.ceil(pg_catalog.date_part('epoch', v_oldest + v_window - pg_catalog.now())))::integer;
    RETURN;
  END IF;

  IF p_target IS NOT NULL AND p_target_interval_seconds > 0 THEN
    SELECT pg_catalog.max(s.reserved_at) INTO v_last
    FROM crove_kernel.auth_email_send s
    WHERE s.target_hash = p_target
      AND s.reserved_at > pg_catalog.now() - pg_catalog.make_interval(secs => p_target_interval_seconds);
    IF v_last IS NOT NULL THEN
      RETURN QUERY SELECT NULL::bigint, 'auth_email_per_address'::text,
        GREATEST(1, pg_catalog.ceil(pg_catalog.date_part('epoch',
          v_last + pg_catalog.make_interval(secs => p_target_interval_seconds) - pg_catalog.now())))::integer;
      RETURN;
    END IF;
  END IF;

  INSERT INTO crove_kernel.auth_email_send (client_hash, target_hash) VALUES (p_client, p_target)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, NULL::text, NULL::integer;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.auth_email_release(p_id bigint, p_client text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM crove_kernel.auth_email_send s WHERE s.id = p_id AND s.client_hash = p_client;
END $$;

-- crove_app alone.
REVOKE ALL ON FUNCTION crove_kernel.auth_email_reserve(text, text, integer, integer)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
GRANT EXECUTE ON FUNCTION crove_kernel.auth_email_reserve(text, text, integer, integer) TO crove_app;
REVOKE ALL ON FUNCTION crove_kernel.auth_email_release(bigint, text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
GRANT EXECUTE ON FUNCTION crove_kernel.auth_email_release(bigint, text) TO crove_app;
