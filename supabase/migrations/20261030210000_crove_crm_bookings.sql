-- Crove CRM (issue #1318, plan docs/plan/calendar.md §3.3, step C3): a visitor books an event type on its public page.
-- The API's login cannot enter an org's system context (enter_system_context is the worker's alone), so the page goes
-- through three definers granted to crove_app, as Social's review link does, and the worker confirms each booking
-- through Runtime.execute() (crm.booking.confirm):
--
-- crove_crm.booking               a visitor's booking of an event type: requested (pending) by the public page, then
--                                 confirmed by the worker, which holds an event on the host's calendar (the
--                                 exclusion constraint of crove_kernel.calendar_event refuses a race) and links the
--                                 booking to a party, or refused (taken or unavailable). The page polls its status with
--                                 the request token it was given; only the token's SHA-256 is stored.
-- crove_crm.booking_page(...)     an active event type of an active org by slugs, with what the API needs to compute its
--                                 free slots: the host's weekly hours, busy intervals in a range (times only) and the
--                                 type's bookings per day. Never titles, never other event types.
-- crove_crm.booking_request(...)  records a pending booking and emits crm.booking.requested for the worker.
-- crove_crm.booking_status(...)   the status of the booking a request token names.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_crm.booking (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  event_type_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'refused', 'cancelled')),
  -- Why the worker refused it: the time was taken, or it is no longer offered (outside the hours, past the notice or
  -- the horizon, the day full, the type archived).
  refusal text CHECK (refusal IS NULL OR refusal IN ('taken', 'unavailable')),
  -- The event it holds on the host's calendar, once confirmed.
  calendar_event_id uuid,
  party_id uuid,
  -- The visitor. Nullable so a personal-data erasure can clear them; the request definer requires name and email.
  visitor_name text CHECK (visitor_name IS NULL OR pg_catalog.length(visitor_name) BETWEEN 1 AND 100),
  email text CHECK (email IS NULL OR pg_catalog.length(email) BETWEEN 3 AND 254),
  phone text CHECK (phone IS NULL OR pg_catalog.length(phone) BETWEEN 3 AND 30),
  note text CHECK (note IS NULL OR pg_catalog.length(note) <= 1000),
  -- The visitor's zone, for the times shown to them.
  time_zone text NOT NULL CHECK (pg_catalog.length(time_zone) BETWEEN 1 AND 64),
  request_token_sha256 bytea CHECK (request_token_sha256 IS NULL OR pg_catalog.length(request_token_sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT booking_order CHECK (ends_at > starts_at),
  CONSTRAINT booking_confirmed_event CHECK ((status IN ('confirmed', 'cancelled')) = (calendar_event_id IS NOT NULL)),
  CONSTRAINT booking_refusal CHECK ((status = 'refused') = (refusal IS NOT NULL)),
  CONSTRAINT booking_event_type_fk FOREIGN KEY (org_id, event_type_id) REFERENCES crove_crm.event_type (org_id, id),
  CONSTRAINT booking_calendar_event_fk FOREIGN KEY (org_id, calendar_event_id) REFERENCES crove_kernel.calendar_event (org_id, id),
  CONSTRAINT booking_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id)
);
CREATE INDEX IF NOT EXISTS booking_event_type_idx ON crove_crm.booking (org_id, event_type_id, starts_at);
CREATE INDEX IF NOT EXISTS booking_calendar_event_idx ON crove_crm.booking (org_id, calendar_event_id) WHERE calendar_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS booking_party_idx ON crove_crm.booking (org_id, party_id) WHERE party_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_request_token_uq ON crove_crm.booking (request_token_sha256) WHERE request_token_sha256 IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_crm.booking');
-- A booking is cancelled, never deleted.
REVOKE DELETE ON crove_crm.booking FROM crove_tenant;

