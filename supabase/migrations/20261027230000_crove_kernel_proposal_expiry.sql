-- Expiry for proposals left pending (issue #876, step 2; plan §8.3 "After approval"; step 1 added the 'expired'
-- state). Idempotent; applied files stay untouched.
--
-- crove_kernel.proposal_policy.expire_after_days
--     a pending proposal older than this moves to 'expired' (kernel.proposal.expire, run by the worker). NULL, the
--     default, turns expiry off. When set it needs the owners' escalation and comes after it, and a proposal expires
--     only once its owners were told (escalated_at) and have had the days between the two since: a backlog that is
--     already old when an org turns expiry on is escalated first and expires that many days later.
-- crove_kernel.proposal.request_input
--     what the requester sent to kernel.proposal.request, kept so an expired requested proposal can be asked for again
--     through the module's preparer, which checks it all anew. NULL for every other proposal.
-- crove_kernel.proposal.resubmitted_from
--     the expired proposal a new one was asked for again from (kernel.proposal.resubmit), in the same org. At most one
--     per expired proposal.
-- crove_kernel.proposal_extraction_uq
--     one live proposal per extraction run: an expired one no longer counts, so its file's reading can be proposed
--     again as a new proposal.
-- crove_kernel.proposal_expiries_due
--     the worker's scan, across active orgs, of the pending proposals past their org's expiry. Ids only.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.proposal_policy ADD COLUMN IF NOT EXISTS expire_after_days smallint;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_policy_expire_bounds' AND conrelid = 'crove_kernel.proposal_policy'::regclass) THEN
    ALTER TABLE crove_kernel.proposal_policy ADD CONSTRAINT proposal_policy_expire_bounds
      CHECK (expire_after_days IS NULL OR expire_after_days BETWEEN 2 AND 90);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_policy_expire_order' AND conrelid = 'crove_kernel.proposal_policy'::regclass) THEN
    ALTER TABLE crove_kernel.proposal_policy ADD CONSTRAINT proposal_policy_expire_order
      CHECK (expire_after_days IS NULL OR (escalate_after_days IS NOT NULL AND expire_after_days > escalate_after_days));
  END IF;
END $$;

ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS request_input jsonb;
ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS resubmitted_from uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_request_input_size' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_request_input_size
      CHECK (request_input IS NULL OR pg_catalog.octet_length(request_input::text) <= 262144);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_resubmitted_from_fk' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_resubmitted_from_fk
      FOREIGN KEY (org_id, resubmitted_from) REFERENCES crove_kernel.proposal (org_id, id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS proposal_resubmitted_from_uq ON crove_kernel.proposal (org_id, resubmitted_from) WHERE resubmitted_from IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'crove_kernel' AND indexname = 'proposal_extraction_uq' AND indexdef LIKE '%expired%'
  ) THEN
    DROP INDEX IF EXISTS crove_kernel.proposal_extraction_uq;
    CREATE UNIQUE INDEX proposal_extraction_uq ON crove_kernel.proposal (org_id, extraction_id)
      WHERE extraction_id IS NOT NULL AND status <> 'expired';
  END IF;
END $$;

-- Pending proposals of active orgs older than the expiry their org set, whose owners were told at least the days
-- between escalation and expiry ago. The command checks again under the proposal's lock.
CREATE OR REPLACE FUNCTION crove_kernel.proposal_expiries_due(p_limit int)
RETURNS TABLE (org_id uuid, proposal_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_kernel.proposal p
  JOIN LATERAL (
    SELECT x.escalate_after_days, x.expire_after_days FROM crove_kernel.proposal_policy x
    WHERE x.org_id = p.org_id ORDER BY x.created_at, x.id LIMIT 1
  ) pp ON true
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  WHERE p.status = 'pending'
    AND pp.expire_after_days IS NOT NULL
    AND pp.escalate_after_days IS NOT NULL
    AND p.escalated_at IS NOT NULL
    AND p.created_at <= pg_catalog.now() - pg_catalog.make_interval(days => pp.expire_after_days)
    AND p.escalated_at <= pg_catalog.now() - pg_catalog.make_interval(days => pp.expire_after_days - pp.escalate_after_days)
  ORDER BY p.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_kernel.proposal_expiries_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.proposal_expiries_due(int) TO crove_worker;
