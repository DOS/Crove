-- Crove kernel (issue #1970, ADR-0017 section 1): every event the outbox takes carries ids and codes only, whoever
-- writes it. Idempotent; applied files stay untouched.
--
-- An event row is append-only and the outbox archive keeps payloads as plain JSON for 400 days, so no erasure can
-- reach a value once it is in one. ctx.emit already refuses a payload that is not ids and codes (#1949,
-- packages/kernel-runtime/src/event-payload.ts); definers that insert into outbox_event directly (Social's review
-- answers, CRM's bookings) went past that check. This holds every insert to the same rule.
--
-- crove_kernel.event_payload_problem(p_type, p_value)  The rule of eventPayloadProblem, in SQL (for one release, below,
--     it also takes what the previous release emits): the first value that
--     is not an id (a uuid), a code (no space, no @, ASCII only, at most 200 characters), a number, a boolean or null,
--     and any value under a key that names personal data, as '<path>: <why>'; null when every value is allowed. The
--     one text an event may carry is its type's agent task title, a module's fixed template:
--     social.post.submitted 'Rà soát bài gửi duyệt: <n> kênh', crm.booking.cancelled 'Khách hủy lịch hẹn'.
--     apps/kernel/test/invariant/event-payload.db.test.ts keeps it in step with the TypeScript rule.
-- crove_kernel.outbox_event_payload_guard  BEFORE INSERT on outbox_event: refuses a payload the rule refuses with
--     EVENT_PAYLOAD_NOT_ALLOWED (23514) and the path, never the value. Staff (a superuser, or a role that can act as
--     the table's owner) are not checked, so a support fix or a test that builds history still writes.
-- crove_kernel.user_auth_subject(p_user_id)  The identity provider subject of an account, for the sign-out job
--     (kernel.session.revoked now carries the user id, not the subject). Only the worker login role may execute it.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.event_payload_problem(p_type text, p_value jsonb, p_path text DEFAULT 'payload', p_depth integer DEFAULT 0)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- The key of this value: the last name of its path, without an array index.
  v_key text := pg_catalog.regexp_replace(pg_catalog.regexp_replace(p_path, '^.*[.]', ''), '\[[0-9]+\]$', '');
  v_text text;
  v_item record;
  v_problem text;
  v_i integer := 0;
BEGIN
  IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) IN ('null', 'boolean') THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.regexp_replace(pg_catalog.lower(v_key), '[^a-z]', '', 'g')
     ~ '(email|phone|address|taxcode|nationalid|idnumber|recipient|personname|fullname|displayname|birthdate)s?$' THEN
    RETURN p_path || ': a key that names personal data';
  END IF;
  IF pg_catalog.jsonb_typeof(p_value) = 'number' THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.jsonb_typeof(p_value) = 'string' THEN
    v_text := p_value #>> '{}';
    IF v_text = '' OR v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN NULL;
    END IF;
    IF p_path = 'payload.agent_task.title' AND (
         (p_type = 'social.post.submitted' AND v_text ~ '^Rà soát bài gửi duyệt: [0-9]{1,4} kênh$')
         OR (p_type = 'crm.booking.cancelled' AND v_text = 'Khách hủy lịch hẹn')) THEN
      RETURN NULL;
    END IF;
    -- For one release only, what the previous release still emits, since a rollback restores its images with this
    -- database (tools/deploy/deploy.sh: every migration keeps the previous release working): its CRM cancel title,
    -- which names the event type's title after the template, and its session revoke's identity provider subject.
    -- ctx.emit already refuses both in this release; #1980 drops this branch.
    IF (p_path = 'payload.agent_task.title' AND p_type = 'crm.booking.cancelled' AND v_text ~ '^Khách hủy lịch hẹn: '
        AND pg_catalog.length(v_text) <= 300)
       OR (p_path = 'payload.subject' AND p_type = 'kernel.session.revoked' AND pg_catalog.length(v_text) <= 255) THEN
      RETURN NULL;
    END IF;
    IF pg_catalog.length(v_text) > 200 THEN
      RETURN p_path || ': a string longer than 200 characters';
    END IF;
    IF v_text !~ '^[A-Za-z0-9+-][A-Za-z0-9_.:/+=,-]*$' THEN
      RETURN p_path || ': a string that is neither an id nor a code';
    END IF;
    RETURN NULL;
  END IF;
  IF p_depth >= 8 THEN
    RETURN p_path || ': nested deeper than 8';
  END IF;
  IF pg_catalog.jsonb_typeof(p_value) = 'array' THEN
    FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_value) e LOOP
      v_problem := crove_kernel.event_payload_problem(p_type, v_item.value, p_path || '[' || v_i || ']', p_depth + 1);
      IF v_problem IS NOT NULL THEN
        RETURN v_problem;
      END IF;
      v_i := v_i + 1;
    END LOOP;
    RETURN NULL;
  END IF;
  FOR v_item IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_value) e LOOP
    v_problem := crove_kernel.event_payload_problem(p_type, v_item.value, p_path || '.' || v_item.key, p_depth + 1);
    IF v_problem IS NOT NULL THEN
      RETURN v_problem;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.outbox_event_payload_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_problem text;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  v_problem := crove_kernel.event_payload_problem(NEW.type, NEW.payload);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'EVENT_PAYLOAD_NOT_ALLOWED' USING ERRCODE = '23514', DETAIL = NEW.type || ': ' || v_problem;
  END IF;
  RETURN NEW;
END $$;

-- A hot table: the trigger is created in the lock-retry block (plan §5.5).
DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    CREATE OR REPLACE TRIGGER outbox_event_payload_guard BEFORE INSERT ON crove_kernel.outbox_event
      FOR EACH ROW EXECUTE FUNCTION crove_kernel.outbox_event_payload_guard();
    EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random());
  END; END LOOP; END $$;

CREATE OR REPLACE FUNCTION crove_kernel.user_auth_subject(p_user_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Also refuses a definer owner or another role reached through a mistaken grant: only the worker login.
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'USER_SUBJECT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT u.subject FROM crove_kernel.user_account u WHERE u.id = p_user_id);
END $$;

-- EXECUTE matrix: the rule and the trigger's function for nobody; the subject for the worker login only.
REVOKE ALL ON FUNCTION crove_kernel.event_payload_problem(text, jsonb, text, integer), crove_kernel.outbox_event_payload_guard()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.user_auth_subject(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.user_auth_subject(uuid) TO crove_worker;
