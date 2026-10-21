-- Reminders and escalation for proposals waiting for approval (issue #676, plan §8.3 "After approval"). Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.proposal_policy        one row per org: remind the people who may approve a pending proposal after
--                                     remind_after_days, and tell the owners after escalate_after_days. NULL turns
--                                     either off, and no row means both are off. Owners and admins set it
--                                     (kernel.proposal_policy.save).
-- crove_kernel.proposal.reminded_at   when a pending proposal's approvers were reminded, and escalated_at when its
--                                     owners were told. Each happens at most once per proposal; a decision ends both.
-- crove_kernel.proposal_nudges_due    the worker's scan, across active orgs, of the pending proposals that have a
--                                     reminder or an escalation due. Ids only.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.proposal_policy (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  remind_after_days smallint CHECK (remind_after_days BETWEEN 1 AND 30),
  escalate_after_days smallint CHECK (escalate_after_days BETWEEN 1 AND 60),
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  -- The owners hear about a proposal only after its approvers were reminded.
  CONSTRAINT proposal_policy_order CHECK (remind_after_days IS NULL OR escalate_after_days IS NULL OR escalate_after_days > remind_after_days)
);
-- One row per org, kept by the save command under an advisory lock (as crove_social.watermark); readers take the first.
CREATE INDEX IF NOT EXISTS proposal_policy_org_idx ON crove_kernel.proposal_policy (org_id, created_at, id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.proposal_policy');

ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- Pending proposals of active orgs whose wait passed a threshold their org set and that were not nudged for it yet.
-- The command checks again under the proposal's lock.
CREATE OR REPLACE FUNCTION crove_kernel.proposal_nudges_due(p_limit int)
RETURNS TABLE (org_id uuid, proposal_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_kernel.proposal p
  JOIN LATERAL (
    SELECT x.remind_after_days, x.escalate_after_days FROM crove_kernel.proposal_policy x
    WHERE x.org_id = p.org_id ORDER BY x.created_at, x.id LIMIT 1
  ) pp ON true
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  WHERE p.status = 'pending'
    AND (
      (pp.remind_after_days IS NOT NULL AND p.reminded_at IS NULL AND p.created_at <= pg_catalog.now() - pg_catalog.make_interval(days => pp.remind_after_days))
      OR (pp.escalate_after_days IS NOT NULL AND p.escalated_at IS NULL AND p.created_at <= pg_catalog.now() - pg_catalog.make_interval(days => pp.escalate_after_days))
    )
  ORDER BY p.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_kernel.proposal_nudges_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.proposal_nudges_due(int) TO crove_worker;
