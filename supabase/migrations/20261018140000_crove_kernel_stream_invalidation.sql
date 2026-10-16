-- Realtime invalidation over SSE (issue #69, plan §2 Realtime, §4.11 and §9). Idempotent; applied files stay untouched.
--
-- 1. Hints. An AFTER INSERT OR UPDATE trigger on the records the SPA shows sends one NOTIFY on channel crove_stream
--    per changed row, with the payload `<org_id> <type> <id>` and nothing else: no row data, no actor, no secret.
--    NOTIFY is transactional, so a rolled-back write sends nothing and a committed one sends its hints at commit;
--    identical hints of one transaction are sent once. The API LISTENs once per instance and hands each hint only to
--    the open streams of that org; the SPA then re-fetches through the normal authorized queries.
--      proposal       crove_kernel.proposal                 id
--      file           crove_kernel.file                     id
--      extraction     crove_kernel.extraction               file_id (the file whose reading changed)
--      journal_entry  crove_finance.journal_entry           id
--      document       crove_finance.purchase_document       id
--                     crove_finance.purchase_document_void  document_id (the document that was voided)
--    The triggers sit on the tables rather than on the outbox because several writes the Inbox shows emit no event
--    (approve, edit and reject of a proposal, the result of an extraction). Deletes send nothing: rows are deleted only
--    by retention and org purges, which no open screen needs at once. Any role connected to the database may LISTEN
--    on any channel, so the payload holds ids only.
-- 2. Stream tickets. EventSource cannot send the Authorization header, so the SPA first asks an authenticated
--    POST /api/stream/tickets for a ticket: 32 random bytes, valid for seconds, bound to the user, the org, the session
--    and the token's assurance, and stored here as its SHA-256 only. GET /api/stream?ticket=... redeems it once
--    (crove_kernel.stream_ticket_redeem deletes the row it returns), on any API instance.
--      crove_kernel.stream_ticket          global machinery table: RLS on, no policy, no grants.
--      crove_kernel.stream_ticket_issue()  writes a ticket unless the user already holds p_per_user_limit unexpired
--                                          ones (false), sweeping up to 100 expired rows first. The count is not
--                                          locked: concurrent issues of one user may pass the limit by their number,
--                                          which still bounds the table.
--      crove_kernel.stream_ticket_redeem() deletes the ticket and returns its binding when it has not expired.
--    Only crove_app may execute them; the API verified the token and the org's session check before it issues one.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Hints
-- ---------------------------------------------------------------------------
-- TG_ARGV[0] is the hint type, TG_ARGV[1] the column that holds the id. Runs as the writer; pg_notify needs no
-- privilege. A row without org_id or id sends nothing.
CREATE OR REPLACE FUNCTION crove_kernel.stream_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF TG_ARGV[1] = 'file_id' THEN
    v_id := NEW.file_id;
  ELSIF TG_ARGV[1] = 'document_id' THEN
    v_id := NEW.document_id;
  ELSE
    v_id := NEW.id;
  END IF;
  IF NEW.org_id IS NOT NULL AND v_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_notify('crove_stream', NEW.org_id::text || ' ' || TG_ARGV[0] || ' ' || v_id::text);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.stream_notify() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.proposal;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_kernel.proposal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('proposal', 'id');
DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.file;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_kernel.file
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('file', 'id');
DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.extraction;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_kernel.extraction
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('extraction', 'file_id');
DROP TRIGGER IF EXISTS stream_hint ON crove_finance.journal_entry;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_finance.journal_entry
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('journal_entry', 'id');
DROP TRIGGER IF EXISTS stream_hint ON crove_finance.purchase_document;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_finance.purchase_document
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('document', 'id');
DROP TRIGGER IF EXISTS stream_hint ON crove_finance.purchase_document_void;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_finance.purchase_document_void
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('document', 'document_id');

-- ---------------------------------------------------------------------------
-- 2. Stream tickets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.stream_ticket (
  ticket_hash text PRIMARY KEY CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES crove_kernel.user_account (id) ON DELETE CASCADE,
  -- Not named org_id: this is control-plane machinery (no tenant grant, no policy, definers only), not a tenant table.
  stream_org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  aal text NOT NULL CHECK (aal IN ('aal1', 'aal2')),
  -- Unix seconds of the token's newest second factor, or NULL.
  mfa_at bigint,
  -- The access token's exp: the stream ends then, and the SPA reconnects with a fresh token.
  token_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX IF NOT EXISTS stream_ticket_user_idx ON crove_kernel.stream_ticket (user_id, expires_at);
CREATE INDEX IF NOT EXISTS stream_ticket_expires_at_idx ON crove_kernel.stream_ticket (expires_at);
REVOKE ALL ON TABLE crove_kernel.stream_ticket FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
ALTER TABLE crove_kernel.stream_ticket ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION crove_kernel.stream_ticket_issue(
  p_ticket_hash text, p_user_id uuid, p_org_id uuid, p_session_id uuid, p_aal text, p_mfa_at bigint,
  p_token_expires_at timestamptz, p_ttl_seconds integer, p_per_user_limit integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_held integer;
BEGIN
  IF p_ticket_hash IS NULL OR p_ticket_hash !~ '^[0-9a-f]{64}$' OR p_user_id IS NULL OR p_org_id IS NULL
     OR p_session_id IS NULL OR p_aal IS NULL OR p_aal NOT IN ('aal1', 'aal2') OR p_token_expires_at IS NULL
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 120
     OR p_per_user_limit IS NULL OR p_per_user_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'STREAM_TICKET_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_token_expires_at <= pg_catalog.now() THEN
    RETURN false;
  END IF;

  -- Expired tickets of anyone; SKIP LOCKED so concurrent sweeps never wait on each other.
  DELETE FROM crove_kernel.stream_ticket s
  WHERE s.ticket_hash IN (
    SELECT x.ticket_hash FROM crove_kernel.stream_ticket x
    WHERE x.expires_at <= pg_catalog.now()
    ORDER BY x.expires_at LIMIT 100
    FOR UPDATE SKIP LOCKED);

  SELECT pg_catalog.count(*)::integer INTO v_held
  FROM crove_kernel.stream_ticket s
  WHERE s.user_id = p_user_id AND s.expires_at > pg_catalog.now();
  IF v_held >= p_per_user_limit THEN
    RETURN false;
  END IF;

  INSERT INTO crove_kernel.stream_ticket (ticket_hash, user_id, stream_org_id, session_id, aal, mfa_at, token_expires_at, expires_at)
  VALUES (p_ticket_hash, p_user_id, p_org_id, p_session_id, p_aal, p_mfa_at, p_token_expires_at,
          LEAST(p_token_expires_at, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds)));
  RETURN true;
END $$;

-- Single use: the row is deleted whether or not it has expired; only an unexpired one is returned.
CREATE OR REPLACE FUNCTION crove_kernel.stream_ticket_redeem(p_ticket_hash text)
RETURNS TABLE (user_id uuid, org_id uuid, session_id uuid, aal text, mfa_at bigint, token_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH redeemed AS (
    DELETE FROM crove_kernel.stream_ticket s WHERE s.ticket_hash = p_ticket_hash
    RETURNING s.user_id, s.stream_org_id, s.session_id, s.aal, s.mfa_at, s.token_expires_at, s.expires_at
  )
  SELECT r.user_id, r.stream_org_id, r.session_id, r.aal, r.mfa_at, r.token_expires_at
  FROM redeemed r
  WHERE r.expires_at > pg_catalog.now()
$$;

-- crove_app alone.
REVOKE ALL ON FUNCTION crove_kernel.stream_ticket_issue(text, uuid, uuid, uuid, text, bigint, timestamptz, integer, integer)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
GRANT EXECUTE ON FUNCTION crove_kernel.stream_ticket_issue(text, uuid, uuid, uuid, text, bigint, timestamptz, integer, integer) TO crove_app;
REVOKE ALL ON FUNCTION crove_kernel.stream_ticket_redeem(text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
GRANT EXECUTE ON FUNCTION crove_kernel.stream_ticket_redeem(text) TO crove_app;
