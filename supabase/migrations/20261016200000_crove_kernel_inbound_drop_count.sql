-- How many messages to a retired inbound address were dropped (issue #139, plan §7.6). Idempotent; applied files
-- stay untouched.
--
-- Mail to a retired token is dropped by the worker like mail to a token that never existed (20261015150000), and
-- mail queued for a token before its rotation is dropped the same way. A supplier's legitimate mail in that window is
-- lost without a bounce, so the owner is now told how many such messages were dropped:
--   crove_kernel.inbound_drop   one row per retired address that received mail: a count and the first and last drop
--                               time. Nothing else: no message content, sender, subject, recipient or hash. The
--                               ledger rows of inbound_address are immutable (guard trigger), so the count lives here.
--                               Definer-only machinery: no role but its owner holds a privilege on it; RLS is enabled
--                               with no policy, so a privilege granted by mistake later reads and writes nothing.
--   inbound_drop_record(text)   the worker's call when it drops a message for an unknown recipient. Counts it only
--                               when the token is a retired ledger row retired less than 30 days ago; any other token
--                               (active, never issued, retired longer ago) changes nothing. Returns nothing, so it
--                               tells its caller nothing about which tokens exist. Executable by crove_worker alone
--                               (and it checks session_user too, like enter_system_context); the API never calls it,
--                               so it is no oracle for a sender.
--   inbound_drop_count()        the number of dropped messages to the org's addresses retired less than 30 days ago,
--                               for the org and user in the sealed context, owner or admin only (the roles that see
--                               the inbound address). Executable by crove_app alone; kernel.org.get calls it.
--
-- Bounded: one row per retired address (at most 50 per org, the rotation limit of 20261015223000), and only drops in
-- the 30 days after a rotation count, so a leaked old address can neither grow a table nor keep its row changing for
-- ever. One upsert per dropped message inside the window. The count is at least once: a worker that dies after
-- counting and before finishing the job counts the retried message again.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The counts. address_id is the id of a ledger row of the same org. There is deliberately no foreign key to
-- inbound_address: one would make TRUNCATE of the ledger fail on the reference before the ledger's own append-only
-- trigger refuses it. The one writer, inbound_drop_record(), takes the org and id from the ledger row itself, and
-- ledger rows are never deleted, so a row never points at a missing or foreign address.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.inbound_drop (
  org_id uuid NOT NULL,
  address_id uuid NOT NULL,
  dropped_count bigint NOT NULL DEFAULT 1 CONSTRAINT inbound_drop_count_positive CHECK (dropped_count > 0),
  first_dropped_at timestamptz NOT NULL DEFAULT now(),
  last_dropped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, address_id),
  CONSTRAINT inbound_drop_last_after_first CHECK (last_dropped_at >= first_dropped_at)
);
ALTER TABLE crove_kernel.inbound_drop ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.inbound_drop FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The worker counts a drop. Owned by the table owner (the migration runner), like org_by_inbound_token, so it
-- reads the ledger and writes the counts without any grant; it filters by the token's own org itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.inbound_drop_record(p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_address uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'INBOUND_DROP_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  SELECT a.org_id, a.id INTO v_org, v_address
  FROM crove_kernel.inbound_address a
  WHERE a.token = pg_catalog.lower(p_token)
    AND a.retired_at IS NOT NULL
    AND a.retired_at > pg_catalog.now() - interval '30 days';
  IF v_address IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO crove_kernel.inbound_drop AS d (org_id, address_id) VALUES (v_org, v_address)
  ON CONFLICT (org_id, address_id) DO UPDATE
    SET dropped_count = d.dropped_count + 1,
        last_dropped_at = GREATEST(d.last_dropped_at, EXCLUDED.last_dropped_at);
END $$;

-- ---------------------------------------------------------------------------
-- The owner (or an admin) reads the count for the org in context.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.inbound_drop_count()
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'INBOUND_DROP_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT COALESCE(pg_catalog.sum(d.dropped_count), 0)::bigint
    FROM crove_kernel.inbound_drop d
    JOIN crove_kernel.inbound_address a ON a.org_id = d.org_id AND a.id = d.address_id
    WHERE d.org_id = v_org AND a.retired_at > pg_catalog.now() - interval '30 days'
  );
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: the worker records, the API reads; no other role calls either.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION crove_kernel.inbound_drop_record(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.inbound_drop_count() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.inbound_drop_record(text) TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.inbound_drop_count() TO crove_app;
