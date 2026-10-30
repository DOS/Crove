-- Crove notes (issue #1678, notes step N9, ADR-0037 section 5): how many private notes and to-dos of each author
-- mention a person's email address, phone number, tax code or national ID, for the personal-data finder (#923).
-- Idempotent; applied files stay untouched.
--
-- The finder runs as an owner or admin of the org. Row security shows them the shared notes, which it lists with
-- their text, and their own private items, and no one else's: a member's private note or to-do is theirs alone
-- (ADR-0037). This definer answers how many of each author's private items mention the value, never which or what
-- they say, so the owner can tell the authors before an erasure. It reads the private notes (visibility private) and
-- every to-do (always private), in the trash or not, of the context's org.
--
-- crove_notes.private_matches(kind, value)   per author: notes and to-dos that mention the value
--
-- Callable in a user context only, checked inside to be an owner or admin of the context's org (the personal-data
-- screen runs as that user, ADR-0037): no member, viewer, agent or system context gets an answer. kind and value are
-- the finder's probe, matched by crove_kernel.text_mentions (20261106200000), which raises on any other shape.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_notes.private_matches(p_kind text, p_value text)
RETURNS TABLE (author_user_id uuid, notes bigint, todos bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
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
