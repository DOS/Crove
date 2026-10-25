-- Crove kernel (issue #1280 part 3b, plan §4.6 "an actor scoped to legal entities sees an org-wide record only if the
-- record is linked in record_le"): parties are scoped by links to legal entities. Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.record_le   a link from an org-wide record to one legal entity of its org. record_type is
--                          'kernel.party' for now. Tenants read the links of the entities in their scope (le_scope);
--                          only a writer with every entity in scope ('*': owners, admins and members without
--                          entity-limited assignments) may add or remove one, through the audited commands
--                          kernel.party.link_entity and kernel.party.unlink_entity.
-- crove_kernel.party       a RESTRICTIVE policy for SELECT, UPDATE and DELETE: '*' in scope, or a link to an entity in
--                          scope. INSERT is not narrowed. A party that a member limited to some entities creates is
--                          linked to those entities by the BEFORE INSERT trigger party_link_new (a definer, since such
--                          a member may not write links itself). The link is not visible to the same statement's
--                          RETURNING check, so writers give a new party its id and insert it without RETURNING.
--
-- Find or link by tax code (coordinator decision on #1280, 2026-10-26, option (b)): party.tax_code is unique per org,
-- so a member limited to entity B who records an invoice from a company the org already knows (unlinked, or linked to
-- entity A) would hit that index without seeing the party. crove_kernel.party_link_for_tax_code links such a party of
-- kind 'organization' to the caller's own entities and returns it: a company's tax code is public registry data and the
-- caller holds the invoice that names it. A party of kind 'person' carries personal data and is never linked this way:
-- the call refuses with PARTY_LINK_REQUIRED and names nothing (an owner links it). Only a user context may call it (an
-- agent or system context is refused), it links only into the caller's own le_scope, and the only caller is the
-- audited kernel command kernel.party.link_for_tax_code, which finance's upsertParty runs; no RPC exposes it.
--
-- Existing parties get no link: a member limited to some entities sees none of them until an owner links them.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.record_le (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  record_type text NOT NULL CHECK (record_type IN ('kernel.party')),
  record_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT record_le_once UNIQUE (org_id, record_type, record_id, legal_entity_id),
  CONSTRAINT record_le_legal_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);
-- The foreign key's index (G3 fk-index), entity first as in 20261102140000; the record key is led by the unique index.
CREATE INDEX IF NOT EXISTS record_le_legal_entity_idx ON crove_kernel.record_le (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.record_le');
-- Links are added and removed, never changed.
REVOKE UPDATE ON crove_kernel.record_le FROM crove_tenant;

DROP POLICY IF EXISTS le_scope ON crove_kernel.record_le;
CREATE POLICY le_scope ON crove_kernel.record_le AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Only a writer with every entity in scope adds or removes links.
DROP POLICY IF EXISTS record_le_add ON crove_kernel.record_le;
CREATE POLICY record_le_add ON crove_kernel.record_le AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS record_le_remove ON crove_kernel.record_le;
CREATE POLICY record_le_remove ON crove_kernel.record_le AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- ---------------------------------------------------------------------------
-- party: visible through '*' or a link
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS party_le_read ON crove_kernel.party;
CREATE POLICY party_le_read ON crove_kernel.party AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR EXISTS (
    SELECT 1 FROM crove_kernel.record_le r
    WHERE r.org_id = party.org_id AND r.record_type = 'kernel.party' AND r.record_id = party.id
      AND r.legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])));
DROP POLICY IF EXISTS party_le_update ON crove_kernel.party;
CREATE POLICY party_le_update ON crove_kernel.party AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR EXISTS (
    SELECT 1 FROM crove_kernel.record_le r
    WHERE r.org_id = party.org_id AND r.record_type = 'kernel.party' AND r.record_id = party.id
      AND r.legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR EXISTS (
    SELECT 1 FROM crove_kernel.record_le r
    WHERE r.org_id = party.org_id AND r.record_type = 'kernel.party' AND r.record_id = party.id
      AND r.legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])));
DROP POLICY IF EXISTS party_le_delete ON crove_kernel.party;
CREATE POLICY party_le_delete ON crove_kernel.party AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR EXISTS (
    SELECT 1 FROM crove_kernel.record_le r
    WHERE r.org_id = party.org_id AND r.record_type = 'kernel.party' AND r.record_id = party.id
      AND r.legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])));

