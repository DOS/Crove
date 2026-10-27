-- TEMPORARY PROOF for #1643 (PR #1646, closed unmerged): breaks tenant isolation on crove_kernel.party on purpose.
-- In any context, a tenant role sees the parties of every org. The base copy of _rls_matrix.test.sql must catch it.
DROP POLICY IF EXISTS proof_leak ON crove_kernel.party;
CREATE POLICY proof_leak ON crove_kernel.party AS PERMISSIVE FOR SELECT TO crove_tenant
  USING ((SELECT crove_kernel.ctx_org_id()) IS NOT NULL);
