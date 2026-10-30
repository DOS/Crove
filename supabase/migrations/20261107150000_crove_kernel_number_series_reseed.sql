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
