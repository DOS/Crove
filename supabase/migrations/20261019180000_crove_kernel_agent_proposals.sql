-- Agent proposals and agent approvals (ADR-0029 section 6, issue #260). Idempotent; applied files stay untouched.
--
-- An agent asks for R2 or R3 work through a proposal instead of being refused (P05, P06). An agent context still
-- never writes a proposal (agent_write_guard, refuse_agent_write): the agent's command records the request as an
-- outbox event, and a system command creates the proposal from it, after checking the run and the task it came from.
-- Approvals work the same way: an agent records its approval, and a system command re-checks it and executes.
--
-- New proposal columns, all written in user or system contexts only:
--   requested_by_agent, requested_by_run, source_task_id  the causal chain of an agent's proposal;
--   request_event_id   the outbox event it was created from (one proposal per event);
--   tainted            the content came from tainted input (a tainted run or task, or a tainted extraction);
--   policy_flags       the review rules (P03 to P07) its writer assessed in the proposal's outcome. NULL when no writer
--                      assessed them: proposals created before this migration, and today every proposal not created
--                      from an agent's request. Agents never approve those;
--   decided_by_agent   the agent whose approval executed it.
-- The database holds every writer to:
--   - tainted is derived from the extraction too, and a tainted proposal is flagged P03;
--   - the causal chain, the request event and the taint never change, flags are never removed, and flags nobody
--     assessed (NULL) stay NULL;
--   - an agent-decided proposal is untainted, flagged with none of P03 to P07, and not decided by the agent that
--     requested it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.proposal
  ADD COLUMN IF NOT EXISTS requested_by_agent uuid,
  ADD COLUMN IF NOT EXISTS requested_by_run uuid,
  ADD COLUMN IF NOT EXISTS source_task_id uuid,
  ADD COLUMN IF NOT EXISTS request_event_id uuid,
  ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS policy_flags text[],
  ADD COLUMN IF NOT EXISTS decided_by_agent uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_requested_by_agent_fk' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_requested_by_agent_fk
      FOREIGN KEY (org_id, requested_by_agent) REFERENCES crove_kernel.agent (org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_requested_by_run_fk' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_requested_by_run_fk
      FOREIGN KEY (org_id, requested_by_run) REFERENCES crove_kernel.ai_run (org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_source_task_fk' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_source_task_fk
      FOREIGN KEY (org_id, source_task_id) REFERENCES crove_kernel.task (org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_decided_by_agent_fk' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_decided_by_agent_fk
      FOREIGN KEY (org_id, decided_by_agent) REFERENCES crove_kernel.agent (org_id, id);
  END IF;
  -- An agent's proposal names its whole chain (run and task with the agent), or none of it.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_agent_chain' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_agent_chain
      CHECK (num_nonnulls(requested_by_agent, requested_by_run, source_task_id) IN (0, 3));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_policy_flags_known' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_policy_flags_known
      CHECK (policy_flags IS NULL OR policy_flags <@ ARRAY['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09']::text[]);
  END IF;
  -- ADR-0029 section 6: an agent approves only clean proposals it did not ask for.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_agent_decision' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_agent_decision
      CHECK (decided_by_agent IS NULL OR (
        decided_by IS NULL AND NOT tainted AND policy_flags IS NOT NULL
        AND NOT (policy_flags && ARRAY['P03', 'P04', 'P05', 'P06', 'P07']::text[])
        AND decided_by_agent IS DISTINCT FROM requested_by_agent));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS proposal_request_event_uq ON crove_kernel.proposal (org_id, request_event_id) WHERE request_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposal_requested_by_agent_idx ON crove_kernel.proposal (org_id, requested_by_agent) WHERE requested_by_agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposal_source_task_idx ON crove_kernel.proposal (org_id, source_task_id) WHERE source_task_id IS NOT NULL;

-- On insert: taint from the extraction (a missing extraction row counts as tainted), and a tainted proposal with
-- assessed flags flagged P03. Flags stay NULL unless the writer computed them: an empty array means "assessed, none
-- applies", which only the writer that assessed them may say.
CREATE OR REPLACE FUNCTION crove_kernel.proposal_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tainted boolean;
BEGIN
  IF NEW.extraction_id IS NOT NULL THEN
    SELECT e.tainted INTO v_tainted FROM crove_kernel.extraction e WHERE e.org_id = NEW.org_id AND e.id = NEW.extraction_id;
    NEW.tainted := NEW.tainted OR coalesce(v_tainted, true);
  END IF;
  IF NEW.tainted AND NEW.policy_flags IS NOT NULL AND NOT ('P03' = ANY (NEW.policy_flags)) THEN
    NEW.policy_flags := NEW.policy_flags || 'P03'::text;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS proposal_before_insert ON crove_kernel.proposal;
CREATE TRIGGER proposal_before_insert BEFORE INSERT ON crove_kernel.proposal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.proposal_before_insert();

-- On update: the provenance is fixed, taint and the review flags only grow, flags nobody assessed stay unassessed
-- (NULL never becomes an array, so no later write can clear a proposal for agents), and a new reading of the file (a
-- re-extraction names another extraction) brings its taint along.
CREATE OR REPLACE FUNCTION crove_kernel.proposal_keep_provenance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tainted boolean;
BEGIN
  IF (NEW.requested_by_agent, NEW.requested_by_run, NEW.source_task_id, NEW.request_event_id)
     IS DISTINCT FROM (OLD.requested_by_agent, OLD.requested_by_run, OLD.source_task_id, OLD.request_event_id)
     OR (OLD.tainted AND NOT NEW.tainted)
     OR (OLD.policy_flags IS NULL AND NEW.policy_flags IS NOT NULL)
     OR (OLD.policy_flags IS NOT NULL AND (NEW.policy_flags IS NULL OR NOT (NEW.policy_flags @> OLD.policy_flags))) THEN
    RAISE EXCEPTION 'PROPOSAL_PROVENANCE' USING ERRCODE = '23514';
  END IF;
  IF NEW.extraction_id IS NOT NULL AND NEW.extraction_id IS DISTINCT FROM OLD.extraction_id THEN
    SELECT e.tainted INTO v_tainted FROM crove_kernel.extraction e WHERE e.org_id = NEW.org_id AND e.id = NEW.extraction_id;
    NEW.tainted := NEW.tainted OR coalesce(v_tainted, true);
  END IF;
  IF NEW.tainted AND NEW.policy_flags IS NOT NULL AND NOT ('P03' = ANY (NEW.policy_flags)) THEN
    NEW.policy_flags := NEW.policy_flags || 'P03'::text;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS proposal_keep_provenance ON crove_kernel.proposal;
CREATE TRIGGER proposal_keep_provenance BEFORE UPDATE ON crove_kernel.proposal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.proposal_keep_provenance();

REVOKE ALL ON FUNCTION crove_kernel.proposal_before_insert(), crove_kernel.proposal_keep_provenance()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The worker's queue for agent proposal events (apps/kernel/src/jobs-schema.ts QUEUES.agentProposal): one job per
-- event (singleton key <org>:<event>). create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('kernel-agent-proposal', '{"policy":"standard"}'::jsonb);
