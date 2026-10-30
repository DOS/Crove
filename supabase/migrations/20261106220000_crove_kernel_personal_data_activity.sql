-- Crove kernel (issue #1948, PDPL): a person's email, phone or ID quoted in an activity line is redacted by the erasure.
-- Idempotent; applied files stay untouched.
--
-- crove_kernel.personal_data_redact_activity(kind, value)
--     For kernel.personal_data.erase (R3, owners): replaces every mention of the value in the summaries of the
--     context's org's activity lines with '[đã xóa]' and answers how many lines changed. kind is 'email' (the
--     lowercased address) or 'digits' (8 to 15 digits), as personalDataProbe gives them; the matching is
--     crove_kernel.text_mentions and text_redact (#1678), the same the finder uses. Only the summary changes: the
--     line keeps its record, kind, actor, time and legal entity. Owner-only, checked here too, in the owner's own
--     context: crove_tenant may not update activity rows, so the definer is the one path. It takes the value, never a
--     pattern, so it cannot rewrite anything but mentions of a person.
--
-- Activity lines are not append-only and not anchored in the WORM archive (which holds audit events, journal entries
-- and the numbering), so they may change; task comments and the books are append-only and are kept (the registry in
-- packages/kernel/src/personal-data.ts says why).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.personal_data_redact_activity(p_kind text, p_value text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_rows integer;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR (crove_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PERSONAL_DATA_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- A kind or a value of the wrong shape is refused (22023) before any row is read, whether or not the org has lines.
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  UPDATE crove_kernel.activity a
     SET summary = crove_kernel.text_redact(a.summary, p_kind, p_value, '[đã xóa]')
   WHERE a.org_id = v_org AND crove_kernel.text_mentions(a.summary, p_kind, p_value);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.personal_data_redact_activity(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.personal_data_redact_activity(text, text) TO crove_app;
