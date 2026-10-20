-- Email E2 (issue #539, docs/plan/email.md §3.3, ADR-0034): delivery events from the mail provider, and what they
-- suppress. Idempotent; applied files stay untouched.
--
-- How an event travels:
--   1. The provider posts a webhook to POST /webhooks/mail/<provider>. The API checks its signature (a forged or stale
--      one is refused and stored nowhere) and hands the parsed events to mail_event_enqueue(), which writes machinery
--      rows and nothing else: the API never holds a tenant context for a webhook.
--   2. The worker relay claims them with mail_event_claim() and queues one job per event (kernel-mail-event).
--   3. The job finds the mail by the provider's message id (mail_message_by_provider_id(): the org comes from the
--      stored mail, never from the payload) and records the event in that org's system context
--      (kernel.mail.event.record): one mail_event row per provider event, the mail's status, and the suppression a
--      hard bounce or a complaint adds.

-- ---------------------------------------------------------------------------
-- mail_event (tenant table, append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.mail_event (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  message_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- The provider's id of this event, so a replayed webhook is recognized.
  provider_event_id text NOT NULL CHECK (pg_catalog.length(provider_event_id) BETWEEN 1 AND 255),
  kind text NOT NULL CHECK (kind IN ('delivered', 'deferred', 'bounce_hard', 'bounce_soft', 'complaint')),
  occurred_at timestamptz NOT NULL,
  -- Bounded, and never an address or a provider message: for example the bounce type.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (pg_catalog.jsonb_typeof(detail) = 'object' AND pg_catalog.pg_column_size(detail) <= 1024),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT mail_event_message_fk FOREIGN KEY (org_id, message_id) REFERENCES crove_kernel.mail_message (org_id, id),
  CONSTRAINT mail_event_provider_uq UNIQUE (org_id, provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS mail_event_message_idx ON crove_kernel.mail_event (org_id, message_id);
CREATE INDEX IF NOT EXISTS mail_event_soft_bounce_idx ON crove_kernel.mail_event (org_id, occurred_at) WHERE kind = 'bounce_soft';

SELECT crove_kernel.apply_tenant_rls('crove_kernel.mail_event', true);

-- Events are written only in the system context of their org (the worker recording a verified webhook or a bounce
-- report). Runs as the writer: a row for another org, or for a mail the writer cannot see, is left to row security
-- and the foreign key, which refuse it.
CREATE OR REPLACE FUNCTION crove_kernel.mail_event_before_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.org_id = crove_kernel.ctx_org_id() AND crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'mail events are written only by the worker that receives them' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mail_event_before_insert() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS mail_event_before_insert ON crove_kernel.mail_event;
CREATE TRIGGER mail_event_before_insert BEFORE INSERT ON crove_kernel.mail_event
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.mail_event_before_insert();

-- ---------------------------------------------------------------------------
-- mail_message: find a mail by the provider's id
-- ---------------------------------------------------------------------------
-- One mail per provider message id, across orgs, so an event can only ever match one mail.
CREATE UNIQUE INDEX IF NOT EXISTS mail_message_provider_uq ON crove_kernel.mail_message (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- The guard of 20261020120000, plus: the provider and its message id are written once, when the provider takes the
-- mail, and never changed after (the id is how its events find it). CREATE OR REPLACE keeps the privileges.
CREATE OR REPLACE FUNCTION crove_kernel.mail_message_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('queued', 'sending', 'suppressed') OR NEW.sent_at IS NOT NULL OR NEW.provider_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'MAIL_MESSAGE_INSERT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.stream IS DISTINCT FROM OLD.stream
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.template_key IS DISTINCT FROM OLD.template_key OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.to_hash IS DISTINCT FROM OLD.to_hash OR NEW.message_id_header IS DISTINCT FROM OLD.message_id_header
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     -- The address, subject and payload may only be dropped (a retention purge), never changed.
     OR (NEW.to_address IS DISTINCT FROM OLD.to_address AND NEW.to_address IS NOT NULL)
     OR (NEW.subject IS DISTINCT FROM OLD.subject AND NEW.subject IS NOT NULL)
     OR (NEW.payload IS DISTINCT FROM OLD.payload AND NEW.payload IS NOT NULL)
     -- Once a provider gave the mail its id, neither the id nor the provider changes.
     OR (OLD.provider_message_id IS NOT NULL
         AND (NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id OR NEW.provider IS DISTINCT FROM OLD.provider)) THEN
    RAISE EXCEPTION 'MAIL_MESSAGE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'MAIL_MESSAGE_ATTEMPTS' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('sending', 'suppressed', 'failed'))
    OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'failed', 'ambiguous'))
    OR (OLD.status = 'ambiguous' AND NEW.status IN ('sending', 'sent', 'failed'))
    OR (OLD.status = 'sent' AND NEW.status IN ('delivered', 'bounced', 'complained'))
    OR (OLD.status = 'delivered' AND NEW.status IN ('bounced', 'complained'))) THEN
    RAISE EXCEPTION 'MAIL_MESSAGE_STATUS' USING ERRCODE = '23514', DETAIL = OLD.status || ' -> ' || NEW.status;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mail_message_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The org and id of the mail a provider event names (worker only). Nothing for an unknown id.
CREATE OR REPLACE FUNCTION crove_kernel.mail_message_by_provider_id(p_provider text, p_provider_message_id text)
RETURNS TABLE (org_id uuid, message_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.org_id, m.id FROM crove_kernel.mail_message m
  WHERE m.provider = p_provider AND m.provider_message_id = p_provider_message_id
$$;

-- ---------------------------------------------------------------------------
-- Verified events waiting for the worker (global machinery table, no org_id: the org is found from the mail).
-- Only the definers below touch it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.mail_event_pending (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  provider_event_id text NOT NULL CHECK (pg_catalog.length(provider_event_id) BETWEEN 1 AND 255),
  provider_message_id text NOT NULL CHECK (pg_catalog.length(provider_message_id) BETWEEN 1 AND 255),
  kind text NOT NULL CHECK (kind IN ('delivered', 'deferred', 'bounce_hard', 'bounce_soft', 'complaint')),
  occurred_at timestamptz NOT NULL,
  detail jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(detail) = 'object' AND pg_catalog.pg_column_size(detail) <= 1024),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (provider, provider_event_id)
);
REVOKE ALL ON crove_kernel.mail_event_pending FROM PUBLIC;
ALTER TABLE crove_kernel.mail_event_pending ENABLE ROW LEVEL SECURITY;
-- Like every crove_* table, refused to agent contexts (#285); only the definers below write it anyway.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.mail_event_pending');

-- Records the events of one verified webhook delivery for the worker (API only): an array of at most 100
-- {providerEventId, providerMessageId, kind, occurredAt, detail}. Reads nothing and writes no tenant data. An event
-- already pending is skipped. The API role is not trusted with volume: past 10000 pending events it raises 53400
-- (configuration_limit_exceeded), which the API answers with 503 and the provider retries.
CREATE OR REPLACE FUNCTION crove_kernel.mail_event_enqueue(p_provider text, p_events jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF pg_catalog.jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_events) > 100 THEN
    RAISE EXCEPTION 'MAIL_EVENTS_INVALID' USING ERRCODE = '22P02';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM (SELECT 1 FROM crove_kernel.mail_event_pending LIMIT 10001) s) > 10000 THEN
    RAISE EXCEPTION 'MAIL_EVENT_BACKLOG' USING ERRCODE = '53400';
  END IF;
  INSERT INTO crove_kernel.mail_event_pending (provider, provider_event_id, provider_message_id, kind, occurred_at, detail)
  SELECT p_provider, e ->> 'providerEventId', e ->> 'providerMessageId', e ->> 'kind', (e ->> 'occurredAt')::timestamptz,
         coalesce(e -> 'detail', '{}'::jsonb)
  FROM pg_catalog.jsonb_array_elements(p_events) e
  ON CONFLICT (provider, provider_event_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    PERFORM pg_catalog.pg_notify('crove_outbox', '');
  END IF;
  RETURN v_count;
END $$;

-- Claims pending events for the worker relay (worker only).
CREATE OR REPLACE FUNCTION crove_kernel.mail_event_claim(p_limit integer)
RETURNS TABLE (seq bigint, provider text, provider_event_id text, provider_message_id text, kind text, occurred_at timestamptz, detail jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  DELETE FROM crove_kernel.mail_event_pending p
  WHERE p.seq IN (
    SELECT q.seq FROM crove_kernel.mail_event_pending q ORDER BY q.seq LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  RETURNING p.seq, p.provider, p.provider_event_id, p.provider_message_id, p.kind, p.occurred_at, p.detail
$$;

REVOKE ALL ON FUNCTION
  crove_kernel.mail_message_by_provider_id(text, text),
  crove_kernel.mail_event_enqueue(text, jsonb),
  crove_kernel.mail_event_claim(integer)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mail_message_by_provider_id(text, text), crove_kernel.mail_event_claim(integer) TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.mail_event_enqueue(text, jsonb) TO crove_app;

-- The worker's queue for recording one delivery event (apps/kernel/src/jobs-schema.ts QUEUES.mailEvent; singleton
-- key <provider>:<event>). create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('kernel-mail-event', '{"policy":"standard"}'::jsonb);
