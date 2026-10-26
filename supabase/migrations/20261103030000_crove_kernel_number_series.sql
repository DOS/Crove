-- Crove kernel (issue #1401, step 2; ADR-0021 sections 2 and 7, plan §13 Phase 2a): gapless numbering as a kernel
-- service, and the cash and journal vouchers (PT, PC, BC, BN, NVK) moved onto it. Idempotent; applied files stay
-- untouched.
--
-- Tables (tenant conventions: PRIMARY KEY (org_id, id), row security by org through crove_kernel.apply_tenant_rls, a
-- RESTRICTIVE le_scope policy on legal_entity_id as on tax_obligation_done, the agent write guard). Tenant roles only
-- read them; the definers below are their only writers.
--   number_series         one counter per (org, legal entity, doc type, period key). period_key is 'YYYY' (yearly
--                         reset, the default), 'YYYY-MM' (monthly) or '-' (never resets), from the document date and
--                         the series policy. next_number is the number the next allocation takes.
--   number_allocation     append-only: one row per number given out, with the record it went to (target_type,
--                         target_id, as audit_event names a record). UNIQUE (org, series, number) and UNIQUE (org,
--                         target_type, target_id): one number per record. legal_entity_id is the series' (trigger
--                         b_legal_entity, from the parent), so le_scope applies to it too.
--   number_void           append-only: a number declared void (reason required, actor, time). At most one per
--                         allocation (a second void fails 23505); voiding a number never allocated is refused (23503).
--                         legal_entity_id is the allocation's.
--   number_series_policy  the reset policy of a doc type in a legal entity: 'yearly', 'monthly' or 'never'. No row
--                         means 'yearly'.
--
-- Functions:
--   crove_kernel.number_allocate(org, entity, doc type, date, target type, target id)
--       The allocation itself, for the definers and the voucher triggers below; executable by no runtime role. One
--       statement takes the number: INSERT ... ON CONFLICT DO UPDATE SET next_number = next_number + 1 RETURNING
--       next_number - 1 (ADR-0021 section 2). It runs in the caller's transaction, so the counter row stays locked
--       until that transaction ends: a commit keeps the number, a rollback gives it back, and the series row is created
--       on first use without a race. Then the allocation row.
--   crove_kernel.allocate_number(entity, doc type, date, target type, target id) -> (period_key, number, allocation_id)
--       ctx.numbering.allocate. SECURITY DEFINER for crove_tenant: the org is the sealed context's, the entity (NULL:
--       the org's default) must be the org's and within the context's le_scope (LEGAL_ENTITY_NOT_ALLOWED, 42501). The
--       series the voucher triggers own (finance.cash_voucher.*, finance.journal_voucher), and their target types, are
--       refused (NUMBER_SERIES_RESERVED, 42501): a number of them only ever goes to its voucher, and no other number
--       can take a voucher's place in number_allocation_target_uq. allocation_id is returned
--       beside the ADR's (period_key, number) so a caller can void the number later and name it in its own row.
--   crove_kernel.void_number(allocation, reason) -> void id
--       ctx.numbering.void, behind the R2 command kernel.number.void. Owners and admins only (NUMBER_FORBIDDEN, 42501):
--       no role permission fits yet. Writes number_void; nothing is deleted and no number is reused.
--   crove_kernel.number_series_policy_set(entity, doc type, reset) -> previous reset
--       Owners and admins set the reset policy of a doc type in an entity before its first number. Once the doc type
--       has numbers its reset stays (NUMBER_POLICY_IN_USE, 55000): a switch would number a period again from 1 beside
--       the numbers it holds. Restating the reset in force is accepted.
--
-- The vouchers. crove_finance.cash_voucher and journal_voucher gain number_period (the series' period key; default '-')
-- and number_allocation_id, a foreign key to the allocation of their number (nullable only for rows written with
-- triggers off, in replica mode, which the insert trigger never numbers). The BEFORE INSERT triggers that numbered them
-- by max() + 1 under an advisory lock now take the number from number_allocate: doc types
-- finance.cash_voucher.<voucher_type> (PT, PC, BC, BN) and finance.journal_voucher (NVK), target types
-- finance.cash_voucher and finance.journal_voucher. The entity trigger b_legal_entity still fires first (triggers fire
-- by name). The triggers become SECURITY DEFINER, since the writer has no access to number_allocate; they number only a
-- row of the context's org and of an entity within its le_scope, and leave any other row to row security, which refuses
-- it after them, so a refused insert never takes or locks a number. The unique keys gain number_period:
-- cash_voucher_number_uq (org, entity, voucher_type, number_period, number) and journal_voucher_number_uq (org, entity,
-- number_period, number): with a yearly reset, PT 1 of 2027 and PT 1 of 2026 are two vouchers.
--
-- Existing data: no voucher is renumbered (decision for #1401). An issued voucher's number is on paper and in the
-- books, and renumbering it would break both. For every (org, legal entity, doc type) that already has vouchers, the
-- backfill writes a number_series_policy row with reset 'never', a '-' series whose next_number is the highest
-- existing number + 1, and one number_allocation row per existing voucher (allocated_by and allocated_at are the
-- voucher's created_by and created_at). Those series simply continue: PT 41 follows PT 40, and keep reset 'never' (a
-- doc type with numbers keeps its reset; a dated switch is a follow-up). Orgs and entities without vouchers get the
-- default, yearly reset. The vouchers' new columns are filled without an UPDATE (they are append-only): number_period
-- through its column default '-', number_allocation_id through ALTER COLUMN ... TYPE uuid USING (...), a rewrite that
-- fires no row trigger, as in 20261102180000. lock_timeout bounds the wait for the tables' locks.
--
-- Not in this step: allocations and voids in the WORM fact stream (ADR-0021 decision 4), a follow-up.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.number_series (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- Filled by b_legal_entity: the entity the writer names, or the org's default entity.
  legal_entity_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type ~ '^[a-z][a-z0-9_.]*$' AND pg_catalog.char_length(doc_type) <= 100),
  period_key text NOT NULL CHECK (period_key ~ '^([0-9]{4}|[0-9]{4}-(0[1-9]|1[0-2])|-)$'),
  next_number bigint NOT NULL CHECK (next_number >= 1),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT number_series_legal_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  -- The conflict target of number_allocate; also the legal entity key's index (G3 fk-index).
  CONSTRAINT number_series_uq UNIQUE (org_id, legal_entity_id, doc_type, period_key)
);

CREATE TABLE IF NOT EXISTS crove_kernel.number_allocation (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  series_id uuid NOT NULL,
  -- The series' entity (b_legal_entity, from series_id).
  legal_entity_id uuid NOT NULL,
  number bigint NOT NULL CHECK (number >= 1),
  -- The record the number went to, as audit_event names a record.
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_.]*$' AND pg_catalog.char_length(target_type) <= 100),
  target_id uuid NOT NULL,
  allocated_by uuid,
  allocated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT number_allocation_series_fk FOREIGN KEY (org_id, series_id) REFERENCES crove_kernel.number_series (org_id, id),
  -- Gapless and unique within a series; also the series key's index (G3 fk-index).
  CONSTRAINT number_allocation_number_uq UNIQUE (org_id, series_id, number),
  -- One number per record.
  CONSTRAINT number_allocation_target_uq UNIQUE (org_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS crove_kernel.number_void (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  allocation_id uuid NOT NULL,
  -- The allocation's entity (b_legal_entity, from allocation_id).
  legal_entity_id uuid NOT NULL,
  reason text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500),
  voided_by uuid,
  voided_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT number_void_allocation_fk FOREIGN KEY (org_id, allocation_id) REFERENCES crove_kernel.number_allocation (org_id, id),
  -- One void per number; also the allocation key's index (G3 fk-index).
  CONSTRAINT number_void_allocation_uq UNIQUE (org_id, allocation_id)
);

CREATE TABLE IF NOT EXISTS crove_kernel.number_series_policy (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- Filled by b_legal_entity: the entity the writer names, or the org's default entity.
  legal_entity_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type ~ '^[a-z][a-z0-9_.]*$' AND pg_catalog.char_length(doc_type) <= 100),
  reset text NOT NULL CHECK (reset IN ('yearly', 'monthly', 'never')),
  -- NULL for the rows the migration wrote (see the header).
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT number_series_policy_legal_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  -- One policy per doc type and entity; also the legal entity key's index (G3 fk-index).
  CONSTRAINT number_series_policy_uq UNIQUE (org_id, legal_entity_id, doc_type)
);

