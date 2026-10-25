-- Crove CRM (issue #1373, plan docs/plan/calendar.md §1 "Later", step C8): team event types. An event type keeps its
-- lead host (host_user_id) and may name more hosts:
--
-- round_robin   a slot is free when one of the hosts is free; the booking lands on one free host (the one with the
--               fewest upcoming bookings of the type), whose calendar holds it.
-- collective    a slot is free only when every host is free; the booking holds an event on every host's calendar, in
--               one transaction (the exclusion constraint of crove_kernel.calendar_event guards each host).
--
-- crove_crm.event_type.assignment         single (the lead host alone, as before), round_robin or collective.
-- crove_crm.event_type.co_host_user_ids   the hosts beside the lead: none for single, 1 to 9 for a team type.
-- crove_crm.booking.hold_event_ids        the events a collective booking holds on the co-hosts' calendars, beside
--                                         calendar_event_id (the lead's). Booking events are cancelled through their
--                                         booking only (calendar.event.cancel refuses them), so the ids stay valid.
-- crove_crm.booking_page(...)             also returns the assignment and, per host who may still host (an owner,
--                                         admin or member of the org), the weekly hours and busy times; still never
--                                         who the hosts are or what fills their calendars.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_crm.event_type ADD COLUMN IF NOT EXISTS assignment text NOT NULL DEFAULT 'single';
ALTER TABLE crove_crm.event_type ADD COLUMN IF NOT EXISTS co_host_user_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE crove_crm.booking ADD COLUMN IF NOT EXISTS hold_event_ids uuid[] NOT NULL DEFAULT '{}';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'event_type_assignment' AND conrelid = 'crove_crm.event_type'::regclass) THEN
    ALTER TABLE crove_crm.event_type ADD CONSTRAINT event_type_assignment CHECK (assignment IN ('single', 'round_robin', 'collective'));
  END IF;
  -- A single type has no co-host; a team type has 1 to 9, without nulls and without the lead host.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'event_type_co_hosts' AND conrelid = 'crove_crm.event_type'::regclass) THEN
    ALTER TABLE crove_crm.event_type ADD CONSTRAINT event_type_co_hosts CHECK (
      (assignment = 'single') = (pg_catalog.cardinality(co_host_user_ids) = 0)
      AND pg_catalog.cardinality(co_host_user_ids) <= 9
      AND pg_catalog.array_position(co_host_user_ids, NULL) IS NULL
      AND NOT (host_user_id = ANY (co_host_user_ids)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'booking_hold_events' AND conrelid = 'crove_crm.booking'::regclass) THEN
    ALTER TABLE crove_crm.booking ADD CONSTRAINT booking_hold_events CHECK (
      pg_catalog.cardinality(hold_event_ids) <= 9 AND pg_catalog.array_position(hold_event_ids, NULL) IS NULL
      AND (pg_catalog.cardinality(hold_event_ids) = 0 OR calendar_event_id IS NOT NULL));
  END IF;
END $$;

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
    'assignment', v_type.assignment,
    -- The lead host's hours and busy time, as before #1373 (an API still on the earlier release reads these).
    'hours', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('weekday', r.weekday, 'start', r.start_minute, 'end', r.end_minute, 'timeZone', r.time_zone)
        ORDER BY r.weekday, r.start_minute)
      FROM crove_kernel.availability_rule r WHERE r.org_id = v_org AND r.user_id = v_type.host_user_id), '[]'::jsonb),
    'busy', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(ev.starts_at, ev.ends_at) ORDER BY ev.starts_at)
      FROM crove_kernel.calendar_event ev
      WHERE ev.org_id = v_org AND ev.user_id = v_type.host_user_id AND ev.status = 'active'
        AND ev.starts_at < p_to AND ev.starts_at > p_from - interval '31 days' AND ev.ends_at > p_from), '[]'::jsonb),
    -- Every host who may still host (the lead first, then the co-hosts in their order), each with their weekly hours
    -- and busy time around the range, widened by the longest event (31 days) on the left: times only, no names.
    'hosts', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'hours', coalesce((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('weekday', r.weekday, 'start', r.start_minute, 'end', r.end_minute, 'timeZone', r.time_zone)
            ORDER BY r.weekday, r.start_minute)
          FROM crove_kernel.availability_rule r WHERE r.org_id = v_org AND r.user_id = h.user_id), '[]'::jsonb),
        'busy', coalesce((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(ev.starts_at, ev.ends_at) ORDER BY ev.starts_at)
          FROM crove_kernel.calendar_event ev
          WHERE ev.org_id = v_org AND ev.user_id = h.user_id AND ev.status = 'active'
            AND ev.starts_at < p_to AND ev.starts_at > p_from - interval '31 days' AND ev.ends_at > p_from), '[]'::jsonb))
        ORDER BY h.position)
      FROM pg_catalog.unnest(ARRAY[v_type.host_user_id] OPERATOR(pg_catalog.||) v_type.co_host_user_ids) WITH ORDINALITY AS h (user_id, position)
      JOIN crove_kernel.tenant_member m ON m.org_id = v_org AND m.user_id = h.user_id AND m.role IN ('owner', 'admin', 'member')), '[]'::jsonb),
    -- The type's confirmed bookings in the range, for its daily limit (the API counts them per day in the host's zone).
    'booked', coalesce((
      SELECT pg_catalog.jsonb_agg(bk.starts_at ORDER BY bk.starts_at)
      FROM crove_crm.booking bk
      WHERE bk.org_id = v_org AND bk.event_type_id = v_type.id AND bk.status = 'confirmed'
        AND bk.starts_at >= p_from - interval '1 day' AND bk.starts_at < p_to + interval '1 day'), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_page(text, text, timestamptz, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_page(text, text, timestamptz, timestamptz) TO crove_app;
