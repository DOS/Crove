-- Only an agent's request carries assessed review flags (issue #435, N2). Idempotent; applied files stay untouched.
--
-- policy_flags is the outcome of the review rules (P03 to P07) its writer assessed. An empty array reads as
-- "assessed, none applies", which lets an agent approve the proposal (proposal_agent_decision). Only
-- kernel.agent.proposal.create assesses them, and it always names the requesting agent. Every other writer (a user's
-- request, extraction, a direct write) leaves them NULL, so none of them can mark a proposal clean for agents.
-- proposal_keep_provenance already keeps NULL flags NULL and the causal chain fixed after insert.
--
-- Every proposal written before this migration satisfies it: only kernel.agent.proposal.create has ever written
-- flags, together with the chain.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'proposal_flags_need_agent' AND conrelid = 'crove_kernel.proposal'::regclass) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_flags_need_agent
      CHECK (policy_flags IS NULL OR requested_by_agent IS NOT NULL);
  END IF;
END $$;
