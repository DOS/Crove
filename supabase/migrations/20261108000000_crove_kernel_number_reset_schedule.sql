-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #1595, after #1401): a document type's reset can be switched from the first day of a future year.
-- Idempotent; applied files stay untouched.
--
-- number_series_policy_set refuses to change the reset of a document type that has numbers (NUMBER_POLICY_IN_USE):
-- switching it would number a period from 1 again beside the numbers it already holds. Orgs whose vouchers predate
-- #1401 got reset 'never' from the backfill and could never move to a yearly reset. Now a switch can be scheduled:
--
--   number_series_policy.schedule   the switches of the doc type, oldest first: [{"from": "YYYY-01-01", "reset": ...}].
--                                   The reset in force on a date is the one of the latest switch from on or before it,
--                                   else the policy row's reset, else 'yearly' (crove_kernel.number_reset_at). A voucher
--                                   dated before a switch keeps the old reset, so a back-dated voucher continues the
--                                   series of its own year.
--   number_series.last_doc_date     the latest document date the series numbered, kept by number_allocate (NULL for a
--                                   series the reseed created and nothing numbered since). The rows of the #1401
--                                   backfill take their vouchers' dates.
--
-- crove_kernel.number_series_policy_schedule(entity, doc type, reset, from) -> the reset that was in force on that date
--   Owners and admins, in the org's context and entity scope, as number_series_policy_set. `from` is the first day of
--   a year (NUMBER_RESET_FROM_INVALID, 22023) after today in Vietnam (NUMBER_RESET_FROM_PAST, 22023), and no number of
--   the doc type may be dated on or after it (NUMBER_RESET_PERIOD_IN_USE, 55000): no series of a year or month from
--   then on, no '-' series whose last document date is then or later, and no series raised by the reseed whose dates
--   are unknown. A second switch from the same date replaces the first. It takes the advisory lock of number_allocate
--   and number_series_policy_set for (org, legal entity, doc type), so an allocation in flight finishes, and is seen,
--   before it decides; an allocation after it already numbers by the new schedule.
--
-- The reset of a series (crove_kernel.number_series_reset): for a year or month series, the reset in force on the
-- first day of its period (switches fall on 1 January, so a whole period has one reset); for the '-' series, 'never'
-- when the policy row's reset is 'never' or a switch is to 'never', else the policy row's reset. With no switch this is
-- exactly coalesce(policy reset, 'yearly'), so archive_series_hashes (WORM version 5 rows, 20261104140000),
-- archive_series_misfits (20261104190000) and the reseed's period check (20261107150000) give for every existing series
-- what they gave before, and now take a scheduled switch into account. Their bodies are otherwise unchanged;
-- number_period_key and number_allocate follow the schedule and keep last_doc_date.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.number_series_policy ADD COLUMN IF NOT EXISTS schedule jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crove_kernel.number_series_policy DROP CONSTRAINT IF EXISTS number_series_policy_schedule_array;
ALTER TABLE crove_kernel.number_series_policy ADD CONSTRAINT number_series_policy_schedule_array
  CHECK (pg_catalog.jsonb_typeof(schedule) = 'array');
ALTER TABLE crove_kernel.number_series ADD COLUMN IF NOT EXISTS last_doc_date date;

-- The backfilled series (#1401): the latest date of their vouchers; any other allocation, its day in Vietnam.
-- The dates of the vouchers the #1401 backfill numbered, read once to fill the series' last_doc_date.
UPDATE crove_kernel.number_series s
SET last_doc_date = d.last_doc_date
FROM (
  SELECT a.org_id, a.series_id,
         pg_catalog.max(coalesce(c.voucher_date, j.voucher_date, (a.allocated_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)) AS last_doc_date
  FROM crove_kernel.number_allocation a
  LEFT JOIN crove_finance.cash_voucher c ON a.target_type = 'finance.cash_voucher' AND c.org_id = a.org_id AND c.id = a.target_id
  LEFT JOIN crove_finance.journal_voucher j ON a.target_type = 'finance.journal_voucher' AND j.org_id = a.org_id AND j.id = a.target_id
  GROUP BY a.org_id, a.series_id
) d
WHERE s.org_id = d.org_id AND s.id = d.series_id AND s.last_doc_date IS NULL;

-- The reset in force for a doc type on a date (see the header).
CREATE OR REPLACE FUNCTION crove_kernel.number_reset_at(p_org_id uuid, p_legal_entity_id uuid, p_doc_type text, p_date date)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT e.value ->> 'reset'
     FROM crove_kernel.number_series_policy p, pg_catalog.jsonb_array_elements(p.schedule) e
     WHERE p.org_id = p_org_id AND p.legal_entity_id = p_legal_entity_id AND p.doc_type = p_doc_type
       AND (e.value ->> 'from')::date <= p_date
     ORDER BY (e.value ->> 'from')::date DESC
     LIMIT 1),
    (SELECT p.reset FROM crove_kernel.number_series_policy p
     WHERE p.org_id = p_org_id AND p.legal_entity_id = p_legal_entity_id AND p.doc_type = p_doc_type),
    'yearly')
