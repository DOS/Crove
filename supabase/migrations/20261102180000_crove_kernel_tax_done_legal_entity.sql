-- Crove kernel (issue #1496, from #1280 books per legal entity, plan §4.6): each legal entity files its own returns, so
-- a tax obligation is marked done per legal entity. Idempotent; applied files stay untouched.
--
-- crove_kernel.tax_obligation_done gets legal_entity_id NOT NULL, a foreign key to the org's legal entity, an index on
-- (legal_entity_id, org_id) (G3 fk-index) and a RESTRICTIVE policy le_scope beside the tenant policy, as the finance
-- books got in 20261102140000 (#1485): an actor reads and writes only the marks of the entities its sealed context's
-- le_scope names ('*' every entity). At most one mark per entity, obligation and period (tax_obligation_done_uq gains
-- legal_entity_id). The org's obligation for a period is done when every entity the reader sees has marked it
-- (packages/kernel/src/tax-calendar.ts).
--
-- Which entity a new mark belongs to (trigger b_legal_entity, crove_kernel.legal_entity_fill): the one the writer names
-- (kernel.tax_obligation.done takes legalEntityId and checks it against the caller's scope first), or, when it names
-- none, the org's default entity as the writer sees it. legal_entity_id never changes once written.
--
-- The kernel's own helpers. crove_kernel.org_default_legal_entity and crove_kernel.legal_entity_fill have the contract
-- of crove_finance's (20261102140000): kernel tables use these, finance tables keep theirs, and neither schema reaches
-- into the other for it. #1280 part 3 (proposal, extraction, notification, party) reuses them.
--
-- The backfill. Every mark on main belongs to its org's default entity (no writer could name another one): the column
-- is filled with ALTER COLUMN ... TYPE uuid USING (...), a rewrite that fires no row trigger and runs no UPDATE, as in
-- 20261102140000. lock_timeout bounds the wait for the table's lock. A table with no NULL left is not rewritten.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Helpers (the contract of crove_finance.org_default_legal_entity and crove_finance.legal_entity_fill)
-- ---------------------------------------------------------------------------
-- The org's default legal entity (exactly one per org, 20261030001000). SECURITY INVOKER and executable by no runtime
-- role: a migration's backfill calls it as the migration runner, which owns crove_kernel.legal_entity and so reads it
-- unfiltered.
CREATE OR REPLACE FUNCTION crove_kernel.org_default_legal_entity(p_org_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.id FROM crove_kernel.legal_entity e WHERE e.org_id = p_org_id AND e.is_default
$$;
REVOKE ALL ON FUNCTION crove_kernel.org_default_legal_entity(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- BEFORE INSERT OR UPDATE OF legal_entity_id[, parent key]. Arguments: none for a table without a parent, or the parent
-- table and the column of this table that holds the parent's id (the parent's key is (org_id, id)).
--   - a row with a parent takes the parent's entity; a writer that names another entity is refused
--     (LEGAL_ENTITY_MISMATCH).
--   - a row without one takes the entity the writer names, or, when it names none, the org's default entity.
--   - legal_entity_id never changes once written (LEGAL_ENTITY_IMMUTABLE).
-- SECURITY INVOKER: it reads the parent and the default entity as the writer, through the writer's own policies, so it
-- learns nothing the writer could not read, and a writer limited to other entities finds no default entity and is
-- refused by le_scope or NOT NULL.
CREATE OR REPLACE FUNCTION crove_kernel.legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row jsonb := pg_catalog.to_jsonb(NEW);
  v_given uuid := (v_row ->> 'legal_entity_id')::uuid;
  v_parent uuid;
  v_entity uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND v_given IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) ->> 'legal_entity_id')::uuid THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_IMMUTABLE' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME)::text;
  END IF;
  IF TG_NARGS = 2 THEN
    v_parent := (v_row ->> TG_ARGV[1])::uuid;
  END IF;
  IF v_parent IS NOT NULL THEN
    EXECUTE pg_catalog.format('SELECT p.legal_entity_id FROM %s p WHERE p.org_id = $1 AND p.id = $2', TG_ARGV[0]::regclass)
      INTO v_entity USING NEW.org_id, v_parent;
    IF v_entity IS NULL THEN
      -- A parent the writer cannot see. For a writer limited to some legal entities it may be another entity's parent:
      -- the row loses any entity it named, so le_scope or NOT NULL refuses it. For any other writer (scope '*', or no
      -- context: the database owner, replica mode) the parent is another org's or does not exist: the row is treated
      -- as having no parent, and the tenant policy or the parent's foreign key refuses it.
      IF TG_OP = 'INSERT' AND (crove_kernel.ctx_le_scope() IS NULL OR '*' = ANY (crove_kernel.ctx_le_scope())) THEN
        IF v_given IS NULL THEN
          SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.is_default;
          NEW.legal_entity_id := v_entity;
        END IF;
      ELSIF TG_OP = 'INSERT' THEN
        NEW.legal_entity_id := NULL;
      ELSE
        RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
          DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'parent', TG_ARGV[0])::text;
      END IF;
      RETURN NEW;
    END IF;
    IF v_given IS NULL THEN
      NEW.legal_entity_id := v_entity;
    ELSIF v_given <> v_entity THEN
      RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'parent', TG_ARGV[0])::text;
    END IF;
    RETURN NEW;
  END IF;
  -- No parent: the entity the writer names, or the org's default entity as the writer sees it (none for another org's
  -- row or for a writer whose scope leaves the default entity out, which the policies then refuse).
  IF TG_OP = 'INSERT' AND v_given IS NULL THEN
    SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.is_default;
    NEW.legal_entity_id := v_entity;
  END IF;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.legal_entity_fill() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- crove_kernel.tax_obligation_done: the column, its backfill, key, index, trigger and policy
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.tax_obligation_done ADD COLUMN IF NOT EXISTS legal_entity_id uuid;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crove_kernel.tax_obligation_done WHERE legal_entity_id IS NULL) THEN
    -- A rewrite, not an UPDATE: no row trigger fires (see the header).
    ALTER TABLE crove_kernel.tax_obligation_done ALTER COLUMN legal_entity_id TYPE uuid
      USING coalesce(legal_entity_id, crove_kernel.org_default_legal_entity(org_id));
  END IF;
