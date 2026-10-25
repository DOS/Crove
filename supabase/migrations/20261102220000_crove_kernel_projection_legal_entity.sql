-- Crove kernel (issue #1280 part 3, plan §4.6 RLS): the kernel projections that carry a legal entity's work are scoped
-- per legal entity, as the finance books are since 20261102140000 (#1485). Idempotent; applied files stay untouched.
--
--   crove_kernel.extraction     a reading of a file: the entity whose document it is. No parent: the entity the writer
--                               names, else the org's default entity. The worker's first reading names the entity of
--                               the member who uploaded the file when that member is limited to legal entities, so it
--                               sees its own upload (kernel uploaderEntity); a re-extraction names the previous run's.
--   crove_kernel.notification   a member's notice: about a file reading it takes the reading's entity (notifyMembers
--                               names it), else the org's default entity.
--
-- crove_kernel.proposal is not scoped yet (#1538): an agent's context takes its position's le_scope, which is empty
-- for every position today, so le_scope on proposal would hide every proposal from every agent. Giving positions a
-- real scope widens what agents read, an owner decision.
--
-- Each gets legal_entity_id NOT NULL, a foreign key to the org's legal entity, an index on (legal_entity_id, org_id)
-- (G3 fk-index), the trigger b_legal_entity (crove_kernel.legal_entity_fill, 20261102180000, ENABLE ALWAYS) and the
-- RESTRICTIVE policy le_scope beside the tenant policy: an actor reads and writes only the rows of the entities its
-- sealed context's le_scope names ('*' every entity), so a member limited to some entities (an external accountant's
-- assignments) sees only their extractions and notifications. Agents read neither table.
--
-- The backfill. Every row on main belongs to its org's default entity (no writer could name another one): the column is
-- filled with ALTER COLUMN ... TYPE uuid USING (...), a rewrite that fires no row trigger and runs no UPDATE, as in
-- 20261102140000. A table with no NULL left is not rewritten. lock_timeout bounds the wait for each table's lock.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  v_spec text[];
  v_table text;
  v_name text;
  v_parent text;
  v_parent_col text;
  v_null boolean;
  v_specs text[][] := ARRAY[
    -- table, parent table, parent key column ('' for none); parents before their children
    ARRAY['crove_kernel.extraction', '', ''],
    ARRAY['crove_kernel.notification', '', '']
  ];
BEGIN
  FOREACH v_spec SLICE 1 IN ARRAY v_specs LOOP
    v_table := v_spec[1];
    v_name := pg_catalog.split_part(v_table, '.', 2);
    v_parent := v_spec[2];
    v_parent_col := v_spec[3];

    EXECUTE pg_catalog.format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS legal_entity_id uuid', v_table);
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s WHERE legal_entity_id IS NULL)', v_table) INTO v_null;
    IF v_null THEN
      -- A rewrite, not an UPDATE: no row trigger fires (see the header).
      EXECUTE pg_catalog.format(
        'ALTER TABLE %s ALTER COLUMN legal_entity_id TYPE uuid USING coalesce(legal_entity_id, crove_kernel.org_default_legal_entity(org_id))',
        v_table);
    END IF;
    EXECUTE pg_catalog.format('ALTER TABLE %s ALTER COLUMN legal_entity_id SET NOT NULL', v_table);

    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                   WHERE c.conrelid = v_table::regclass AND c.conname = v_name || '_legal_entity_fk') THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)',
        v_table, v_name || '_legal_entity_fk');
    END IF;
    -- The foreign key's index (G3 fk-index), entity first, as in 20261102140000.
    EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS %I ON %s (legal_entity_id, org_id)', v_name || '_legal_entity_idx', v_table);

    EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS b_legal_entity ON %s', v_table);
    IF v_parent_col = '' THEN
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON %s '
        'FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_fill()', v_table);
    ELSE
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, %I ON %s '
        'FOR EACH ROW EXECUTE FUNCTION crove_kernel.legal_entity_fill(%L, %L)', v_parent_col, v_table, v_parent, v_parent_col);
    END IF;
    -- Also in replica mode, where ordinary triggers stay silent, so a row written there still gets its entity.
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ALWAYS TRIGGER b_legal_entity', v_table);

    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS le_scope ON %s', v_table);
    EXECUTE pg_catalog.format(
      'CREATE POLICY le_scope ON %s AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
      'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))',
      v_table);
  END LOOP;
END $$;

-- Fresh planner statistics for every table this file altered (see 20261102140000).
ANALYZE crove_kernel.extraction, crove_kernel.notification;
