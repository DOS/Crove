-- The keyed input hash of a command (issue #1732). Idempotent; applied files stay untouched.
--
-- Until now the runtime stored the plain SHA-256 of a command's canonical input in crove_kernel.audit_event.input_sha256
-- (append-only, in the owner's export and in the WORM batches) and in crove_kernel.idempotency_key.request_sha256.
-- For a small input (a private note's short title and empty body, ADR-0037) whoever holds the export or the audit
-- table could confirm a guess by hashing it. Added here:
--   command_input_hash  HMAC-SHA256 under the deployment's hash key, crove_kernel.mail_hash_key (one row, readable by
--                       no role, never rotated, already shared by domain separation with the booking manage links of
--                       ADR-0024), over a domain label, the org of the caller's sealed context, the actor key, the
--                       command and the canonical input. Answered as 'k1:<64 hex>', so a row says which scheme made it.
--                       The org comes from the context, never from an argument: a caller hashes for its own org only.
--                       The same input hashes differently in two orgs, for two actors and in two deployments, and the
--                       same actor's retry of a command hashes the same, as idempotency needs.
--
-- Rows written before stay as they are (plain SHA-256, 64 hex without a prefix); the WORM verifier anchors the column's
-- value as stored, whichever scheme made it. Nothing here changes a table.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.command_input_hash(p_actor_key text, p_command text, p_input text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_ipad bytea;
  v_opad bytea;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The actor key and the command are separated by chr(31) and never contain it, so two different triples never
  -- make one message; the input comes last.
  IF p_actor_key IS NULL OR p_command IS NULL OR p_input IS NULL
     OR pg_catalog.strpos(p_actor_key, pg_catalog.chr(31)) > 0 OR pg_catalog.strpos(p_command, pg_catalog.chr(31)) > 0 THEN
    RAISE EXCEPTION 'INPUT_HASH_ARGUMENT' USING ERRCODE = '22023';
  END IF;
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN 'k1:' || pg_catalog.encode(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to(
      'crove.input.v1' || pg_catalog.chr(31) || v_org::text || pg_catalog.chr(31) || p_actor_key || pg_catalog.chr(31)
      || p_command || pg_catalog.chr(31) || p_input, 'UTF8'))),
    'hex');
END $$;
REVOKE ALL ON FUNCTION crove_kernel.command_input_hash(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.command_input_hash(text, text, text) TO crove_tenant;