-- Row security by org; read only for tenant roles (the definers below write).
SELECT crove_kernel.apply_tenant_rls('crove_kernel.number_series');
SELECT crove_kernel.apply_tenant_rls('crove_kernel.number_series_policy');
SELECT crove_kernel.apply_tenant_rls('crove_kernel.number_allocation', true);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.number_void', true);
REVOKE INSERT, UPDATE, DELETE ON crove_kernel.number_series, crove_kernel.number_series_policy,
  crove_kernel.number_allocation, crove_kernel.number_void FROM crove_tenant;
SELECT crove_kernel.make_append_only('crove_kernel.number_allocation');
SELECT crove_kernel.make_append_only('crove_kernel.number_void');

-- The entity of each row (crove_kernel.legal_entity_fill, 20261102180000): named or the org's default for a series and
-- a policy; the parent's for an allocation and a void. It never changes once written. Also in replica mode.
DROP TRIGGER IF EXISTS b_legal_entity ON crove_kernel.number_series;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_kernel.number_series
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_fill();
ALTER TABLE crove_kernel.number_series ENABLE ALWAYS TRIGGER b_legal_entity;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_kernel.number_series_policy;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_kernel.number_series_policy
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_fill();
ALTER TABLE crove_kernel.number_series_policy ENABLE ALWAYS TRIGGER b_legal_entity;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_kernel.number_allocation;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, series_id ON crove_kernel.number_allocation
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_fill('crove_kernel.number_series', 'series_id');
ALTER TABLE crove_kernel.number_allocation ENABLE ALWAYS TRIGGER b_legal_entity;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_kernel.number_void;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, allocation_id ON crove_kernel.number_void
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_fill('crove_kernel.number_allocation', 'allocation_id');
ALTER TABLE crove_kernel.number_void ENABLE ALWAYS TRIGGER b_legal_entity;

