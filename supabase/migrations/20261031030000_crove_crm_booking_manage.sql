-- Crove CRM (issue #1319, plan docs/plan/calendar.md §3.3, step C4): a visitor cancels or moves a confirmed booking
-- from a link in its mails, with no account. The link carries a manage token: the booking's id, its revision and a
-- MAC of both under the deployment's mail key (crove_kernel.mail_hash_key, which no runtime role can read), so every
-- mail of one revision (the confirmation, the reminders) carries a working link and nothing secret is stored. A cancel
-- or a move raises the revision, and every link minted before it stops working: a link works once.
--
-- The API's login cannot enter an org's system context, so the page goes through two definers granted to crove_app;
-- the worker carries out the ask through Runtime.execute() (crm.booking.manage), as it confirms a booking:
--
-- crove_crm.booking_manage_token(id)      the token of a confirmed booking of the org in context (the mail template
--                                         asks for it at send time, through crm.booking.manage_link).
-- crove_crm.booking_manage_view(...)      the booking a token names, with whether the token still works and the
--                                         outcome of the last ask.
-- crove_crm.booking_manage_request(...)   records an ask (cancel, or move to a time) and emits
--                                         crm.booking.manage_requested for the worker. The last ask wins.
SET LOCAL lock_timeout = '2s';

-- Raised by every cancel or move; a manage token names one revision.
ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
-- The visitor's last ask from a manage link, and the worker's answer to it (NULL while it waits).
ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS manage_request_id uuid;
ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS manage_action text;
ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS manage_starts_at timestamptz;
ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS manage_requested_at timestamptz;
ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS manage_outcome text;
ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'booking_revision' AND conrelid = 'crove_crm.booking'::regclass) THEN
    ALTER TABLE crove_crm.booking ADD CONSTRAINT booking_revision CHECK (revision >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'booking_manage_action' AND conrelid = 'crove_crm.booking'::regclass) THEN
    ALTER TABLE crove_crm.booking ADD CONSTRAINT booking_manage_action CHECK (manage_action IS NULL OR manage_action IN ('cancel', 'move'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'booking_manage_outcome' AND conrelid = 'crove_crm.booking'::regclass) THEN
    ALTER TABLE crove_crm.booking ADD CONSTRAINT booking_manage_outcome
      CHECK (manage_outcome IS NULL OR manage_outcome IN ('cancelled', 'moved', 'taken', 'unavailable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'booking_manage_ask' AND conrelid = 'crove_crm.booking'::regclass) THEN
    ALTER TABLE crove_crm.booking ADD CONSTRAINT booking_manage_ask CHECK (
      (manage_request_id IS NULL) = (manage_action IS NULL) AND (manage_request_id IS NULL) = (manage_requested_at IS NULL)
      AND (manage_action = 'move') = (manage_starts_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'booking_cancelled_at' AND conrelid = 'crove_crm.booking'::regclass) THEN
    ALTER TABLE crove_crm.booking ADD CONSTRAINT booking_cancelled_at CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
  END IF;
END $$;

-- The MAC of one revision of a booking: 32 hex digits. Only the definers below call it.
CREATE OR REPLACE FUNCTION crove_crm.booking_manage_mac(p_booking uuid, p_revision integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
BEGIN
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN pg_catalog.left(pg_catalog.encode(
    pg_catalog.sha256(v_opad OPERATOR(pg_catalog.||) pg_catalog.sha256(v_ipad OPERATOR(pg_catalog.||) pg_catalog.convert_to(
      'crove.crm.booking.manage.v1' OPERATOR(pg_catalog.||) pg_catalog.chr(31) OPERATOR(pg_catalog.||) p_booking::text
      OPERATOR(pg_catalog.||) pg_catalog.chr(31) OPERATOR(pg_catalog.||) p_revision::text, 'UTF8'))),
    'hex'), 32);
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_manage_mac(uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The manage token of a confirmed booking of the org in context, for its current revision; NULL for any other booking.
CREATE OR REPLACE FUNCTION crove_crm.booking_manage_token(p_booking uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_revision integer;
BEGIN
  SELECT bk.revision INTO v_revision FROM crove_crm.booking bk
  WHERE bk.org_id = crove_kernel.ctx_org_id() AND bk.id = p_booking AND bk.status = 'confirmed';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.replace(p_booking::text, '-', '') OPERATOR(pg_catalog.||) '.' OPERATOR(pg_catalog.||) v_revision::text
    OPERATOR(pg_catalog.||) '.' OPERATOR(pg_catalog.||) crove_crm.booking_manage_mac(p_booking, v_revision);
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_manage_token(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_manage_token(uuid) TO crove_tenant;

-- The booking a token names on the page of these slugs (an active org; the type may since be archived), with the
-- revision the token was minted for. Nothing for a malformed token, a wrong MAC or another page's booking.
CREATE OR REPLACE FUNCTION crove_crm.booking_manage_find(p_org text, p_type text, p_token text)
RETURNS TABLE (org_id uuid, booking_id uuid, token_revision integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
  v_revision integer;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{32}\.[0-9]{1,9}\.[0-9a-f]{32}$' THEN
    RETURN;
  END IF;
  v_id := pg_catalog.split_part(p_token, '.', 1)::uuid;
  v_revision := pg_catalog.split_part(p_token, '.', 2)::integer;
  IF crove_crm.booking_manage_mac(v_id, v_revision) <> pg_catalog.split_part(p_token, '.', 3) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT bk.org_id, bk.id, v_revision
    FROM crove_crm.booking bk
    JOIN crove_kernel.tenant t ON t.org_id = bk.org_id AND t.slug = p_org AND t.status = 'active'
    JOIN crove_crm.event_type e ON e.org_id = bk.org_id AND e.id = bk.event_type_id AND e.slug = p_type
    WHERE bk.id = v_id;
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_manage_find(text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- What the manage page shows: the booking's time and status, whether the token still works (its revision is the
-- booking's and the booking is confirmed), and the answer to the last ask. NULL when the token names nothing here.
CREATE OR REPLACE FUNCTION crove_crm.booking_manage_view(p_org text, p_type text, p_token text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object(
    'orgName', t.name,
    'eventType', pg_catalog.jsonb_build_object('slug', e.slug, 'title', e.title, 'durationMin', e.duration_min, 'locationKind', e.location_kind, 'active', e.active),
    'status', bk.status, 'startsAt', bk.starts_at, 'endsAt', bk.ends_at, 'timeZone', bk.time_zone,
    'usable', f.token_revision = bk.revision AND bk.status = 'confirmed',
    'requestId', bk.manage_request_id, 'outcome', bk.manage_outcome)
  FROM crove_crm.booking_manage_find(p_org, p_type, p_token) f
  JOIN crove_crm.booking bk ON bk.org_id = f.org_id AND bk.id = f.booking_id
  JOIN crove_kernel.tenant t ON t.org_id = bk.org_id
  JOIN crove_crm.event_type e ON e.org_id = bk.org_id AND e.id = bk.event_type_id
$$;
REVOKE ALL ON FUNCTION crove_crm.booking_manage_view(text, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_manage_view(text, text, text) TO crove_app;

-- A visitor's ask from a manage link: cancel, or move to p_starts_at (checked for the type's notice and horizon here;
-- the worker checks the slot). Returns the ask's id, or NULL when the token names nothing here or no longer works.
CREATE OR REPLACE FUNCTION crove_crm.booking_manage_request(p_org text, p_type text, p_token text, p_action text, p_starts_at timestamptz)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_id uuid;
  v_token_revision integer;
  v_booking crove_crm.booking;
  v_type crove_crm.event_type;
  v_request uuid := crove_kernel.uuid_v7();
  v_event uuid;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('cancel', 'move') OR (p_action = 'move') <> (p_starts_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid manage request' USING ERRCODE = '22023';
  END IF;
  SELECT f.org_id, f.booking_id, f.token_revision INTO v_org, v_id, v_token_revision FROM crove_crm.booking_manage_find(p_org, p_type, p_token) f;
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT bk.* INTO v_booking FROM crove_crm.booking bk WHERE bk.org_id = v_org AND bk.id = v_id FOR UPDATE;
  IF v_booking.status <> 'confirmed' OR v_booking.revision <> v_token_revision THEN
    RETURN NULL;
  END IF;
  IF p_action = 'move' THEN
    SELECT e.* INTO v_type FROM crove_crm.event_type e WHERE e.org_id = v_org AND e.id = v_booking.event_type_id;
    IF NOT v_type.active OR p_starts_at < now() + pg_catalog.make_interval(mins => v_type.min_notice_min)
       OR p_starts_at > now() + pg_catalog.make_interval(days => v_type.horizon_days) THEN
      RAISE EXCEPTION 'this time is no longer offered' USING ERRCODE = '55000';
    END IF;
  END IF;
  UPDATE crove_crm.booking bk
     SET manage_request_id = v_request, manage_action = p_action, manage_starts_at = p_starts_at, manage_requested_at = now(), manage_outcome = NULL
   WHERE bk.org_id = v_org AND bk.id = v_id;
  INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
  VALUES (v_org, 'crm.booking.manage_requested', pg_catalog.jsonb_build_object('booking_id', v_id, 'request_id', v_request), 'system')
  RETURNING id INTO v_event;
  INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_org, v_event);
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN v_request;
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_manage_request(text, text, text, text, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_manage_request(text, text, text, text, timestamptz) TO crove_app;

-- The worker's queue for booking reminders, 24 hours and 1 hour before (singleton key <org>:<booking>:<start>:<lead>).
SELECT crove_jobs.create_queue('crm-booking-remind', '{"policy":"standard"}'::jsonb);
