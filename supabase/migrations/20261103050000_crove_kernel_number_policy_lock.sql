-- Crove kernel (issue #1607, after #1401): a policy change and the first allocation of a document type no longer race.
-- Idempotent; applied files stay untouched.
--
-- number_series_policy_set refuses a reset change once the document type has allocations, after locking its series
-- rows (20261103030000). The very first allocation of a document type creates its series row; until that commits, a
-- concurrent policy change saw no row and no allocation, so both could commit: PT 1 under 'yearly' (period 2026),
-- then the policy 'never', and the next voucher PT 1 again in the '-' series of the same year. Both functions now take
-- one transaction advisory lock per (org, legal entity, doc type) before they read the policy, so they serialize: the
-- policy change waits for the allocation's transaction and then refuses the change. Bodies otherwise as in
-- 20261103030000.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.number_allocate(p_org_id uuid, p_legal_entity_id uuid, p_doc_type text, p_doc_date date,
                                                        p_target_type text, p_target_id uuid)
RETURNS TABLE (period_key text, number bigint, allocation_id uuid)
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_period text;
  v_series uuid;
  v_number bigint;
  v_allocation uuid;
BEGIN
  IF p_org_id IS NULL OR p_legal_entity_id IS NULL OR p_doc_type IS NULL OR p_doc_date IS NULL
     OR p_target_type IS NULL OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'NUMBER_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- One at a time per (org, legal entity, doc type), with number_series_policy_set: a policy change waits for an
  -- allocation in flight, the series' first included, and then sees it (#1607).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'crove_kernel.number_series:' || p_org_id::text || ':' || p_legal_entity_id::text || ':' || p_doc_type, 0));
  v_period := crove_kernel.number_period_key(p_org_id, p_legal_entity_id, p_doc_type, p_doc_date);
  INSERT INTO crove_kernel.number_series AS s (org_id, legal_entity_id, doc_type, period_key, next_number)
  VALUES (p_org_id, p_legal_entity_id, p_doc_type, v_period, 2)
  ON CONFLICT (org_id, legal_entity_id, doc_type, period_key) DO UPDATE SET next_number = s.next_number + 1
  RETURNING s.id, s.next_number - 1 INTO v_series, v_number;
  INSERT INTO crove_kernel.number_allocation (org_id, series_id, number, target_type, target_id, allocated_by)
  VALUES (p_org_id, v_series, v_number, p_target_type, p_target_id, crove_kernel.ctx_user_id())
  RETURNING id INTO v_allocation;
  period_key := v_period;
  number := v_number;
  allocation_id := v_allocation;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.number_allocate(uuid, uuid, text, date, text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.number_series_policy_set(p_legal_entity_id uuid, p_doc_type text, p_reset text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_entity uuid;
  v_previous text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.assert_number_admin();
  IF p_reset IS NULL OR p_reset NOT IN ('yearly', 'monthly', 'never') THEN
    RAISE EXCEPTION 'NUMBER_RESET_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_doc_type IS NULL OR p_doc_type !~ '^[a-z][a-z0-9_.]*$' OR pg_catalog.char_length(p_doc_type) > 100 THEN
    RAISE EXCEPTION 'NUMBER_DOC_TYPE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_entity := coalesce(p_legal_entity_id, crove_kernel.org_default_legal_entity(v_org));
  IF v_entity IS NULL OR NOT crove_kernel.ctx_le_allowed(v_entity)
     OR NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = v_org AND e.id = v_entity) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  -- One at a time per (org, legal entity, doc type), with number_series_policy_set: this change waits for an allocation in
  -- flight, the series' first included, and then sees it (#1607).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'crove_kernel.number_series:' || v_org::text || ':' || v_entity::text || ':' || p_doc_type, 0));
  SELECT p.reset INTO v_previous FROM crove_kernel.number_series_policy p
  WHERE p.org_id = v_org AND p.legal_entity_id = v_entity AND p.doc_type = p_doc_type FOR UPDATE;
  -- Once the document type has numbers, its reset stays (review of #1573): switching it would number a period again
  -- from 1 beside the numbers it already holds (never to yearly mid-year, or yearly to monthly). The series rows are
  -- locked first, so an allocation in flight finishes, and is seen, before this decides.
  IF p_reset IS DISTINCT FROM coalesce(v_previous, 'yearly') THEN
    PERFORM 1 FROM crove_kernel.number_series s
    WHERE s.org_id = v_org AND s.legal_entity_id = v_entity AND s.doc_type = p_doc_type FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM crove_kernel.number_series s
      JOIN crove_kernel.number_allocation a ON a.org_id = s.org_id AND a.series_id = s.id
      WHERE s.org_id = v_org AND s.legal_entity_id = v_entity AND s.doc_type = p_doc_type
    ) THEN
      RAISE EXCEPTION 'NUMBER_POLICY_IN_USE' USING ERRCODE = '55000';
    END IF;
  END IF;
  INSERT INTO crove_kernel.number_series_policy AS p (org_id, legal_entity_id, doc_type, reset, updated_by)
  VALUES (v_org, v_entity, p_doc_type, p_reset, crove_kernel.ctx_user_id())
  ON CONFLICT (org_id, legal_entity_id, doc_type)
  DO UPDATE SET reset = EXCLUDED.reset, updated_by = EXCLUDED.updated_by, updated_at = pg_catalog.now();
  RETURN coalesce(v_previous, 'yearly');
END $$;
REVOKE ALL ON FUNCTION crove_kernel.number_series_policy_set(uuid, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.number_series_policy_set(uuid, text, text) TO crove_tenant;
