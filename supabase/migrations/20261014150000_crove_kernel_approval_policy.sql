-- Approval policy on proposals: eligible-approver snapshot (plan §4.7 P12) and authors (P10, §8.3).
-- External-tenant gate T2. Idempotent; applied files stay untouched.
--
-- eligible_approvers  the humans who could approve the proposal's command when it was created (today the
--                     org's owners and admins). Approval also re-checks each one's role live.
-- authors             the actors who produced the content of the current revision, as a JSON array of
--                     {"type":"user","id":<uuid>} and {"type":"system","component":<text>}. An edit adds the
--                     editor; nobody is ever removed. Only user entries count for four-eyes (P10).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS eligible_approvers uuid[];
ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS authors jsonb;

-- Pending proposals created before this migration get the snapshot as of now and, as authors, the extraction
-- component plus the user who uploaded the source file. Decided proposals keep NULL: nothing was recorded.
UPDATE crove_kernel.proposal p
SET eligible_approvers = coalesce(
  (SELECT pg_catalog.array_agg(m.user_id ORDER BY m.user_id)
   FROM crove_kernel.tenant_member m
   WHERE m.org_id = p.org_id AND m.role IN ('owner', 'admin')),
  '{}'::uuid[])
WHERE p.status = 'pending' AND p.eligible_approvers IS NULL;

UPDATE crove_kernel.proposal p
SET authors =
  CASE WHEN p.extraction_id IS NOT NULL
    THEN pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type', 'system', 'component', 'finance.extract'))
    ELSE '[]'::jsonb
  END
  || coalesce(
    (SELECT pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type', 'user', 'id', f.created_by))
     FROM crove_kernel.file f
     WHERE f.org_id = p.org_id AND f.id = p.source_file_id AND f.created_by IS NOT NULL),
    '[]'::jsonb)
WHERE p.status = 'pending' AND p.authors IS NULL;

DO $$
BEGIN
  -- A pending proposal always carries both, so approval never runs without a recorded policy input.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.proposal'::regclass AND conname = 'proposal_policy_recorded'
  ) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_policy_recorded
      CHECK (status <> 'pending' OR (eligible_approvers IS NOT NULL AND authors IS NOT NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.proposal'::regclass AND conname = 'proposal_authors_array'
  ) THEN
    ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_authors_array
      CHECK (authors IS NULL OR pg_catalog.jsonb_typeof(authors) = 'array');
  END IF;
END $$;
