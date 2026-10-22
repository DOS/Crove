-- Proposal state 'expired' (issue #876, step 1; plan §8.3 lists it among the terminal states). Idempotent; applied
-- files stay untouched.
--
-- A proposal left pending past its org's expiry moves to 'expired' through a system command (step 2). The state is
-- terminal like 'rejected': nobody approves, edits or rejects an expired proposal, and its author may ask for it again
-- as a new proposal. This step only lets the state be stored, so every reader handles it before anything writes it.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.proposal'::regclass
      AND conname = 'proposal_status_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%''expired''%'
  ) THEN
    ALTER TABLE crove_kernel.proposal DROP CONSTRAINT IF EXISTS proposal_status_check;
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_status_check
      CHECK (status IN ('pending', 'approved', 'executed', 'rejected', 'failed', 'expired'));
  END IF;
END $$;
