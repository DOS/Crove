-- Org purge: the operator's command that applies the offboarding deletion map to an org and closes it (issue #1024,
-- plan §7.9 step 3, docs/runbooks/org-offboarding.md "Deletion map"). Run by hand, never automatically: the
-- `org-purge` image role in the worker's container. Idempotent; applied files stay untouched.
--
-- crove_kernel.org_purge_refusal(p_org_id, p_min_days)
--   Why the org may not be purged yet, or NULL when it may: 'invalid' (min days outside 30..3650), 'not_found',
--   'closed', 'not_offboarding', 'export_missing' (no ok kernel.org.export.record of format crove.org-export.v2 by
--   the system), 'export_pending' (the owner asked for a newer export, kernel.org.offboard, than the newest record) or
--   'too_early' (the newest record is younger than p_min_days days). The floor of 30 days is the database's: a
--   deployment may wait longer (ORG_PURGE_MIN_DAYS), never less. Callable by no role; the definers below and the
--   status guard call it as the table owner.
--
-- crove_kernel.org_purge_check(p_ref)
--   For the operator's command, before it opens the purge: the org by id or slug, its status and its newest export,
--   with the refusal for the 30-day floor. Read only. Worker login only.
--
-- crove_kernel.org_purge(p_min_days)
--   The purge itself, in the command's transaction (kernel.org.purge, system actor, sealed system context of the
--   org): re-checks the preconditions under the tenant row's lock, applies the deletion map, sets status = 'closed',
--   and answers the counts per table plus the storage keys of the deleted files' blobs (keys no kept file row
--   shares), which the command deletes before it commits. Refusals are answered as an outcome, so the command can
--   report them; nothing is changed then. Worker login only.
--   * Kept: the books (every crove_finance table but vendor_account_rule), audit_event, outbox_event, the tenant row,
--     inbound addresses (tombstones), org_usage, outbox_archive (the outbox days the daily job archived, #997),
--     external_call (the ledger of calls to social platforms), the files a purchase document or a portal list
--     references, the proposals behind booked entries (the approval trail), and the parties a purchase document, a
--     cash voucher or a ledger line names (anonymized: address, email, phone, verifier and duplicate link cleared;
--     kind, name and tax code stay, as on the voucher).
--   * Append-only working rows cannot be deleted (task_comment, Social's post_approval) and are kept with the rows
--     they reference (their tasks with their parents, the assignee positions with their managers, those positions'
--     agents and the tasks' checkout runs; the approved variants, their posts with their sources, and the variants'
--     channel connections). The counts report them as pinned.
--   * Deleted: everything else of the org (see the arrays below).
--
-- tenant_status_guard: besides staff and the active -> offboarding move, the worker login may move an org from
--   offboarding to closed only inside a definer owned by the table owner (current_user acts as the owner, so a plain
--   UPDATE by the worker is refused), in the org's sealed system context, with org_purge_refusal(org, 30) NULL.
-- tenant_close_requires_purge (deferred to commit): a non-staff close commits only together with the 'ok' audit row
--   of kernel.org.purge, by the system, written in the same transaction (as tenant_offboarding_requires_audit).
-- tenant_member_keeps_owner: an org keeps at least one owner unless it is closed, so the purge deletes the members.
-- enter_context, enter_system_context: the write fence. Entering an offboarding org takes the advisory lock
--   'kernel.org.purge:<org>' shared for the transaction; the purge takes it exclusive, so it waits for transactions
--   already in the org and holds new ones back until it commits, when they see the org closed and are refused. An
--   advisory lock, not FOR SHARE on the tenant row: queries and the export run READ ONLY, where row locks are refused.
--   Active orgs take no lock; agents enter active orgs only.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Preconditions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.org_purge_refusal(p_org_id uuid, p_min_days integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_status text;
  v_exported timestamptz;
BEGIN
  IF p_min_days IS NULL OR p_min_days < 30 OR p_min_days > 3650 THEN
    RETURN 'invalid';
  END IF;
  SELECT t.status INTO v_status FROM crove_kernel.tenant t WHERE t.org_id = p_org_id;
  IF v_status IS NULL THEN
    RETURN 'not_found';
  ELSIF v_status = 'closed' THEN
    RETURN 'closed';
  ELSIF v_status <> 'offboarding' THEN
    RETURN 'not_offboarding';
  END IF;
  SELECT a.occurred_at INTO v_exported FROM crove_kernel.audit_event a
  WHERE a.org_id = p_org_id AND a.command = 'kernel.org.export.record' AND a.outcome = 'ok' AND a.actor_type = 'system'
    AND a.detail ->> 'format' = 'crove.org-export.v2'
  ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1;
  IF v_exported IS NULL THEN
    RETURN 'export_missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = p_org_id AND a.command = 'kernel.org.offboard' AND a.outcome = 'ok' AND a.actor_type = 'user'
      AND a.occurred_at > v_exported
  ) THEN
    RETURN 'export_pending';
  END IF;
  IF v_exported > pg_catalog.now() - pg_catalog.make_interval(days => p_min_days) THEN
    RETURN 'too_early';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.org_purge_check(p_ref text)
RETURNS TABLE (outcome text, org_id uuid, status text, exported_at timestamptz, refusal text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ref text := pg_catalog.btrim(coalesce(p_ref, ''));
  v_org uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ORG_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_ref = '' OR pg_catalog.length(v_ref) > 200 THEN
    outcome := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT t.org_id INTO v_org FROM crove_kernel.tenant t WHERE t.org_id = v_ref::uuid;
  ELSE
    SELECT t.org_id INTO v_org FROM crove_kernel.tenant t WHERE t.slug = pg_catalog.lower(v_ref);
  END IF;
  IF v_org IS NULL THEN
    outcome := 'not_found';
    RETURN NEXT;
    RETURN;
  END IF;
  outcome := 'ok';
  org_id := v_org;
  SELECT t.status INTO status FROM crove_kernel.tenant t WHERE t.org_id = v_org;
  SELECT a.occurred_at INTO exported_at FROM crove_kernel.audit_event a
  WHERE a.org_id = v_org AND a.command = 'kernel.org.export.record' AND a.outcome = 'ok' AND a.actor_type = 'system'
    AND a.detail ->> 'format' = 'crove.org-export.v2'
  ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1;
  refusal := crove_kernel.org_purge_refusal(v_org, 30);
  RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------------
-- The purge
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
    'crove_kernel.tax_profile', 'crove_kernel.usage_deferral', 'crove_kernel.file_upload',
    'crove_kernel.budget_policy', 'crove_kernel.kill_switch', 'crove_kernel.credential',
    'crove_finance.vendor_account_rule'];
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
    'crove_social.short_link', 'crove_social.snippet', 'crove_social.watermark'];
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

-- ---------------------------------------------------------------------------
-- Status guard: the purge's offboarding -> closed move
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER, as before: session_user is the login role, current_user the role running the UPDATE (the owner
-- inside an owner's definer). Same rules as 20261017020100 plus the purge's move.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_status_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_owner oid;
  v_staff boolean;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT c.relowner INTO v_owner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
  SELECT r.rolsuper OR pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) OR (OLD.status = 'active' AND NEW.status = 'offboarding') THEN
    RETURN NEW;
  END IF;
  -- The purge (crove_kernel.org_purge): the worker login, inside a definer of the table owner, in the org's system
  -- context, with the preconditions met at the 30-day floor. Nested, so the checks run in this order (AND does not
  -- promise one) and a role that may not call org_purge_refusal never reaches it.
  IF OLD.status = 'offboarding' AND NEW.status = 'closed'
     AND pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
     AND pg_catalog.pg_has_role(CURRENT_USER, v_owner, 'USAGE') THEN
    IF crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'system' AND crove_kernel.ctx_org_id() IS NOT DISTINCT FROM OLD.org_id THEN
      IF crove_kernel.org_purge_refusal(OLD.org_id, 30) IS NULL THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'TENANT_STATUS_TRANSITION' USING ERRCODE = '42501',
    DETAIL = 'tenant roles only move an org from active to offboarding; the purge closes it';
END $$;

-- Refuses to commit a close by anyone but staff without the kernel.org.purge audit row execute() writes in the same
-- transaction (occurred_at defaults to now(), the transaction start), by the system.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_close_requires_purge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = NEW.org_id
      AND a.command = 'kernel.org.purge'
      AND a.outcome = 'ok'
      AND a.actor_type = 'system'
      AND a.occurred_at = pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'ORG_CLOSE_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tenant_close_requires_purge ON crove_kernel.tenant;
CREATE CONSTRAINT TRIGGER tenant_close_requires_purge
  AFTER UPDATE OF status ON crove_kernel.tenant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status = 'offboarding' AND NEW.status = 'closed')
  EXECUTE FUNCTION crove_kernel.tenant_close_requires_purge();

