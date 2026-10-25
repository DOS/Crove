-- Crove CRM (issue #1382, plan docs/plan/calendar.md §2, row "Calendar feed"): a member's bookings as a feed that
-- Google Calendar, Outlook or Apple Calendar subscribes to. Read-only and one way: it does not read the member's
-- outside calendar (that is step C6, #1374). Idempotent; applied files stay untouched.
--
-- booking_feed  a member's subscription address: the SHA-256 of its token (the secret is only in the address the
--               member copies), whose bookings it shows, when it was made, and its revocation. A member has at most one
--               live feed; owners, admins and members make a new one (which revokes the old) and revoke it through
--               commands, for themselves only; the worker revokes it when the member leaves the org or becomes a
--               viewer. Nothing else about a feed changes.
--
-- booking_feed_events(token)  for a live feed of an active org whose member may still host (an owner, admin or member
--                             of the org, with an account not disabled): the org's slug and name and the member's confirmed bookings from 30 days
--                             back to 90 days ahead, at most 1000, each with its times, revision, event type title and
--                             location, and the visitor's name. No email, phone or note; NULL otherwise. Only crove_app
--                             (the API login role, which serves GET /cal/<token>.ics) may execute it.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_crm.booking_feed (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The member whose bookings it shows, who made it and alone revokes it.
  user_id uuid NOT NULL,
  token_sha256 text NOT NULL CONSTRAINT booking_feed_token_format CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT booking_feed_token_uq UNIQUE (token_sha256)
);
-- One live feed per member is kept by the commands (they revoke the live one under a per-member lock before they add
-- one), as for the posting calendar feed; a unique index would refuse the rows the RLS matrix inserts for one member.
CREATE INDEX IF NOT EXISTS booking_feed_user_idx ON crove_crm.booking_feed (org_id, user_id) WHERE revoked_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_crm.booking_feed');
REVOKE UPDATE, DELETE ON crove_crm.booking_feed FROM crove_tenant;
GRANT UPDATE (revoked_at) ON crove_crm.booking_feed TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_crm.booking_feed_events(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_feed crove_crm.booking_feed;
  v_tenant crove_kernel.tenant;
BEGIN
  -- 32 random bytes, base64url without padding (newFeedToken in modules/crm).
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT f.* INTO v_feed FROM crove_crm.booking_feed f
  WHERE f.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_feed.id IS NULL OR v_feed.revoked_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.* INTO v_tenant FROM crove_kernel.tenant t WHERE t.org_id = v_feed.org_id AND t.status = 'active';
  IF v_tenant.org_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- A member who left the org, became a viewer or whose account is disabled hosts no more: their address stops
  -- working. (Leaving or becoming a viewer also revokes the feed, crm.booking_feed.revoke_for_member, so being added
  -- back does not bring an old address back.)
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_feed.org_id AND m.user_id = v_feed.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;
  RETURN (
    WITH e AS (
      -- The member's own events of confirmed bookings: the lead's (calendar_event_id) or a co-host's of a collective
      -- booking (hold_event_ids). A move changes the event's times in place; a cancel cancels the event.
      SELECT b.id, ev.starts_at, ev.ends_at, b.revision, t.title, t.location_kind, t.location_value, b.visitor_name
      FROM crove_kernel.calendar_event ev
      JOIN crove_crm.booking b ON b.org_id = ev.org_id AND (b.calendar_event_id = ev.id OR ev.id = ANY (b.hold_event_ids))
      JOIN crove_crm.event_type t ON t.org_id = b.org_id AND t.id = b.event_type_id
      WHERE ev.org_id = v_feed.org_id AND ev.user_id = v_feed.user_id AND ev.kind = 'booking' AND ev.status = 'active'
        AND b.status = 'confirmed'
        AND ev.starts_at >= pg_catalog.now() - interval '30 days' AND ev.starts_at < pg_catalog.now() + interval '90 days'
      -- Past 1000, the ones nearest to now stay.
      ORDER BY pg_catalog.abs(EXTRACT(EPOCH FROM ev.starts_at - pg_catalog.now())), b.id
      LIMIT 1000
    )
    SELECT pg_catalog.jsonb_build_object(
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'events', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', e.id,
          'startsAt', e.starts_at,
          'endsAt', e.ends_at,
          'revision', e.revision,
          'title', e.title,
          'locationKind', e.location_kind,
          'location', e.location_value,
          'visitorName', e.visitor_name
        ) ORDER BY e.starts_at, e.id)
        FROM e
      ), '[]'::jsonb)
    )
  );
END $$;
REVOKE ALL ON FUNCTION crove_crm.booking_feed_events(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.booking_feed_events(text) TO crove_app;