-- The event type a page names, by the org's slug and the type's slug: active types of active orgs only.
CREATE OR REPLACE FUNCTION crove_crm.booking_event_type(p_org text, p_type text)
RETURNS TABLE (org_id uuid, org_name text, event_type_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.org_id, t.name, e.id
  FROM crove_kernel.tenant t
  JOIN crove_crm.event_type e ON e.org_id = t.org_id AND e.slug = p_type AND e.active
  WHERE t.slug = p_org AND t.status = 'active'
$$;
REVOKE ALL ON FUNCTION crove_crm.booking_event_type(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_crm.booking_page(p_org text, p_type text, p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_name text;
  v_type_id uuid;
  v_type crove_crm.event_type;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '62 days' THEN
    RAISE EXCEPTION 'invalid range' USING ERRCODE = '22023';
  END IF;
  SELECT b.org_id, b.org_name, b.event_type_id INTO v_org, v_name, v_type_id FROM crove_crm.booking_event_type(p_org, p_type) b;
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT e.* INTO v_type FROM crove_crm.event_type e WHERE e.org_id = v_org AND e.id = v_type_id;
  RETURN pg_catalog.jsonb_build_object(
    'orgName', v_name,
    'eventType', pg_catalog.jsonb_build_object(
      'slug', v_type.slug, 'title', v_type.title, 'description', v_type.description, 'durationMin', v_type.duration_min,
      'bufferBeforeMin', v_type.buffer_before_min, 'bufferAfterMin', v_type.buffer_after_min, 'minNoticeMin', v_type.min_notice_min,
      'horizonDays', v_type.horizon_days, 'dailyLimit', v_type.daily_limit, 'locationKind', v_type.location_kind),
    'hours', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('weekday', r.weekday, 'start', r.start_minute, 'end', r.end_minute, 'timeZone', r.time_zone)
        ORDER BY r.weekday, r.start_minute)
      FROM crove_kernel.availability_rule r WHERE r.org_id = v_org AND r.user_id = v_type.host_user_id), '[]'::jsonb),
    -- Busy time of the host around the range, widened by the longest event (31 days) on the left: times only.
    'busy', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(ev.starts_at, ev.ends_at) ORDER BY ev.starts_at)
      FROM crove_kernel.calendar_event ev
      WHERE ev.org_id = v_org AND ev.user_id = v_type.host_user_id AND ev.status = 'active'
        AND ev.starts_at < p_to AND ev.starts_at > p_from - interval '31 days' AND ev.ends_at > p_from), '[]'::jsonb),
    -- The type's confirmed bookings in the range, for its daily limit (the API counts them per day in the host's zone).
    'booked', coalesce((
      SELECT pg_catalog.jsonb_agg(bk.starts_at ORDER BY bk.starts_at)
      FROM crove_crm.booking bk
      WHERE bk.org_id = v_org AND bk.event_type_id = v_type.id AND bk.status = 'confirmed'
        AND bk.starts_at >= p_from - interval '1 day' AND bk.starts_at < p_to + interval '1 day'), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_page(text, text, timestamptz, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_page(text, text, timestamptz, timestamptz) TO crove_app;

-- A visitor's request: checked for shape and for the type's notice and horizon here; the worker checks the slot.
-- At most 30 requests an hour per event type, whatever the API's per-IP budget let through.
CREATE OR REPLACE FUNCTION crove_crm.booking_request(
  p_org text, p_type text, p_starts_at timestamptz, p_name text, p_email text, p_phone text, p_note text, p_time_zone text, p_token_sha256 bytea)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_phone text := nullif(pg_catalog.btrim(coalesce(p_phone, '')), '');
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_type_id uuid;
  v_type crove_crm.event_type;
  v_id uuid;
  v_event uuid;
BEGIN
  IF pg_catalog.length(v_name) NOT BETWEEN 1 AND 100 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR pg_catalog.length(v_email) > 254
     OR (v_phone IS NOT NULL AND pg_catalog.length(v_phone) NOT BETWEEN 3 AND 30) OR (v_note IS NOT NULL AND pg_catalog.length(v_note) > 1000)
     OR p_time_zone IS NULL OR pg_catalog.length(p_time_zone) NOT BETWEEN 1 AND 64 OR p_starts_at IS NULL
     OR p_token_sha256 IS NULL OR pg_catalog.length(p_token_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid booking request' USING ERRCODE = '22023';
  END IF;
  SELECT b.org_id, b.event_type_id INTO v_org, v_type_id FROM crove_crm.booking_event_type(p_org, p_type) b;
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT e.* INTO v_type FROM crove_crm.event_type e WHERE e.org_id = v_org AND e.id = v_type_id;
  IF p_starts_at < now() + pg_catalog.make_interval(mins => v_type.min_notice_min) OR p_starts_at > now() + pg_catalog.make_interval(days => v_type.horizon_days) THEN
    RAISE EXCEPTION 'this time is no longer offered' USING ERRCODE = '55000';
  END IF;
  -- Requests of one type are counted one at a time, so the cap holds against requests sent together.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove_crm.booking_request:' OPERATOR(pg_catalog.||) v_type.id::text, 0));
  IF (SELECT pg_catalog.count(*) FROM crove_crm.booking bk WHERE bk.org_id = v_org AND bk.event_type_id = v_type.id AND bk.created_at > now() - interval '1 hour') >= 30 THEN
    RAISE EXCEPTION 'booking request limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_crm.booking (org_id, event_type_id, starts_at, ends_at, visitor_name, email, phone, note, time_zone, request_token_sha256)
  VALUES (v_org, v_type.id, p_starts_at, p_starts_at + pg_catalog.make_interval(mins => v_type.duration_min), v_name, v_email, v_phone, v_note, p_time_zone, p_token_sha256)
  RETURNING id INTO v_id;
  INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type)
  VALUES (v_org, 'crm.booking.requested', pg_catalog.jsonb_build_object('booking_id', v_id), 'system')
  RETURNING id INTO v_event;
  INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES (v_org, v_event);
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_request(text, text, timestamptz, text, text, text, text, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_request(text, text, timestamptz, text, text, text, text, text, bytea) TO crove_app;

CREATE OR REPLACE FUNCTION crove_crm.booking_status(p_org text, p_type text, p_token_sha256 bytea)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object('status', bk.status, 'refusal', bk.refusal, 'startsAt', bk.starts_at, 'endsAt', bk.ends_at, 'timeZone', bk.time_zone)
  FROM crove_crm.booking_event_type(p_org, p_type) b
  JOIN crove_crm.booking bk ON bk.org_id = b.org_id AND bk.event_type_id = b.event_type_id
  WHERE bk.request_token_sha256 = p_token_sha256
$$;
REVOKE ALL ON FUNCTION crove_crm.booking_status(text, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_status(text, text, bytea) TO crove_app;

-- The worker's queue for crm.booking.confirm: one job per requested booking (singleton key <org>:<booking>).
SELECT crove_jobs.create_queue('crm-booking', '{"policy":"standard"}'::jsonb);
