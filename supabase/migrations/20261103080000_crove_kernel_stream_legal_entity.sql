-- Invalidation hints honor the legal-entity scope (issue #1692, plan §9 Updates, Phase 1 exit criterion 2). Idempotent;
-- applied files stay untouched.
--
-- The rows of a table under the RESTRICTIVE le_scope policy belong to one legal entity of their org, and a member
-- limited to some entities (an external accountant's assignments) may not read the others. Until now every hint went
-- to every open stream of the org, so such a member learned that a record of another entity changed, and its id. The
-- hint of an entity-scoped row now carries that entity as a fourth field:
--     <org_id> <type> <id> <legal_entity_id>
-- and the API drops it for a stream whose kernel.stream.check scope leaves the entity out ('*' keeps every entity, an
-- empty scope none). The entity is a routing key for the API, never sent to the client: an `invalidate` event is still
-- {type, id}. Hints of org-wide rows keep the three fields and reach every stream of the org as before.
--
--     type           table                                 entity column
--     journal_entry  crove_finance.journal_entry           legal_entity_id
--     document       crove_finance.purchase_document       legal_entity_id
--                    crove_finance.purchase_document_void  legal_entity_id (the voided document's, b_legal_entity)
--     extraction     crove_kernel.extraction               legal_entity_id
--     notification   crove_kernel.notification             legal_entity_id
--   org-wide (unchanged)
--     proposal       crove_kernel.proposal                 its legal_entity_id is a stamp, not yet a scope (#1538): every
--                                                          member still reads every proposal, so its hint stays org-wide
--     file           crove_kernel.file                     files have no entity
--     social_post, social_notification                     no entity
--
-- Every entity column above is NOT NULL. A scoped row whose entity is nevertheless missing sends nothing, rather than
-- an org-wide hint. The payload still holds ids only (any role may LISTEN on any channel): an entity id names no data.
--
-- TG_ARGV[2] names the entity column; the function keeps its signature, its owner and its grants (EXECUTE for nobody).
-- This file replaces the function and the kernel tables' triggers; the finance tables' triggers are re-created by the
-- next file, 20261103090000_crove_finance_stream_legal_entity.sql (one module schema per file).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.stream_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
  v_entity uuid;
BEGIN
  IF TG_ARGV[1] = 'file_id' THEN
    v_id := NEW.file_id;
  ELSIF TG_ARGV[1] = 'document_id' THEN
    v_id := NEW.document_id;
  ELSE
    v_id := NEW.id;
  END IF;
  IF NEW.org_id IS NULL OR v_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_NARGS > 2 THEN
    IF TG_NARGS > 3 OR TG_ARGV[2] <> 'legal_entity_id' THEN
      RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_entity := NEW.legal_entity_id;
    -- Fail closed: a scoped row never becomes an org-wide hint.
    IF v_entity IS NULL THEN
      RETURN NULL;
    END IF;
    PERFORM pg_catalog.pg_notify('crove_stream', NEW.org_id::text || ' ' || TG_ARGV[0] || ' ' || v_id::text || ' ' || v_entity::text);
  ELSE
    PERFORM pg_catalog.pg_notify('crove_stream', NEW.org_id::text || ' ' || TG_ARGV[0] || ' ' || v_id::text);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.stream_notify() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.extraction;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_kernel.extraction
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('extraction', 'file_id', 'legal_entity_id');
DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.notification;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_kernel.notification
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('notification', 'id', 'legal_entity_id');
