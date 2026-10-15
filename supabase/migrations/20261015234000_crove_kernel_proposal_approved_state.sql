-- Proposal state 'approved' (issue #88). Idempotent; applied files stay untouched.
--
-- kernel.proposal.approve now moves the proposal to 'approved' (with executed_command_id set to the approving
-- command) before it runs the proposal's command, and to 'executed' after, in the same transaction. The runtime runs
-- a command declared `access: 'proposal'` (finance.purchase.record) only when the proposal row is 'approved' for
-- that command by the calling command, so no other path can reach a posting command with a bare proposal id. Today
-- 'approved' is never committed; plan §4.7 P13 will keep approved proposals for system execution.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.proposal'::regclass
      AND conname = 'proposal_status_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%''approved''%'
  ) THEN
    ALTER TABLE crove_kernel.proposal DROP CONSTRAINT IF EXISTS proposal_status_check;
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_status_check
      CHECK (status IN ('pending', 'approved', 'executed', 'rejected', 'failed')) NOT VALID;
    ALTER TABLE crove_kernel.proposal VALIDATE CONSTRAINT proposal_status_check;
  END IF;
END $$;
