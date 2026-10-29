-- Crove kernel (issue #1764, from the security review of #1756; coordinator decision 2026-10-29, option 1): a
-- proposal's content never names another legal entity than the proposal's own. Idempotent; applied files stay
-- untouched.
--
-- Since #1538 a proposal is read only by the members and agents whose le_scope covers its legal_entity_id, the entity
-- of the reading it came from or the one it was asked for in. That column never changes once written, for every role
-- (b_legal_entity, #1280; ADR-0021 names it as the control that stands in for leaving the entity out of
-- payload_sha256). An edit could still move an invoice to another entity through its payload (finance.purchase.revise,
-- legalEntityId, #1543), and approval books it where the payload says: entity B's invoice read by entity A's members,
-- out of sight of B's until it is booked. Re-stamping the proposal on such a move would relax that ADR control, an
-- owner decision, so the move is refused instead: to book a document in another entity, reject the proposal and
-- upload the document again there.
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

DROP TRIGGER IF EXISTS proposal_entity_payload ON crove_kernel.proposal;
CREATE TRIGGER proposal_entity_payload BEFORE INSERT OR UPDATE OF payload, legal_entity_id ON crove_kernel.proposal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.proposal_entity_payload();
-- Also in replica mode, where ordinary triggers stay silent.
ALTER TABLE crove_kernel.proposal ENABLE ALWAYS TRIGGER proposal_entity_payload;
