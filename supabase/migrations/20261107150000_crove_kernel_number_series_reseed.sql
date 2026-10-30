-- SPDX-License-Identifier: AGPL-3.0-only
-- The reseed of a number series after a restore (issue #2007, plan §7.9). Idempotent; applied files stay untouched.
--
-- After a restore, a series may give out numbers the WORM archive already holds: they were allocated after the backup
-- point, and the restored database lacks them. The restore check (apps/kernel/src/restore-report.ts) reads each
-- series' highest archived number from the version 7 batches (20261107140000) and raises the series above it through
-- the command kernel.number.reseed, which calls this definer. Nothing else moves a series: the allocation itself
-- (number_allocate) only ever adds one.
--
-- crove_kernel.number_series_reseed(series id, legal entity, doc type, period key, next number)
--   -> (series id, previous next number or NULL when the series was created, next number)
--   The worker login only (NUMBER_RESEED_WORKER_ONLY, 42501), in the system context of the series' org
--   (NUMBER_RESEED_SYSTEM_CONTEXT, 42501), the org's own legal entity (LEGAL_ENTITY_NOT_ALLOWED, 42501), a period key
--   that fits the reset in force for the doc type, as archive_series_misfits checks it (NUMBER_RESEED_PERIOD_MISFIT,
--   22023), and a next number of 1 or more (NUMBER_INPUT_INVALID, 22023).
--   - A series of that key exists: its next number becomes the greater of its own and the one asked for. It never
--     goes down, so asking again, or for a lower number, changes nothing.
--   - None exists (it was created after the backup point and lost with it): it is created with the archived id when
--     one is given (a new one otherwise) and the number asked for. An id already taken in the org fails (23505).
--   It takes the advisory lock of number_allocate and number_series_policy_set for (org, legal entity, doc type)
--   first, so an allocation or a policy change in flight finishes before it reads the series, then locks the row.
--   The command writes the audit row (system actor), with the series and both numbers. No row of number_allocation,
--   number_void or a voucher is written: the numbers between the restored next number and the new one stay as the
--   archive holds them, lost with the restore and named by its report.
--
-- crove_kernel.number_series_policy_set (20261103050000) refused a reset change once the doc type had allocations. A
-- series the reseed created again has none in the restored database, so its doc type's reset could still be switched
-- before its next number, and a '-' or monthly series would then give out from 1 numbers the archive holds. It now
-- also refuses while any series of the doc type has a next number above 1, which only the reseed leaves without an
-- allocation; every other case is as before. Body otherwise as in 20261103050000.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.number_series_reseed(p_series_id uuid, p_legal_entity_id uuid, p_doc_type text,
                                                            p_period_key text, p_next bigint)
RETURNS TABLE (series_id uuid, previous_next bigint, next_number bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_reset text;
  v_id uuid;
  v_previous bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NUMBER_RESEED_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NUMBER_RESEED_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_legal_entity_id IS NULL OR p_doc_type IS NULL OR p_period_key IS NULL OR p_next IS NULL OR p_next < 1 THEN
    RAISE EXCEPTION 'NUMBER_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = v_org AND e.id = p_legal_entity_id) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'crove_kernel.number_series:' || v_org::text || ':' || p_legal_entity_id::text || ':' || p_doc_type, 0));
  SELECT p.reset INTO v_reset FROM crove_kernel.number_series_policy p
  WHERE p.org_id = v_org AND p.legal_entity_id = p_legal_entity_id AND p.doc_type = p_doc_type;
  IF NOT CASE coalesce(v_reset, 'yearly')
           WHEN 'yearly' THEN p_period_key ~ '^[0-9]{4}$'
           WHEN 'monthly' THEN p_period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
           ELSE p_period_key = '-'
         END THEN
    RAISE EXCEPTION 'NUMBER_RESEED_PERIOD_MISFIT' USING ERRCODE = '22023';
  END IF;

  SELECT s.id, s.next_number INTO v_id, v_previous FROM crove_kernel.number_series s
  WHERE s.org_id = v_org AND s.legal_entity_id = p_legal_entity_id AND s.doc_type = p_doc_type AND s.period_key = p_period_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_previous < p_next THEN
      UPDATE crove_kernel.number_series s SET next_number = p_next WHERE s.org_id = v_org AND s.id = v_id;
    END IF;
    series_id := v_id;
    previous_next := v_previous;
    next_number := greatest(v_previous, p_next);
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO crove_kernel.number_series (org_id, id, legal_entity_id, doc_type, period_key, next_number)
  VALUES (v_org, coalesce(p_series_id, crove_kernel.uuid_v7()), p_legal_entity_id, p_doc_type, p_period_key, p_next)
  RETURNING id INTO v_id;
  series_id := v_id;
  previous_next := NULL;
  next_number := p_next;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.number_series_reseed(uuid, uuid, text, text, bigint) FROM PUBLIC, crove_tenant, crove_app, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.number_series_reseed(uuid, uuid, text, text, bigint) TO crove_worker;

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
    -- A series raised by the reseed after a restore (#2007) holds numbers the archive keeps but the database lacks:
    -- it counts as in use too, though it has no allocation here yet.
    IF EXISTS (
      SELECT 1 FROM crove_kernel.number_series s
      JOIN crove_kernel.number_allocation a ON a.org_id = s.org_id AND a.series_id = s.id
      WHERE s.org_id = v_org AND s.legal_entity_id = v_entity AND s.doc_type = p_doc_type
    ) OR EXISTS (
      SELECT 1 FROM crove_kernel.number_series s
      WHERE s.org_id = v_org AND s.legal_entity_id = v_entity AND s.doc_type = p_doc_type AND s.next_number > 1
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