$$;
REVOKE ALL ON FUNCTION crove_kernel.number_reset_at(uuid, uuid, text, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The reset of a series (see the header).
CREATE OR REPLACE FUNCTION crove_kernel.number_series_reset(p_org_id uuid, p_legal_entity_id uuid, p_doc_type text, p_period_key text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN p_period_key ~ '^[0-9]{4}$' THEN crove_kernel.number_reset_at(p_org_id, p_legal_entity_id, p_doc_type, (p_period_key || '-01-01')::date)
    WHEN p_period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN crove_kernel.number_reset_at(p_org_id, p_legal_entity_id, p_doc_type, (p_period_key || '-01')::date)
    ELSE (
      SELECT CASE
        WHEN coalesce(p.reset, 'yearly') = 'never'
             OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p.schedule) e WHERE e.value ->> 'reset' = 'never') THEN 'never'
        ELSE coalesce(p.reset, 'yearly')
      END
      FROM (SELECT 1) one
      LEFT JOIN crove_kernel.number_series_policy p
        ON p.org_id = p_org_id AND p.legal_entity_id = p_legal_entity_id AND p.doc_type = p_doc_type)
  END
$$;
REVOKE ALL ON FUNCTION crove_kernel.number_series_reset(uuid, uuid, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- As in 20261103030000, with the reset in force on the document's date.
CREATE OR REPLACE FUNCTION crove_kernel.number_period_key(p_org_id uuid, p_legal_entity_id uuid, p_doc_type text, p_doc_date date)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE crove_kernel.number_reset_at(p_org_id, p_legal_entity_id, p_doc_type, p_doc_date)
           WHEN 'yearly' THEN pg_catalog.to_char(p_doc_date, 'YYYY')
           WHEN 'monthly' THEN pg_catalog.to_char(p_doc_date, 'YYYY-MM')
           ELSE '-'
         END
$$;
REVOKE ALL ON FUNCTION crove_kernel.number_period_key(uuid, uuid, text, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- As in 20261103050000, keeping the series' last document date.
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
  INSERT INTO crove_kernel.number_series AS s (org_id, legal_entity_id, doc_type, period_key, next_number, last_doc_date)
  VALUES (p_org_id, p_legal_entity_id, p_doc_type, v_period, 2, p_doc_date)
  ON CONFLICT (org_id, legal_entity_id, doc_type, period_key)
  DO UPDATE SET next_number = s.next_number + 1, last_doc_date = pg_catalog.greatest(s.last_doc_date, EXCLUDED.last_doc_date)
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

CREATE OR REPLACE FUNCTION crove_kernel.number_series_policy_schedule(p_legal_entity_id uuid, p_doc_type text, p_reset text, p_from date)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_entity uuid;
  v_previous text;
  v_schedule jsonb;
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
  IF p_from IS NULL OR pg_catalog.date_part('month', p_from) <> 1 OR pg_catalog.date_part('day', p_from) <> 1 THEN
    RAISE EXCEPTION 'NUMBER_RESET_FROM_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_from <= (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'NUMBER_RESET_FROM_PAST' USING ERRCODE = '22023';
  END IF;
  v_entity := coalesce(p_legal_entity_id, crove_kernel.org_default_legal_entity(v_org));
  IF v_entity IS NULL OR NOT crove_kernel.ctx_le_allowed(v_entity)
     OR NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = v_org AND e.id = v_entity) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  -- One at a time per (org, legal entity, doc type), with number_allocate and number_series_policy_set.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'crove_kernel.number_series:' || v_org::text || ':' || v_entity::text || ':' || p_doc_type, 0));
  PERFORM 1 FROM crove_kernel.number_series_policy p
  WHERE p.org_id = v_org AND p.legal_entity_id = v_entity AND p.doc_type = p_doc_type FOR UPDATE;
  PERFORM 1 FROM crove_kernel.number_series s
  WHERE s.org_id = v_org AND s.legal_entity_id = v_entity AND s.doc_type = p_doc_type FOR UPDATE;
  -- Never for a period that already has numbers: a series of that year or later, a '-' series that numbered a document
  -- dated then or later, or a series the reseed raised, whose dates are not known.
  IF EXISTS (
    SELECT 1 FROM crove_kernel.number_series s
    WHERE s.org_id = v_org AND s.legal_entity_id = v_entity AND s.doc_type = p_doc_type
      AND ((s.period_key <> '-' AND pg_catalog.left(s.period_key, 4) >= pg_catalog.to_char(p_from, 'YYYY'))
           OR s.last_doc_date >= p_from
           OR (s.last_doc_date IS NULL AND s.next_number > 1))
  ) THEN
    RAISE EXCEPTION 'NUMBER_RESET_PERIOD_IN_USE' USING ERRCODE = '55000';
  END IF;
  v_previous := crove_kernel.number_reset_at(v_org, v_entity, p_doc_type, p_from);
  SELECT coalesce(pg_catalog.jsonb_agg(e.value ORDER BY (e.value ->> 'from')::date), '[]'::jsonb) INTO v_schedule
  FROM (
    SELECT e.value
    FROM crove_kernel.number_series_policy p, pg_catalog.jsonb_array_elements(p.schedule) e
    WHERE p.org_id = v_org AND p.legal_entity_id = v_entity AND p.doc_type = p_doc_type
      AND (e.value ->> 'from')::date <> p_from
    UNION ALL
    SELECT pg_catalog.jsonb_build_object('from', pg_catalog.to_char(p_from, 'YYYY-MM-DD'), 'reset', p_reset)
  ) e;
  INSERT INTO crove_kernel.number_series_policy AS p (org_id, legal_entity_id, doc_type, reset, schedule, updated_by)
  VALUES (v_org, v_entity, p_doc_type, 'yearly', v_schedule, crove_kernel.ctx_user_id())
  ON CONFLICT (org_id, legal_entity_id, doc_type)
  DO UPDATE SET schedule = EXCLUDED.schedule, updated_by = EXCLUDED.updated_by, updated_at = pg_catalog.now();
  RETURN v_previous;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.number_series_policy_schedule(uuid, text, text, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.number_series_policy_schedule(uuid, text, text, date) TO crove_tenant;

-- As in 20261104140000, with the reset of the series (number_series_reset).
CREATE OR REPLACE FUNCTION crove_kernel.archive_series_hashes(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ref text, row_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'number_series:' || s.org_id::text || ':' || s.id::text,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'org_id', s.org_id, 'id', s.id, 'legal_entity_id', s.legal_entity_id, 'doc_type', s.doc_type,
           'period_key', s.period_key, 'reset', crove_kernel.number_series_reset(s.org_id, s.legal_entity_id, s.doc_type, s.period_key),
           'created_at', crove_kernel.archive_ts(s.created_at))::text, 'UTF8')), 'hex')
  FROM crove_kernel.number_series s
  WHERE s.created_at >= p_from AND s.created_at < p_to;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_series_hashes(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_series_hashes(timestamptz, timestamptz) TO crove_worker;

-- As in 20261104190000, with the reset of the series (number_series_reset).
CREATE OR REPLACE FUNCTION crove_kernel.archive_series_misfits()
RETURNS TABLE (ref text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT 'number_series:' || s.org_id::text || ':' || s.id::text
  FROM crove_kernel.number_series s
  WHERE NOT CASE crove_kernel.number_series_reset(s.org_id, s.legal_entity_id, s.doc_type, s.period_key)
              WHEN 'yearly' THEN s.period_key ~ '^[0-9]{4}$'
              WHEN 'monthly' THEN s.period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
              ELSE s.period_key = '-'
            END
  ORDER BY 1;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_series_misfits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_series_misfits() TO crove_worker;

-- As in 20261107150000, with the reset of the series (number_series_reset) in the period check.
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
  -- The reset of a series of that key, a scheduled switch included (#1595).
  v_reset := crove_kernel.number_series_reset(v_org, p_legal_entity_id, p_doc_type, p_period_key);
  -- In parentheses: PL/pgSQL ends an IF condition at its first THEN.
  IF NOT (CASE v_reset
            WHEN 'yearly' THEN p_period_key ~ '^[0-9]{4}$'
            WHEN 'monthly' THEN p_period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
            ELSE p_period_key = '-'
          END) THEN
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
