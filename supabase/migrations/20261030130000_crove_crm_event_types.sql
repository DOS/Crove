-- Crove CRM (issue #1314, plan docs/plan/calendar.md §3.1, step C2): the crm module's schema, starting with the event
-- types of booking pages. The module runs only where the deployment enables it (CROVE_MODULES, ADR-0031); its schema
-- is created everywhere, as every module's is. Idempotent; applied files stay untouched.
--
-- crove_crm.event_type   a kind of meeting a client can book with one member (the host): its title, length, the
--                        buffers kept free before and after, how much notice it needs, how far ahead it may be booked,
--                        how many a day, and where it happens. Its slug names it in the public booking page's URL
--                        (C3, #1318), so it is unique per org. Event types are archived (active false), not deleted,
--                        so bookings keep their type.
SET LOCAL lock_timeout = '2s';

CREATE SCHEMA IF NOT EXISTS crove_crm;
GRANT USAGE ON SCHEMA crove_crm TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_crm.event_type (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND pg_catalog.length(slug) <= 60),
  title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR pg_catalog.length(description) <= 1000),
  duration_min smallint NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_before_min smallint NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 240),
  buffer_after_min smallint NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 240),
  -- Up to 30 days of notice, and up to a year ahead.
  min_notice_min integer NOT NULL DEFAULT 240 CHECK (min_notice_min BETWEEN 0 AND 43200),
  horizon_days smallint NOT NULL DEFAULT 60 CHECK (horizon_days BETWEEN 1 AND 365),
  daily_limit smallint CHECK (daily_limit IS NULL OR daily_limit BETWEEN 1 AND 50),
  location_kind text NOT NULL DEFAULT 'video' CHECK (location_kind IN ('in_person', 'phone', 'video')),
  -- An address, a phone number or a meeting link, shown to the visitor once booked.
  location_value text CHECK (location_value IS NULL OR pg_catalog.length(location_value) <= 500),
  host_user_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT event_type_slug_uq UNIQUE (org_id, slug)
);
CREATE INDEX IF NOT EXISTS event_type_host_idx ON crove_crm.event_type (org_id, host_user_id);
SELECT crove_kernel.apply_tenant_rls('crove_crm.event_type');
-- Archived, never deleted.
REVOKE DELETE ON crove_crm.event_type FROM crove_tenant;
