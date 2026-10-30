-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2044 part 2b-ii, ADR-0039 point 2): a bank feed provider's signed notice, and the pull it asks
-- for. Idempotent; applied files stay untouched.
--
-- How a notice travels (as a mail provider's delivery event does, 20261021100000):
--   1. The provider posts it to POST /api/bank-feed/<provider>/webhook. The API checks its signature through the
--      adapter before anything else (a forged, stale or malformed notice is refused and stored nowhere) and hands the
--      ids of the accounts it names to bank_feed_notice_enqueue(), which writes machinery rows and nothing else: the
--      API never holds a tenant context for a webhook, and the notice's body is stored nowhere (it is only a hint to
--      pull; no transaction is read from it).
--   2. The worker relay claims them with bank_feed_notice_claim() and queues one sync per connection that lists such an
--      account (finance-bank-feed-sync, 20261108100000). The org and the connection come from the stored listing, never
--      from the notice, so an account no connection lists is dropped, and a notice can only ask for a pull of a
--      connection that already exists: a sync pulls what the provider reports, as the daily sweep does.
--
-- bank_feed_notice_pending is a global machinery table (no org_id, nothing about an org): one row per (provider, account)
-- waiting, so a burst of notices for one account is one pull. Only the two definers below touch it.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.bank_feed_notice_pending (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider ~ '^bank_[a-z0-9_]{1,27}$'),
  external_account_id text NOT NULL CHECK (pg_catalog.length(external_account_id) BETWEEN 1 AND 200),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (provider, external_account_id)
);
REVOKE ALL ON crove_finance.bank_feed_notice_pending FROM PUBLIC;
ALTER TABLE crove_finance.bank_feed_notice_pending ENABLE ROW LEVEL SECURITY;
-- Like every crove_* table, refused to agent contexts (#285); only the definers below write it anyway.
SELECT crove_kernel.agent_write_guard_install('crove_finance.bank_feed_notice_pending');

-- Records the accounts one verified notice names, for the worker (API login only): an array of at most 100 provider
-- account ids. Reads nothing and writes no tenant data. An account already waiting is skipped. The API role is not
-- trusted with volume: past 10000 waiting accounts it raises 53400 (configuration_limit_exceeded), which the API
-- answers with 503 and the provider retries.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_notice_enqueue(p_provider text, p_accounts text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^bank_[a-z0-9_]{1,27}$' OR p_accounts IS NULL
     OR pg_catalog.cardinality(p_accounts) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'BANK_FEED_NOTICE_INVALID' USING ERRCODE = '22P02';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_finance.bank_feed_notice_pending LIMIT 10001) s) > 10000 THEN
    RAISE EXCEPTION 'BANK_FEED_NOTICE_BACKLOG' USING ERRCODE = '53400';
  END IF;
  INSERT INTO crove_finance.bank_feed_notice_pending (provider, external_account_id)
  SELECT p_provider, a FROM pg_catalog.unnest(p_accounts) AS a
  WHERE pg_catalog.length(a) BETWEEN 1 AND 200
  ON CONFLICT (provider, external_account_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
  END IF;
  RETURN v_count;
END $$;

-- Claims waiting accounts for the worker relay (worker only). The claimed rows are deleted. It answers one row per claimed
-- account and active connection of an active org whose last listing holds it, and one row of nulls for a claimed account
-- no connection lists (dropped), so a batch of 100 or more rows tells the relay to claim again. The relay queues one sync
-- per connection named.
CREATE OR REPLACE FUNCTION crove_finance.bank_feed_notice_claim(p_limit integer)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH claimed AS (
    DELETE FROM crove_finance.bank_feed_notice_pending p
    WHERE p.seq IN (
      SELECT q.seq FROM crove_finance.bank_feed_notice_pending q ORDER BY q.seq LIMIT LEAST(GREATEST(p_limit, 1), 1000) FOR UPDATE SKIP LOCKED
    )
    RETURNING p.provider, p.external_account_id
  ),
  matched AS (
    SELECT claimed.external_account_id AS account, c.org_id AS m_org, c.id AS m_connection, c.provider AS m_provider
    FROM claimed
    JOIN crove_finance.bank_feed_listed_account l ON l.external_account_id = claimed.external_account_id
    JOIN crove_kernel.channel_connection c ON c.org_id = l.org_id AND c.id = l.channel_connection_id AND c.provider = claimed.provider
    JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
    WHERE c.status = 'active'
  )
  SELECT m.m_org, m.m_connection, m.m_provider FROM matched m
  UNION ALL
  SELECT NULL::uuid, NULL::uuid, NULL::text FROM claimed WHERE NOT EXISTS (SELECT 1 FROM matched m2 WHERE m2.account = claimed.external_account_id)
$$;

REVOKE ALL ON FUNCTION crove_finance.bank_feed_notice_enqueue(text, text[]), crove_finance.bank_feed_notice_claim(integer)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.bank_feed_notice_enqueue(text, text[]) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_finance.bank_feed_notice_claim(integer) TO crove_worker;
