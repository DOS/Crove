-- The WORM fact stream (plan §4.10 "Tamper resistance", issue #891, Phase 1 exit criterion 3). Idempotent; applied
-- files stay untouched.
--
-- The audit and ledger tables are append-only by trigger, but the database owner can disable a trigger and edit a
-- row. The worker therefore anchors every audit event and journal entry outside the database: it cuts the rows into
-- time windows whose rows span at most 5 minutes, hashes each row, chains the batches (each batch hash folds in the
-- previous one) and writes each batch to an object store with an Object Lock retention (or a read-only file on the
-- local store). A nightly verifier recomputes every row hash from the database and compares it with the archived
-- batches: a changed, missing or added row, a broken chain or a missing batch fails the check, and the prober alerts.
--
-- crove_kernel.archive_batch           one row per written batch: sequence, window, row count, hashes, object key.
--                                      The archiver's cursor; the archive itself is the authority, so the verifier
--                                      compares this table with it too. Append-only, worker-written through a
--                                      definer.
-- crove_kernel.archive_verification    one row per verifier run: ok or not, batches checked, problems (codes and
--                                      references only). Append-only, worker-written through a definer.
-- crove_kernel.archive_row_hashes()    the version 1 hash of every audit event and journal entry in a window, across
--                                      every org (crove_worker only). Hashes only, never row content.
-- crove_kernel.archive_next_window()   the start of the next window, the newest time the archiver may cover (now
--                                      minus the lag, so a transaction still open is not cut off) and the first row
--                                      time at or after the start (crove_worker only).
--
-- Alerts reach the prober as dead letters (crove_kernel.health() is unchanged): a batch write that keeps failing, or a
-- verifier run that finds a mismatch, fails its job, which pg-boss then keeps in state `failed`.
--
-- Version 1 row hashes cover a fixed column list, so a column added later changes no stored hash; covering it needs
-- a new hash version. Times are written in UTC with microseconds and amounts as text at their column's scale, so the
-- hash does not depend on the session's TimeZone or on number formatting.
SET LOCAL lock_timeout = '2s';

-- Windows read audit events and journal entries by time across orgs.
CREATE INDEX IF NOT EXISTS audit_event_occurred_brin ON crove_kernel.audit_event USING brin (occurred_at);
CREATE INDEX IF NOT EXISTS journal_entry_created_brin ON crove_finance.journal_entry USING brin (created_at);

CREATE TABLE IF NOT EXISTS crove_kernel.archive_batch (
  seq bigint PRIMARY KEY CHECK (seq > 0),
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL CHECK (window_to > window_from),
  row_count int NOT NULL CHECK (row_count >= 0),
  batch_sha256 text NOT NULL CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
  chain_sha256 text NOT NULL CHECK (chain_sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 200),
  written_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (window_from)
);
ALTER TABLE crove_kernel.archive_batch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.archive_batch FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.make_append_only('crove_kernel.archive_batch');
SELECT crove_kernel.agent_write_guard_install('crove_kernel.archive_batch');

CREATE TABLE IF NOT EXISTS crove_kernel.archive_verification (
  id uuid PRIMARY KEY DEFAULT crove_kernel.uuid_v7(),
  ok boolean NOT NULL,
  batches int NOT NULL CHECK (batches >= 0),
  rows_checked bigint NOT NULL CHECK (rows_checked >= 0),
  -- At most 100 problems, each a code and a reference (a row ref or a batch sequence), never row content.
  problems jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(problems) = 'array' AND jsonb_array_length(problems) <= 100),
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS archive_verification_time_idx ON crove_kernel.archive_verification (verified_at DESC);
ALTER TABLE crove_kernel.archive_verification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.archive_verification FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.make_append_only('crove_kernel.archive_verification');
SELECT crove_kernel.agent_write_guard_install('crove_kernel.archive_verification');

-- UTC, microseconds, a fixed shape: 2026-10-21T03:12:14.123456Z.
CREATE OR REPLACE FUNCTION crove_kernel.archive_ts(p timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;
REVOKE ALL ON FUNCTION crove_kernel.archive_ts(timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION crove_kernel.archive_require_worker()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_require_worker() FROM PUBLIC;

-- Every audit event (by occurred_at) and journal entry (by created_at, with its lines) in [p_from, p_to), with its
-- version 1 hash. ref: 'audit:<id>' or 'journal:<org_id>:<id>'.
CREATE OR REPLACE FUNCTION crove_kernel.archive_row_hashes(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ref text, row_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'audit:' || a.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', a.org_id, 'id', a.id, 'occurred_at', crove_kernel.archive_ts(a.occurred_at),
           'actor_type', a.actor_type, 'actor_id', a.actor_id, 'command', a.command, 'command_id', a.command_id,
           'outcome', a.outcome, 'target_type', a.target_type, 'target_id', a.target_id, 'input_sha256', a.input_sha256,
           'proposal_id', a.proposal_id, 'detail', a.detail)::text, 'UTF8')), 'hex')
  FROM crove_kernel.audit_event a
  WHERE a.occurred_at >= p_from AND a.occurred_at < p_to
  UNION ALL
  SELECT 'journal:' || e.org_id::text || ':' || e.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', e.org_id, 'id', e.id, 'entry_date', e.entry_date::text, 'description', e.description,
           'source_type', e.source_type, 'source_id', e.source_id, 'created_by', e.created_by,
           'created_at', crove_kernel.archive_ts(e.created_at), 'reverses_entry_id', e.reverses_entry_id,
           'lines', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'line_no', l.line_no, 'account_code', l.account_code, 'debit', l.debit::text, 'credit', l.credit::text,
                      'party_id', l.party_id, 'memo', l.memo) ORDER BY l.line_no)
             FROM crove_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id), '[]'::jsonb))::text, 'UTF8')), 'hex')
  FROM crove_finance.journal_entry e
  WHERE e.created_at >= p_from AND e.created_at < p_to;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_row_hashes(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_row_hashes(timestamptz, timestamptz) TO crove_worker;

-- Where the next batch starts (the last batch's end, or the epoch for the first one), the newest time it may cover
-- (now minus p_lag_seconds, at least 60 s, truncated to milliseconds) and the time of the first row in between (NULL
-- when there is none).
CREATE OR REPLACE FUNCTION crove_kernel.archive_next_window(p_lag_seconds int)
RETURNS TABLE (window_from timestamptz, horizon timestamptz, first_row_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  window_from := coalesce((SELECT b.window_to FROM crove_kernel.archive_batch b ORDER BY b.seq DESC LIMIT 1), 'epoch'::timestamptz);
  horizon := pg_catalog.date_trunc('milliseconds', pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(coalesce(p_lag_seconds, 600), 60)));
  first_row_at := LEAST(
    (SELECT pg_catalog.min(a.occurred_at) FROM crove_kernel.audit_event a WHERE a.occurred_at >= window_from AND a.occurred_at < horizon),
    (SELECT pg_catalog.min(e.created_at) FROM crove_finance.journal_entry e WHERE e.created_at >= window_from AND e.created_at < horizon));
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_next_window(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_next_window(int) TO crove_worker;

-- The last batch, or no row before the first one.
CREATE OR REPLACE FUNCTION crove_kernel.archive_head()
RETURNS TABLE (seq bigint, window_to timestamptz, chain_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY SELECT b.seq, b.window_to, b.chain_sha256 FROM crove_kernel.archive_batch b ORDER BY b.seq DESC LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_head() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_head() TO crove_worker;

-- Every recorded batch, in order, for the verifier.
CREATE OR REPLACE FUNCTION crove_kernel.archive_batches()
RETURNS TABLE (seq bigint, window_from timestamptz, window_to timestamptz, row_count int, batch_sha256 text, chain_sha256 text, object_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY SELECT b.seq, b.window_from, b.window_to, b.row_count, b.batch_sha256, b.chain_sha256, b.object_key
  FROM crove_kernel.archive_batch b ORDER BY b.seq;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_batches() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_batches() TO crove_worker;

-- Records a batch the archiver has written. It must follow the last one: the next sequence, starting where the last
-- window ended (the epoch for the first).
CREATE OR REPLACE FUNCTION crove_kernel.archive_record(
  p_seq bigint, p_window_from timestamptz, p_window_to timestamptz, p_row_count int,
  p_batch_sha256 text, p_chain_sha256 text, p_object_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_seq bigint;
  v_to timestamptz;
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  -- One archiver at a time; a second one waiting here finds the head moved and fails.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove_kernel.archive_batch', 0));
  SELECT b.seq, b.window_to INTO v_seq, v_to FROM crove_kernel.archive_batch b ORDER BY b.seq DESC LIMIT 1;
  IF p_seq <> coalesce(v_seq, 0) + 1 OR p_window_from <> coalesce(v_to, 'epoch'::timestamptz) THEN
    RAISE EXCEPTION 'ARCHIVE_OUT_OF_ORDER' USING ERRCODE = '40001';
  END IF;
  INSERT INTO crove_kernel.archive_batch (seq, window_from, window_to, row_count, batch_sha256, chain_sha256, object_key)
  VALUES (p_seq, p_window_from, p_window_to, p_row_count, p_batch_sha256, p_chain_sha256, p_object_key);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_record(bigint, timestamptz, timestamptz, int, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_record(bigint, timestamptz, timestamptz, int, text, text, text) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.archive_verified(p_ok boolean, p_batches int, p_rows bigint, p_problems jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  INSERT INTO crove_kernel.archive_verification (ok, batches, rows_checked, problems)
  VALUES (p_ok, p_batches, p_rows, coalesce(p_problems, '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_verified(boolean, int, bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_verified(boolean, int, bigint, jsonb) TO crove_worker;

-- The worker's queues: the archiver every minute, the verifier nightly. create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('kernel-archive-write', '{"policy":"standard"}'::jsonb);
SELECT crove_jobs.create_queue('kernel-archive-verify', '{"policy":"standard"}'::jsonb);
