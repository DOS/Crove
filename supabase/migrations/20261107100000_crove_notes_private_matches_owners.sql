-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove notes (issue #1972, follow-up of #1678): crove_notes.private_matches answers owners only. Idempotent; applied
-- files stay untouched.
--
-- The private counts are an oracle: a probe of a guessed value (a salary, an ID number) tells whether some member's
-- private note holds it (ADR-0037 section 3). The personal-data finder already asks for them for owners only and
-- records every search (#1971); this makes the definer refuse an admin too, so a raw call in an admin's context cannot
-- go around the command. Otherwise the same function as 20261106210000.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_notes.private_matches(p_kind text, p_value text)
RETURNS TABLE (author_user_id uuid, notes bigint, todos bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- A value of another shape raises here, before any row is read.
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
    WITH found AS (
      SELECT n.author_user_id AS author, 1 AS note, 0 AS todo
        FROM crove_notes.note n
       WHERE n.org_id = v_org AND n.visibility = 'private'
         AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
              OR crove_kernel.text_mentions(n.body, p_kind, p_value)
              OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
      UNION ALL
      SELECT t.owner_user_id, 0, 1
        FROM crove_notes.todo t
       WHERE t.org_id = v_org
         AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
              OR crove_kernel.text_mentions(t.details, p_kind, p_value)
              OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value))
    )
    SELECT f.author, pg_catalog.sum(f.note)::bigint, pg_catalog.sum(f.todo)::bigint
      FROM found f
     GROUP BY f.author
     ORDER BY f.author;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_matches(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_matches(text, text) TO crove_tenant;