-- ---------------------------------------------------------------------------
-- Owners: a closed org keeps none
-- ---------------------------------------------------------------------------
-- Same as before (20261016140000) but for a closed org, whose members the purge deletes. CREATE OR REPLACE keeps
-- owner and ACL.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_member_keeps_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Serializes the checks of one org: whoever checks second counts after the first committed.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.tenant_member.owner:' || OLD.org_id::text, 0));
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'closed') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = OLD.org_id AND m.role = 'owner') THEN
    RAISE EXCEPTION 'LAST_OWNER' USING ERRCODE = 'P0001',
      DETAIL = 'an org keeps at least one owner';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- The write fence: the entry points of an org's transactions. Same signatures, contracts and checks as
-- 20261017020100; CREATE OR REPLACE keeps owner and ACL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.enter_context(p_user_id uuid, p_org_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org_id AND t.status = 'offboarding') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('kernel.org.purge:' || p_org_id::text, 0));
  END IF;
  -- A new statement: after waiting on a purge it sees the org closed.
  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id
  WHERE m.org_id = p_org_id AND m.user_id = p_user_id
    AND (t.status = 'active' OR (t.status = 'offboarding' AND m.role = 'owner'));
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'user',
    'user', p_user_id,
    'role', v_role,
    'le_scope', pg_catalog.jsonb_build_array('*'),
    'flags', '[]'::jsonb));
  RETURN v_role;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.enter_system_context(p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SYSTEM_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org_id AND t.status = 'offboarding') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('kernel.org.purge:' || p_org_id::text, 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant WHERE org_id = p_org_id AND status IN ('active', 'offboarding')) THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'system',
    'user', NULL,
    'role', NULL,
    'le_scope', pg_catalog.jsonb_build_array('*'),
    'flags', '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: the purge's two entry points for the worker login only; the rest for nobody.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION crove_kernel.org_purge_refusal(uuid, integer), crove_kernel.tenant_close_requires_purge()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.org_purge_check(text), crove_kernel.org_purge(integer)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.org_purge_check(text), crove_kernel.org_purge(integer) TO crove_worker;
