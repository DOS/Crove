-- Activity rows about one legal entity whose record names none carry that entity (issues #1725 and #1728). Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.activity takes its entity from the record a row names, for the record types the trigger b_legal_entity
-- maps (20261103120000, 20261104010000). Some per-entity actions name a record with no entity: a month's lock or
-- unlock (finance.period, record id the org's id), a year archive (finance.archive, record id the org's id; one row per
-- entity whose books the package holds), a missing-invoice request or monthly reminder (kernel.mail_message, a mail;
-- the reminder writes one row per entity it covers). Their rows were org-level, so a member limited to entity A read
-- entity B's month locks, archives and missing-invoice counts. The commands now name the entity
-- (ctx.activity(..., { legalEntityId }), packages/kernel-runtime). The trigger already keeps a named entity for a type
-- it does not map, and for a mapped type refuses one other than the record's (LEGAL_ENTITY_MISMATCH, unchanged here);
-- le_scope's WITH CHECK refuses an entity outside the writer's scope, and the foreign key one outside the org.
--
-- activity_entity_named: a new row of those record types must name its entity, so a writer that forgets falls closed
-- (23514) instead of writing an org-level row. NOT VALID: the constraint is checked for every row inserted from now on,
-- and rows written before stay as they are (org-level). Most of them do not record their entity: a month lock's or an
-- archive's row names only the org, a reminder covered several entities. A request's mail payload does name its
-- entity, so a backfill of those could follow (left out here: this file changes no existing row).
-- apps/kernel/test/activity-record-types.test.ts keeps the list equal to the types the code names.
-- Adding a NOT VALID constraint takes activity's ACCESS EXCLUSIVE lock only to record it, without a scan.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                 WHERE c.conrelid = 'crove_kernel.activity'::regclass AND c.conname = 'activity_entity_named') THEN
    ALTER TABLE crove_kernel.activity ADD CONSTRAINT activity_entity_named
      CHECK (record_type NOT IN ('finance.archive', 'finance.period', 'kernel.mail_message') OR legal_entity_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
