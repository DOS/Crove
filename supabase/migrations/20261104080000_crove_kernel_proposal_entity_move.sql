-- Crove kernel (issue #1764, from the security review of #1756; coordinator decisions 2026-10-29, option 1 and (a)): a
-- proposal's content never names another legal entity than the proposal's own, and an upload names the entity its
-- document is booked in. Idempotent; applied files stay untouched.
--
-- Since #1538 a proposal is read only by the members and agents whose le_scope covers its legal_entity_id, the entity
-- of the reading it came from or the one it was asked for in. That column never changes once written, for every role
-- (b_legal_entity, #1280; ADR-0021 names it as the control that stands in for leaving the entity out of
-- payload_sha256). An edit could still move an invoice to another entity through its payload (finance.purchase.revise,
-- legalEntityId, #1543), and approval books it where the payload says: entity B's invoice read by entity A's members,
-- out of sight of B's until it is booked. Re-stamping the proposal on such a move would relax that ADR control, an
-- owner decision, so the move is refused instead: to book a document in another entity, reject the proposal and
-- upload the document again there, naming that entity (the second part of this file).
--
-- proposal_entity_payload (BEFORE INSERT OR UPDATE OF payload, legal_entity_id, ENABLE ALWAYS): a payload that names
-- a legalEntityId names the proposal's own entity (compared in lower case, the text form of a uuid), else
-- LEGAL_ENTITY_MOVE_REFUSED (23514). A payload that names none still posts into the proposal's own entity
-- (finance.purchase.record since #1756). On UPDATE it checks only a write that changes the payload or the entity, so
-- a proposal moved before this file (its payload naming another entity) can still be approved, rejected or expired
-- as it is; it can no longer be edited without moving it back. It fires by name after b_legal_entity, which fills the
-- entity on INSERT. kernel.proposal.edit refuses the same move before its reviser runs, with a message.
-- Staff (a session user that is a superuser or can act as the table's owner) are not checked, as in
-- audit_event_proposal (20261103100000), so a support fix is not changed. An invoker: it reads only the row and the
-- session's role.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.proposal_entity_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_named text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload AND NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id THEN
    RETURN NEW;
  END IF;
  v_named := CASE WHEN pg_catalog.jsonb_typeof(NEW.payload) = 'object' THEN NEW.payload ->> 'legalEntityId' END;
  IF v_named IS NULL OR pg_catalog.lower(v_named) = NEW.legal_entity_id::text THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'LEGAL_ENTITY_MOVE_REFUSED' USING ERRCODE = '23514',
    DETAIL = pg_catalog.json_build_object('table', 'crove_kernel.proposal')::text;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.proposal_entity_payload() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The proposals moved before this file: decided ones stay as they were (approval of a pending one books it where its
-- payload says); counted for the deploy log, never changed here.
DO $$
DECLARE
  v_moved bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO v_moved FROM crove_kernel.proposal p
  WHERE pg_catalog.jsonb_typeof(p.payload) = 'object' AND p.payload ? 'legalEntityId'
    AND pg_catalog.lower(p.payload ->> 'legalEntityId') IS DISTINCT FROM p.legal_entity_id::text;
  IF v_moved > 0 THEN
    RAISE NOTICE 'crove_kernel.proposal: % proposal(s) name another legal entity in their payload than their own (#1764)', v_moved;
  END IF;
END $$;

DROP TRIGGER IF EXISTS proposal_entity_payload ON crove_kernel.proposal;
CREATE TRIGGER proposal_entity_payload BEFORE INSERT OR UPDATE OF payload, legal_entity_id ON crove_kernel.proposal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.proposal_entity_payload();
-- Also in replica mode, where ordinary triggers stay silent.
ALTER TABLE crove_kernel.proposal ENABLE ALWAYS TRIGGER proposal_entity_payload;

-- ---------------------------------------------------------------------------
-- The upload names its entity (coordinator decision on #1764, option (a)). Until now a file's first reading took the
-- uploader's entity only for a member limited to some entities (kernel uploaderEntity); an owner's, an admin's or an
-- org-wide member's upload always went to the default entity, and moving the proposal was the only way to book it in
-- another entity. Now the upload may name the entity (the SPA sends the shell's chosen one), chosen once, when the
-- file is stored, and never changed: within ADR-0021.
--
-- crove_kernel.file.upload_entity_id   nullable: the entity the uploader named, or none (mailed and social files, and
--   an upload that named none, which take the uploader's entity or the default as before). Not legal_entity_id: a file
--   stays org-wide (its readings carry the entity), so it is no le_scope column. A foreign key to the org's entity,
--   with its index (G3 fk-index). Trigger file_upload_entity (BEFORE INSERT OR UPDATE OF upload_entity_id, ENABLE
--   ALWAYS): a writer names only an entity it can see (read as the writer, SECURITY INVOKER: one that does not exist and
--   one hidden from it answer the same LEGAL_ENTITY_NOT_ALLOWED, 42501), and the column never changes
--   (LEGAL_ENTITY_IMMUTABLE, 23514). A file deduplicated by its content keeps the entity of its first upload.
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS upload_entity_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                 WHERE c.conrelid = 'crove_kernel.file'::regclass AND c.conname = 'file_upload_entity_fk') THEN
    ALTER TABLE crove_kernel.file ADD CONSTRAINT file_upload_entity_fk
      FOREIGN KEY (org_id, upload_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id);
  END IF;
END $$;
-- The foreign key's index (G3 fk-index), entity first, as in 20261102140000.
CREATE INDEX IF NOT EXISTS file_upload_entity_idx ON crove_kernel.file (upload_entity_id, org_id);

CREATE OR REPLACE FUNCTION crove_kernel.file_upload_entity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.upload_entity_id IS DISTINCT FROM OLD.upload_entity_id THEN
      RAISE EXCEPTION 'LEGAL_ENTITY_IMMUTABLE' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', 'crove_kernel.file')::text;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.upload_entity_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.id = NEW.upload_entity_id) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.file_upload_entity() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS file_upload_entity ON crove_kernel.file;
CREATE TRIGGER file_upload_entity BEFORE INSERT OR UPDATE OF upload_entity_id ON crove_kernel.file
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.file_upload_entity();
ALTER TABLE crove_kernel.file ENABLE ALWAYS TRIGGER file_upload_entity;
