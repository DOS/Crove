-- Crove kernel (issue #1278, plan §4.6 and the v0 table list): legal entities, one default per org. Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.legal_entity  the companies, branches and household businesses an org keeps books for: name, kind,
--                            tax code (MST, unique in the org when present) and parent (a branch under its company).
--                            Every org has exactly one default entity: create_or_replay_org creates it with the org,
--                            and this file backfills it for every existing org from the tenant row, its tax code
--                            included, as 20261019150000_crove_kernel_org_tax_code.sql promised. The default stays the
--                            default: is_default is not updatable and no role deletes an entity (the books will
--                            reference them, ADR-0021), so the partial unique index keeps it the only one.
--
-- The org's tax code stays on crove_kernel.tenant too: Finance reads it there (sale or purchase, #313) and locks the
-- tenant row while it posts, and only kernel.org.set_tax_code changes it (tenant_tax_code_guard, #430). The default
-- entity's tax code is the org's: kernel.org.set_tax_code writes it after the tenant row, kernel.legal_entity.update
-- refuses to change it, and legal_entity_default_tax_code refuses any write of a default entity whose tax code is not
-- the tenant's (staff included, so the backfill below copies the tenant's code).
--
-- Access: owners and admins create, change and list entities through audited commands (kernel.legal_entity.*).
-- Tenant roles may insert and update the editable columns only (no DELETE, no UPDATE of org_id, id, is_default or
-- the creation stamps). Beside the tenant policy, a RESTRICTIVE policy limits every actor to the entities its sealed
-- context's le_scope names (plan §4.6): '*' (every user and system context today) sees them all, an agent sees only
-- its position's scope, and a missing scope sees none.
--
-- A parent is an entity of the same org (composite foreign key), never the entity itself, and never forms a cycle: a
-- trigger walks up the parents under a per-org advisory lock, as position_no_cycle does for the org chart.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.legal_entity (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The same bounds as the org's name, so the backfill from it always fits.
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- company: an enterprise or other organization (10-digit tax code); branch: a branch or other dependent unit (its
  -- code is the company's with a 3-digit suffix); household: a household or individual business (12-digit code, the
  -- owner's personal identification number). The kind is what the owner says; it is not derived from the code.
  kind text NOT NULL DEFAULT 'company' CHECK (kind IN ('company', 'branch', 'household')),
  -- The normalized form of @crove/kernel-contract normalizeTaxCode, as on the tenant row.
  tax_code text CHECK (tax_code IS NULL OR tax_code ~ '^([0-9]{10}(-[0-9]{3})?|[0-9]{12})$'),
  parent_id uuid,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT legal_entity_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT legal_entity_parent_fk FOREIGN KEY (org_id, parent_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);
-- A tax code names one entity of the org. Another org may hold the same code (an accounting firm keeps a client's
-- books in its own org), so the uniqueness is per org and says nothing across orgs.
CREATE UNIQUE INDEX IF NOT EXISTS legal_entity_tax_code_uq ON crove_kernel.legal_entity (org_id, tax_code) WHERE tax_code IS NOT NULL;
-- At most one default per org.
CREATE UNIQUE INDEX IF NOT EXISTS legal_entity_default_uq ON crove_kernel.legal_entity (org_id) WHERE is_default;
-- The parent key's index (G3 fk-index), also used by the cycle walk.
CREATE INDEX IF NOT EXISTS legal_entity_parent_idx ON crove_kernel.legal_entity (org_id, parent_id) WHERE parent_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_kernel.legal_entity');
-- No delete, and only the editable columns change.
REVOKE DELETE, UPDATE ON crove_kernel.legal_entity FROM crove_tenant;
GRANT UPDATE (name, kind, tax_code, parent_id, updated_by, updated_at) ON crove_kernel.legal_entity TO crove_tenant;

-- The legal-entity scope of the sealed context (plan §4.6), RESTRICTIVE so it narrows the tenant policy and never
-- widens it. The scope is fetched once per statement (an InitPlan), not per row.
DROP POLICY IF EXISTS legal_entity_scope ON crove_kernel.legal_entity;
CREATE POLICY legal_entity_scope ON crove_kernel.legal_entity AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- No parent cycle. Runs as the definer owner so the walk sees every entity of the org whatever the writer's scope,
-- and under a per-org advisory lock, so two concurrent changes check one after the other: the second walk is a new
-- statement and, at READ COMMITTED (every Crove transaction), sees what the first committed. Other isolation levels
-- would walk an old snapshot, so parent changes there are refused.
CREATE OR REPLACE FUNCTION crove_kernel.legal_entity_no_cycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_TREE_ISOLATION' USING ERRCODE = '25001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.legal_entity.tree:' || NEW.org_id::text, 0));
  IF NEW.parent_id = NEW.id OR EXISTS (
    WITH RECURSIVE up (id) AS (
      SELECT NEW.parent_id
      UNION
      SELECT e.parent_id FROM crove_kernel.legal_entity e JOIN up ON e.org_id = NEW.org_id AND e.id = up.id
      WHERE e.parent_id IS NOT NULL
    )
    SELECT 1 FROM up WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_CYCLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.legal_entity_no_cycle() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS legal_entity_no_cycle ON crove_kernel.legal_entity;
CREATE TRIGGER legal_entity_no_cycle BEFORE INSERT OR UPDATE OF parent_id ON crove_kernel.legal_entity
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_no_cycle();

-- The default entity's tax code is the org's (above). Checked on every write of a default row against the tenant row
-- as the transaction sees it, so kernel.org.set_tax_code, which updates the tenant row first, passes. Runs as the
-- definer owner, so it reads the tenant row whatever the writer's role.
CREATE OR REPLACE FUNCTION crove_kernel.legal_entity_default_tax_code() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.is_default AND NEW.tax_code IS DISTINCT FROM (SELECT t.tax_code FROM crove_kernel.tenant t WHERE t.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_DEFAULT_TAX_CODE' USING ERRCODE = '23514',
      DETAIL = 'the default legal entity has the org''s tax code; kernel.org.set_tax_code changes both';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.legal_entity_default_tax_code() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS legal_entity_default_tax_code ON crove_kernel.legal_entity;
CREATE TRIGGER legal_entity_default_tax_code BEFORE INSERT OR UPDATE OF tax_code, is_default ON crove_kernel.legal_entity
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_default_tax_code();

-- The backfill: one default entity per existing org, named as the org, with its tax code. An org that already has a
-- default (a second run of this file) is skipped. Nothing on the tenant row changes.
INSERT INTO crove_kernel.legal_entity (org_id, name, tax_code, is_default, created_by, created_at, updated_at)
SELECT t.org_id, t.name, t.tax_code, true, t.created_by, t.created_at, t.created_at
FROM crove_kernel.tenant t
WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = t.org_id AND e.is_default);

-- Org creation now creates the default entity with the org. Copied verbatim from
-- 20261015140000_crove_kernel_org_create_rate_limit.sql (signature, owner, grants and settings unchanged), with only
-- the legal_entity insert added after the owner membership.
CREATE OR REPLACE FUNCTION crove_kernel.create_or_replay_org(p_user_id uuid, p_slug text, p_name text, p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_slug text := p_slug;
  v_per_day_raw text := NULLIF(pg_catalog.current_setting('crove.org_create_limit_per_day', true), '');
  v_total_raw text := NULLIF(pg_catalog.current_setting('crove.org_create_limit_total', true), '');
  v_per_day integer;
  v_total integer;
  v_recent integer;
  v_all integer;
  v_oldest timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
BEGIN
  IF (v_per_day_raw IS NOT NULL AND v_per_day_raw !~ '^[1-9][0-9]{0,5}$')
     OR (v_total_raw IS NOT NULL AND v_total_raw !~ '^[1-9][0-9]{0,5}$') THEN
    RAISE EXCEPTION 'ORG_CREATE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_per_day := COALESCE(v_per_day_raw::integer, 5);
  v_total := COALESCE(v_total_raw::integer, 20);

  -- One lock per user, taken before the replay lookup and the count, held until the transaction ends.
  -- A transaction-level advisory lock taken in this block's subtransaction stays held after it commits.
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.org.create:' || p_user_id::text, 0));
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'ORG_CREATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'org_create_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
  IF p_idempotency_key IS NOT NULL THEN
    SELECT k.org_id INTO v_org
    FROM crove_kernel.idempotency_key k
    WHERE k.actor_key = 'user:' || p_user_id::text AND k.key = p_idempotency_key AND k.command = 'kernel.org.create';
    IF v_org IS NOT NULL THEN
      RETURN v_org;
    END IF;
  END IF;

  SELECT pg_catalog.count(*)::integer,
         (pg_catalog.count(*) FILTER (WHERE t.created_at > pg_catalog.now() - interval '24 hours'))::integer,
         pg_catalog.min(t.created_at) FILTER (WHERE t.created_at > pg_catalog.now() - interval '24 hours')
    INTO v_all, v_recent, v_oldest
  FROM crove_kernel.tenant t
  WHERE t.created_by = p_user_id;
  IF v_all >= v_total THEN
    RAISE EXCEPTION 'ORG_CREATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'org_create_total', 'limit', v_total)::text;
  END IF;
  IF v_recent >= v_per_day THEN
    RAISE EXCEPTION 'ORG_CREATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object(
        'rule', 'org_create_per_day',
        'limit', v_per_day,
        'retryAfterSeconds', GREATEST(1, pg_catalog.ceil(
          pg_catalog.date_part('epoch', v_oldest + interval '24 hours' - pg_catalog.now())))::integer)::text;
  END IF;

  FOR attempt IN 1..5 LOOP
    INSERT INTO crove_kernel.tenant (slug, name, created_by) VALUES (v_slug, p_name, p_user_id)
    ON CONFLICT (slug) DO NOTHING
    RETURNING org_id INTO v_org;
    EXIT WHEN v_org IS NOT NULL;
    v_slug := pg_catalog.left(p_slug, 40) || '-' || pg_catalog.left(crove_kernel.random_token(), 4);
  END LOOP;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ORG_SLUG_TAKEN' USING ERRCODE = '23505';
  END IF;
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES (v_org, p_user_id, 'owner');
  -- The org's default legal entity (#1278), named as the org; its tax code is set later (kernel.org.set_tax_code).
  INSERT INTO crove_kernel.legal_entity (org_id, name, is_default, created_by) VALUES (v_org, p_name, true, p_user_id);
  RETURN v_org;
END $$;

-- Restated so this file alone leaves the matrix right (crove_app alone).
REVOKE ALL ON FUNCTION crove_kernel.create_or_replay_org(uuid, text, text, text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.create_or_replay_org(uuid, text, text, text) TO crove_app;