-- A party that a member limited to some entities creates is linked to those entities. Definer: such a member may not
-- write links. It acts only for a party of the context's own org (any other insert is refused by the tenant policy) and
-- links only entities of that org (the foreign key), so it adds nothing the writer could not see.
CREATE OR REPLACE FUNCTION crove_kernel.party_link_new() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_scope text[] := crove_kernel.ctx_le_scope();
BEGIN
  IF v_scope IS NULL OR '*' = ANY (v_scope) OR pg_catalog.cardinality(v_scope) = 0
     OR NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;
  INSERT INTO crove_kernel.record_le (org_id, record_type, record_id, legal_entity_id, created_by)
  SELECT NEW.org_id, 'kernel.party', NEW.id, s::uuid, crove_kernel.ctx_user_id() FROM pg_catalog.unnest(v_scope) s
  ON CONFLICT ON CONSTRAINT record_le_once DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.party_link_new() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS party_link_new ON crove_kernel.party;
CREATE TRIGGER party_link_new BEFORE INSERT ON crove_kernel.party FOR EACH ROW EXECUTE FUNCTION crove_kernel.party_link_new();

-- Find or link by tax code (see the header). Returns the party of the caller's org holding p_tax_code, linked to every
-- entity in the caller's scope, with the entities this call linked; no row when no party holds it or the caller sees
-- every party already ('*').
CREATE OR REPLACE FUNCTION crove_kernel.party_link_for_tax_code(p_tax_code text) RETURNS TABLE (party_id uuid, linked uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_scope text[] := crove_kernel.ctx_le_scope();
  v_party uuid;
  v_kind text;
  v_linked uuid[];
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'USER_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_tax_code IS NULL OR v_scope IS NULL OR '*' = ANY (v_scope) OR pg_catalog.cardinality(v_scope) = 0 THEN
    RETURN;
  END IF;
  SELECT p.id, p.kind INTO v_party, v_kind FROM crove_kernel.party p WHERE p.org_id = v_org AND p.tax_code = p_tax_code;
  IF v_party IS NULL THEN
    RETURN;
  END IF;
  IF v_kind <> 'organization' THEN
    RAISE EXCEPTION 'PARTY_LINK_REQUIRED' USING ERRCODE = '42501';
  END IF;
  WITH added AS (
    INSERT INTO crove_kernel.record_le (org_id, record_type, record_id, legal_entity_id, created_by)
    SELECT v_org, 'kernel.party', v_party, s::uuid, crove_kernel.ctx_user_id() FROM pg_catalog.unnest(v_scope) s
    ON CONFLICT ON CONSTRAINT record_le_once DO NOTHING
    RETURNING legal_entity_id
  )
  SELECT coalesce(pg_catalog.array_agg(a.legal_entity_id ORDER BY a.legal_entity_id), '{}') INTO v_linked FROM added a;
  party_id := v_party;
  linked := v_linked;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.party_link_for_tax_code(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.party_link_for_tax_code(text) TO crove_tenant;

ANALYZE crove_kernel.record_le;

-- ---------------------------------------------------------------------------
-- The org purge deletes a closing org's links with its other working rows. Copied verbatim from
-- 20261102040100_crove_kernel_org_purge_booking_feed.sql (the newest definition on main), with only
-- crove_kernel.record_le added to v_kernel_first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.org_purge(p_min_days integer)
RETURNS TABLE (outcome text, counts jsonb, blob_keys text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_refusal text;
  v_n bigint;
  v_t text;
  v_deleted jsonb := '{}'::jsonb;
  v_pinned jsonb := '{}'::jsonb;
  v_anonymized bigint;
  v_keep_proposal uuid[];
  v_keep_task uuid[];
  v_keep_position uuid[];
  v_keep_run uuid[];
  v_keep_agent uuid[];
  v_keep_variant uuid[];
  v_keep_post uuid[];
  v_keep_connection uuid[];
  v_keep_party uuid[];
  v_keep_file uuid[];
  v_keys text[];
  -- Rows of these tables are deleted whole, in this order (children before the rows they reference).
  v_kernel_first text[] := ARRAY[
    'crove_kernel.activity', 'crove_kernel.agent_wakeup', 'crove_kernel.extraction',
    'crove_kernel.inbound_message', 'crove_kernel.notification', 'crove_kernel.notification_mute',
    'crove_kernel.mail_event', 'crove_kernel.mail_suppression', 'crove_kernel.mail_message',
    'crove_kernel.member_invite', 'crove_kernel.auth_session_org', 'crove_kernel.inbound_drop',
    'crove_kernel.idempotency_key', 'crove_kernel.oauth_state', 'crove_kernel.outbox_pending',
    'crove_kernel.proposal_policy', 'crove_kernel.refusal_tally', 'crove_kernel.tax_obligation_done',
    'crove_kernel.tax_profile', 'crove_kernel.usage_deferral', 'crove_kernel.file_upload', 'crove_kernel.record_le',
    'crove_kernel.budget_policy', 'crove_kernel.kill_switch', 'crove_kernel.credential',
    'crove_finance.vendor_account_rule', 'crove_finance.categorization_rule', 'crove_crm.booking_feed', 'crove_crm.booking', 'crove_kernel.availability_rule',
    'crove_kernel.calendar_event', 'crove_crm.event_type'];
  v_social text[] := ARRAY[
    'crove_social.account_snapshot', 'crove_social.bio_click', 'crove_social.bio_page', 'crove_social.brand_voice',
    'crove_social.calendar_feed', 'crove_social.calendar_note', 'crove_social.channel_policy',
    'crove_social.channel_set', 'crove_social.chat_alert_target', 'crove_social.chat_alert',
    'crove_social.feed_item', 'crove_social.feed', 'crove_social.idea_label', 'crove_social.idea',
    'crove_social.post_label', 'crove_social.queue_slot', 'crove_social.queue', 'crove_social.label',
    'crove_social.link_preview', 'crove_social.media_tag', 'crove_social.metric_snapshot',
    'crove_social.notification', 'crove_social.notification_mail_off', 'crove_social.notification_mute',
    'crove_social.post_comment', 'crove_social.post_media', 'crove_social.post_version', 'crove_social.publish_hold', 'crove_social.report_link',
    'crove_social.report_schedule_run', 'crove_social.report_schedule', 'crove_social.review_feedback',
    'crove_social.review_link_post', 'crove_social.review_link', 'crove_social.short_link_click',
    'crove_social.short_link', 'crove_social.snippet', 'crove_social.watermark', 'crove_social.report_branding', 'crove_social.goal', 'crove_social.banned_word', 'crove_social.external_import', 'crove_social.external_post', 'crove_social.channel_access', 'crove_social.review_check', 'crove_social.digest_week', 'crove_social.channel_option', 'crove_social.media_attribution', 'crove_social.push_subscription', 'crove_social.saved_view', 'crove_social.media_archive'];
BEGIN
  -- Also refuses a definer owner or another role reached through a mistaken grant: only the worker login, in the
  -- sealed system context of the org it purges (execute() of kernel.org.purge).
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ORG_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'ORG_PURGE_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The write fence: every other transaction inside an offboarding org holds this lock shared (enter_context,
  -- enter_system_context), so taking it exclusive waits for those in flight and holds new ones back until the purge
  -- commits; they then see the org closed and are refused. Taken before the tenant row, so an in-flight transaction
  -- that updates the tenant row cannot deadlock with the purge. This transaction's own shared hold does not conflict.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.org.purge:' || v_org::text, 0));
  -- Serializes purges of one org and holds the status still while the map runs.
  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org FOR UPDATE;
  v_refusal := crove_kernel.org_purge_refusal(v_org, p_min_days);
  IF v_refusal IS NOT NULL THEN
    outcome := v_refusal;
    RETURN NEXT;
    RETURN;
  END IF;

  -- The proposals behind kept books: the approval and four-eyes trail of booked entries (purchase documents, cash and
  -- journal vouchers, and reversals, whose entry names the proposal).
  v_keep_proposal := ARRAY(
    SELECT d.proposal_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.proposal_id IS NOT NULL
    UNION
    SELECT c.proposal_id FROM crove_finance.cash_voucher c WHERE c.org_id = v_org AND c.proposal_id IS NOT NULL
    UNION
    SELECT j.proposal_id FROM crove_finance.journal_voucher j WHERE j.org_id = v_org AND j.proposal_id IS NOT NULL
    UNION
    SELECT e.source_id FROM crove_finance.journal_entry e
    WHERE e.org_id = v_org AND e.source_type = 'kernel.proposal' AND e.source_id IS NOT NULL);

  -- Rows that append-only rows and kept proposals reference, with what they reference in turn.
  v_keep_task := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT c.task_id FROM crove_kernel.task_comment c WHERE c.org_id = v_org
      UNION
      SELECT r.source_task_id FROM crove_kernel.proposal r
      WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND r.source_task_id IS NOT NULL
      UNION
      SELECT t.parent_task_id FROM crove_kernel.task t JOIN k ON t.org_id = v_org AND t.id = k.id WHERE t.parent_task_id IS NOT NULL
    ) SELECT id FROM k);
  v_keep_run := ARRAY(
    SELECT t.checkout_run_id FROM crove_kernel.task t
    WHERE t.org_id = v_org AND t.id = ANY (v_keep_task) AND t.checkout_run_id IS NOT NULL
    UNION
    SELECT r.requested_by_run FROM crove_kernel.proposal r
    WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND r.requested_by_run IS NOT NULL);
  v_keep_position := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT t.assignee_position_id FROM crove_kernel.task t
      WHERE t.org_id = v_org AND t.id = ANY (v_keep_task) AND t.assignee_position_id IS NOT NULL
      UNION
      SELECT p.reports_to FROM crove_kernel.position p JOIN k ON p.org_id = v_org AND p.id = k.id WHERE p.reports_to IS NOT NULL
    ) SELECT id FROM k);
  v_keep_agent := ARRAY(
    SELECT p.holder_agent_id FROM crove_kernel.position p
    WHERE p.org_id = v_org AND p.id = ANY (v_keep_position) AND p.holder_agent_id IS NOT NULL
    UNION
    SELECT r.agent_id FROM crove_kernel.ai_run r WHERE r.org_id = v_org AND r.id = ANY (v_keep_run) AND r.agent_id IS NOT NULL
    UNION
    SELECT a.agent FROM crove_kernel.proposal r
    CROSS JOIN LATERAL (VALUES (r.requested_by_agent), (r.decided_by_agent)) a(agent)
    WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND a.agent IS NOT NULL);
  v_keep_variant := ARRAY(SELECT DISTINCT a.variant_id FROM crove_social.post_approval a WHERE a.org_id = v_org);
  v_keep_post := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT a.post_id FROM crove_social.post_approval a WHERE a.org_id = v_org
      UNION
      SELECT s.src FROM crove_social.post p JOIN k ON p.org_id = v_org AND p.id = k.id
      CROSS JOIN LATERAL (VALUES (p.repost_of), (p.recurrence_source_id)) s(src) WHERE s.src IS NOT NULL
    ) SELECT id FROM k);
  v_keep_connection := ARRAY(
    SELECT DISTINCT v.channel_connection_id FROM crove_social.post_variant v
    WHERE v.org_id = v_org AND v.id = ANY (v_keep_variant) AND v.channel_connection_id IS NOT NULL);
  v_keep_party := ARRAY(
    SELECT d.party_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.party_id IS NOT NULL
    UNION
    SELECT c.party_id FROM crove_finance.cash_voucher c WHERE c.org_id = v_org AND c.party_id IS NOT NULL
    UNION
    -- Ledger lines name parties without a foreign key (sales, opening balances, bank matching on 131 and 331).
    SELECT l.party_id FROM crove_finance.journal_line l WHERE l.org_id = v_org AND l.party_id IS NOT NULL);
  v_keep_file := ARRAY(
    SELECT d.source_file_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.source_file_id IS NOT NULL
    UNION
    SELECT l.file_id FROM crove_finance.portal_invoice_list l WHERE l.org_id = v_org AND l.file_id IS NOT NULL);

  DELETE FROM crove_kernel.proposal r WHERE r.org_id = v_org AND r.id <> ALL (v_keep_proposal);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.proposal', v_n);

  FOREACH v_t IN ARRAY v_kernel_first || v_social LOOP
    EXECUTE pg_catalog.format('DELETE FROM %s WHERE org_id = $1', v_t::regclass) USING v_org;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || pg_catalog.jsonb_build_object(v_t, v_n);
  END LOOP;

  -- Social: the posts and variants no approval pins, then the channel connections no kept variant uses.
  DELETE FROM crove_social.post_variant v WHERE v.org_id = v_org AND v.id <> ALL (v_keep_variant);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_social.post_variant', v_n);
  DELETE FROM crove_social.post p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_post);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_social.post', v_n);
  DELETE FROM crove_kernel.channel_connection c WHERE c.org_id = v_org AND c.id <> ALL (v_keep_connection);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.channel_connection', v_n);

  -- The org chart and its work, but what a task comment pins.
  DELETE FROM crove_kernel.task t WHERE t.org_id = v_org AND t.id <> ALL (v_keep_task);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.task', v_n);
  DELETE FROM crove_kernel.ai_run r WHERE r.org_id = v_org AND r.id <> ALL (v_keep_run);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.ai_run', v_n);
  DELETE FROM crove_kernel.position p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_position);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.position', v_n);
  DELETE FROM crove_kernel.agent a WHERE a.org_id = v_org AND a.id <> ALL (v_keep_agent);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.agent', v_n);

  -- Members last among the org chart: a kept position's holder becomes NULL (ON DELETE SET NULL).
  DELETE FROM crove_kernel.tenant_member m WHERE m.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.tenant_member', v_n);

  -- Parties: those a kept voucher names are anonymized, the rest deleted.
  UPDATE crove_kernel.party p SET duplicate_of = NULL
  WHERE p.org_id = v_org AND p.id = ANY (v_keep_party) AND p.duplicate_of IS NOT NULL;
  UPDATE crove_kernel.party p SET address = NULL, email = NULL, phone = NULL, verified_by = NULL
  WHERE p.org_id = v_org AND p.id = ANY (v_keep_party)
    AND (p.address IS NOT NULL OR p.email IS NOT NULL OR p.phone IS NOT NULL OR p.verified_by IS NOT NULL);
  GET DIAGNOSTICS v_anonymized = ROW_COUNT;
  DELETE FROM crove_kernel.party p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_party);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.party', v_n);

  -- Files: those the books reference stay. The blobs of the others go, unless a kept row has the same content. Only
  -- keys under the org's own documents prefix are returned (the content-address check is NOT VALID for old rows), so
  -- no archive/ or export/ key, nor another org's, can ever be deleted from here.
  WITH gone AS (
    DELETE FROM crove_kernel.file f WHERE f.org_id = v_org AND f.id <> ALL (v_keep_file) RETURNING f.storage_key
  )
  SELECT pg_catalog.count(*), ARRAY(
    SELECT DISTINCT g.storage_key FROM gone g
    WHERE g.storage_key LIKE 'org/' || v_org::text || '/%'
      AND NOT EXISTS (SELECT 1 FROM crove_kernel.file k WHERE k.org_id = v_org AND k.id = ANY (v_keep_file) AND k.storage_key = g.storage_key)
    ORDER BY 1)
  INTO v_n, v_keys FROM gone;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.file', v_n);

  v_pinned := pg_catalog.jsonb_build_object(
    'crove_kernel.task_comment', (SELECT pg_catalog.count(*) FROM crove_kernel.task_comment c WHERE c.org_id = v_org),
    'crove_kernel.task', pg_catalog.cardinality(v_keep_task),
    'crove_kernel.ai_run', pg_catalog.cardinality(v_keep_run),
    'crove_kernel.position', pg_catalog.cardinality(v_keep_position),
    'crove_kernel.agent', pg_catalog.cardinality(v_keep_agent),
    'crove_social.post_approval', (SELECT pg_catalog.count(*) FROM crove_social.post_approval a WHERE a.org_id = v_org),
    'crove_social.post_variant', pg_catalog.cardinality(v_keep_variant),
    'crove_social.post', pg_catalog.cardinality(v_keep_post),
    'crove_kernel.channel_connection', pg_catalog.cardinality(v_keep_connection));

  UPDATE crove_kernel.tenant t SET status = 'closed' WHERE t.org_id = v_org;

  outcome := 'ok';
  counts := pg_catalog.jsonb_build_object(
    'deleted', v_deleted,
    'pinned', v_pinned,
    'anonymized', pg_catalog.jsonb_build_object('crove_kernel.party', v_anonymized),
    'keptFiles', pg_catalog.cardinality(v_keep_file),
    'keptParties', pg_catalog.cardinality(v_keep_party),
    'keptProposals', pg_catalog.cardinality(v_keep_proposal));
  blob_keys := v_keys;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.org_purge(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.org_purge(integer) TO crove_worker;
