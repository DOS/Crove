-- A notification's invalidation hint reaches only its recipient's streams (issue #1702, found in the review of #1700).
-- Idempotent; applied files stay untouched.
--
-- crove_kernel.notification is one member's: the RESTRICTIVE own_notification policy lets only the recipient read the
-- row. Its hint still went to every open stream of the org (of its legal entity, since #1692), so every other member
-- learned the id and the timing of each notification a colleague got. The hint of a notification now names its
-- recipient as a last field, after the entity:
--     <org_id> notification <id> <legal_entity_id> @<user_id>
-- and the API hands it only to the streams opened by that user (apps/kernel/src/stream.ts), failing closed: a
-- notification hint without a recipient reaches no stream. The recipient is a routing key for the API, never sent to
-- the client: an `invalidate` event is still {type, id}. Every other hint keeps its fields and its reach.
--
-- The hint type, not a trigger argument, says that a hint is a member's own, as the API's list of such types does
-- (RECIPIENT_HINT_TYPES): the triggers keep their arguments, so the stream_hint triggers of the tables under le_scope
-- still name exactly (type, id column, legal_entity_id). user_id is NOT NULL; a row without one sends nothing rather
-- than a hint for everyone. The payload still holds ids only (any role may LISTEN on any channel): a user id names no
-- data.
--
-- This replaces the function of 20261103080000_crove_kernel_stream_legal_entity.sql with every branch it had (the id
-- column of TG_ARGV[1], the entity of TG_ARGV[2] and its fail-closed check, STREAM_HINT_INVALID for any other
-- argument) and keeps its signature, owner and grants (EXECUTE for nobody). No trigger changes.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.stream_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
  v_entity uuid;
  v_payload text;
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
  v_payload := NEW.org_id::text || ' ' || TG_ARGV[0] || ' ' || v_id::text;
  IF TG_NARGS > 2 THEN
    IF TG_NARGS > 3 OR TG_ARGV[2] <> 'legal_entity_id' THEN
      RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_entity := NEW.legal_entity_id;
    -- Fail closed: a scoped row never becomes an org-wide hint.
    IF v_entity IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' ' || v_entity::text;
  END IF;
  -- A member's own notification: only the recipient's streams get it. Fail closed, as for the entity.
  IF TG_ARGV[0] = 'notification' THEN
    IF NEW.user_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' @' || NEW.user_id::text;
  END IF;
  PERFORM pg_catalog.pg_notify('crove_stream', v_payload);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.stream_notify() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