-- The legal-entity scope of the sealed context (plan §4.6), RESTRICTIVE beside the tenant policy, as on
-- tax_obligation_done.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['crove_kernel.number_series', 'crove_kernel.number_series_policy',
                                 'crove_kernel.number_allocation', 'crove_kernel.number_void'] LOOP
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS le_scope ON %s', v_table);
    EXECUTE pg_catalog.format(
      'CREATE POLICY le_scope ON %s AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
      'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))',
      v_table);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Allocation
-- ---------------------------------------------------------------------------
-- The period key of a document date under the policy of (org, entity, doc type): 'YYYY' by default.
CREATE OR REPLACE FUNCTION crove_kernel.number_period_key(p_org_id uuid, p_legal_entity_id uuid, p_doc_type text, p_doc_date date)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE coalesce((SELECT p.reset FROM crove_kernel.number_series_policy p
                        WHERE p.org_id = p_org_id AND p.legal_entity_id = p_legal_entity_id AND p.doc_type = p_doc_type), 'yearly')
           WHEN 'yearly' THEN pg_catalog.to_char(p_doc_date, 'YYYY')
           WHEN 'monthly' THEN pg_catalog.to_char(p_doc_date, 'YYYY-MM')
           ELSE '-'
         END
$$;
REVOKE ALL ON FUNCTION crove_kernel.number_period_key(uuid, uuid, text, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Takes the next number of the series and records it (see the header). SECURITY INVOKER and executable by no runtime
-- role: only the definers and the voucher triggers below call it, as their owner, which owns the tables.
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

-- ctx.numbering.allocate (see the header). Called inside the posting transaction, as the last step before the
-- document's insert, so the counter row is locked as briefly as possible.
CREATE OR REPLACE FUNCTION crove_kernel.allocate_number(p_legal_entity_id uuid, p_doc_type text, p_doc_date date,
                                                        p_target_type text, p_target_id uuid)
RETURNS TABLE (period_key text, number bigint, allocation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_entity uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_doc_type = 'finance.journal_voucher' OR pg_catalog.starts_with(p_doc_type, 'finance.cash_voucher.')
     OR p_target_type IN ('finance.cash_voucher', 'finance.journal_voucher') THEN
    RAISE EXCEPTION 'NUMBER_SERIES_RESERVED' USING ERRCODE = '42501';
  END IF;
  v_entity := coalesce(p_legal_entity_id, crove_kernel.org_default_legal_entity(v_org));
  IF v_entity IS NULL OR NOT crove_kernel.ctx_le_allowed(v_entity)
     OR NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = v_org AND e.id = v_entity) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT a.period_key, a.number, a.allocation_id
    FROM crove_kernel.number_allocate(v_org, v_entity, p_doc_type, p_doc_date, p_target_type, p_target_id) a;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.allocate_number(uuid, text, date, text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.allocate_number(uuid, text, date, text, uuid) TO crove_tenant;

-- Raises NUMBER_FORBIDDEN (42501) unless the sealed context is a user who is an owner or admin of the org in context.
-- The commands check the same first; this keeps a raw call, a member, or a system or agent context out. Called only
-- from the definers below, so it runs as their owner.
CREATE OR REPLACE FUNCTION crove_kernel.assert_number_admin() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'NUMBER_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.assert_number_admin() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ctx.numbering.void: declares the number of allocation p_allocation_id of the org in context void. Refusals:
-- NUMBER_FORBIDDEN (42501), NUMBER_ALLOCATION_NOT_FOUND (23503: never allocated in this org, or in an entity outside
-- the context's le_scope), NUMBER_VOID_REASON (22023: a blank reason or one over 500 characters), and 23505 on
-- number_void_allocation_uq when the number is already void.
CREATE OR REPLACE FUNCTION crove_kernel.void_number(p_allocation_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_entity uuid;
  v_target text;
  v_reason text := pg_catalog.btrim(p_reason);
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.assert_number_admin();
  SELECT a.legal_entity_id, a.target_type INTO v_entity, v_target FROM crove_kernel.number_allocation a WHERE a.org_id = v_org AND a.id = p_allocation_id;
  IF v_entity IS NULL OR NOT crove_kernel.ctx_le_allowed(v_entity) THEN
    RAISE EXCEPTION 'NUMBER_ALLOCATION_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  -- A voucher keeps its number for good: it is reversed, never voided by number (review of #1573).
  IF v_target IN ('finance.cash_voucher', 'finance.journal_voucher') THEN
    RAISE EXCEPTION 'NUMBER_SERIES_RESERVED' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR pg_catalog.char_length(v_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'NUMBER_VOID_REASON' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_kernel.number_void (org_id, allocation_id, reason, voided_by)
  VALUES (v_org, p_allocation_id, v_reason, crove_kernel.ctx_user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.void_number(uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.void_number(uuid, text) TO crove_tenant;

-- Sets the reset policy of p_doc_type in entity p_legal_entity_id (NULL: the org's default) and answers the previous one
-- ('yearly' when there was no row). Refusals: NUMBER_FORBIDDEN, LEGAL_ENTITY_NOT_ALLOWED (42501), and
-- NUMBER_RESET_INVALID or NUMBER_DOC_TYPE_INVALID (22023).
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
