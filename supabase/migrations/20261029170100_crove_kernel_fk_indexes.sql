-- Supporting indexes for the kernel's tenant foreign keys that had none (#1212, found by the G3 conformance test,
-- #1200): without them, deleting or re-keying an agent or a run (the org purge, #1024) scans agent_wakeup and
-- proposal. agent_wakeup's partial unique index covers pending wakeups only. Nullable keys get an index partial on
-- the key being set, since a NULL key is never checked. Idempotent; no data changes.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS agent_wakeup_agent_idx ON crove_kernel.agent_wakeup (org_id, agent_id);
CREATE INDEX IF NOT EXISTS agent_wakeup_run_idx
  ON crove_kernel.agent_wakeup (org_id, run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposal_decided_by_agent_idx
  ON crove_kernel.proposal (org_id, decided_by_agent) WHERE decided_by_agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposal_requested_by_run_idx
  ON crove_kernel.proposal (org_id, requested_by_run) WHERE requested_by_run IS NOT NULL;