END $$;
ALTER TABLE crove_kernel.tax_obligation_done ALTER COLUMN legal_entity_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                 WHERE c.conrelid = 'crove_kernel.tax_obligation_done'::regclass AND c.conname = 'tax_obligation_done_legal_entity_fk') THEN
    ALTER TABLE crove_kernel.tax_obligation_done ADD CONSTRAINT tax_obligation_done_legal_entity_fk
      FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id);
  END IF;
  -- One mark per entity, obligation and period.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'crove_kernel.tax_obligation_done'::regclass AND c.conname = 'tax_obligation_done_uq'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%legal_entity_id%'
  ) THEN
    ALTER TABLE crove_kernel.tax_obligation_done DROP CONSTRAINT IF EXISTS tax_obligation_done_uq;
    ALTER TABLE crove_kernel.tax_obligation_done ADD CONSTRAINT tax_obligation_done_uq UNIQUE (org_id, legal_entity_id, obligation, period);
  END IF;
END $$;
-- The foreign key's index (G3 fk-index), entity first, as in 20261102140000.
CREATE INDEX IF NOT EXISTS tax_obligation_done_legal_entity_idx ON crove_kernel.tax_obligation_done (legal_entity_id, org_id);
-- The calendar reads an org's marks by period (the unique key no longer leads with what it filters on).
CREATE INDEX IF NOT EXISTS tax_obligation_done_period_idx ON crove_kernel.tax_obligation_done (org_id, period);

DROP TRIGGER IF EXISTS b_legal_entity ON crove_kernel.tax_obligation_done;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_kernel.tax_obligation_done
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_fill();
-- Also in replica mode, where ordinary triggers stay silent, so a row written there still gets its entity.
ALTER TABLE crove_kernel.tax_obligation_done ENABLE ALWAYS TRIGGER b_legal_entity;

DROP POLICY IF EXISTS le_scope ON crove_kernel.tax_obligation_done;
CREATE POLICY le_scope ON crove_kernel.tax_obligation_done AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

ANALYZE crove_kernel.tax_obligation_done;
