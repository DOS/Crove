-- Bounces of plain SMTP mail (issue #539, docs/plan/email.md §3.3): every mail Crove sends over SMTP gets its own
-- Return-Path, bounce+<token>@INBOUND_DOMAIN (VERP), so a bounce report (DSN) names the mail it is about. The token is
-- the mail's id (32 hex digits) and a MAC of it (16 hex digits) under the deployment's mail key (mail_hash_key, which
-- no runtime role can read): a report to a made-up or altered address finds no mail. Idempotent; applied files stay
-- untouched.

-- The MAC of a mail id. Only the two definers below call it.
CREATE OR REPLACE FUNCTION crove_kernel.mail_bounce_mac(p_message_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
BEGIN
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN pg_catalog.left(pg_catalog.encode(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to('crove.mail.bounce.v1' || pg_catalog.chr(31) || p_message_id::text, 'UTF8'))),
    'hex'), 16);
END $$;

-- The bounce token of a mail of the org in context, or NULL for a mail the caller cannot see.
CREATE OR REPLACE FUNCTION crove_kernel.mail_bounce_token(p_message_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.mail_message m WHERE m.org_id = crove_kernel.ctx_org_id() AND m.id = p_message_id) THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.replace(p_message_id::text, '-', '') || crove_kernel.mail_bounce_mac(p_message_id);
END $$;

-- The org and id of the mail a bounce token names (worker only). Nothing for a malformed token, a wrong MAC or an
-- unknown mail.
CREATE OR REPLACE FUNCTION crove_kernel.mail_message_by_bounce_token(p_token text)
RETURNS TABLE (org_id uuid, message_id uuid, message_id_header text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{48}$' THEN
    RETURN;
  END IF;
  v_id := pg_catalog.substr(p_token, 1, 32)::uuid;
  IF crove_kernel.mail_bounce_mac(v_id) <> pg_catalog.substr(p_token, 33, 16) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT m.org_id, m.id, m.message_id_header FROM crove_kernel.mail_message m WHERE m.id = v_id;
END $$;

REVOKE ALL ON FUNCTION
  crove_kernel.mail_bounce_mac(uuid),
  crove_kernel.mail_bounce_token(uuid),
  crove_kernel.mail_message_by_bounce_token(text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mail_bounce_token(uuid) TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mail_message_by_bounce_token(text) TO crove_worker;
