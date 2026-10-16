-- Invite mail limits, follow-ups (issue #270, after #185 and plan §7.3 item 2). Idempotent; applied files stay
-- untouched.
--
-- 1. Address variants. The daily limits keyed on the stored email (lower-cased, trimmed), but plus-addressing
--    (name+x@) reaches the same inbox under any tag, and Gmail ignores dots in the local part, so one inbox could get
--    the cap per recipient once per spelling. The limits that key on an address now key on invite_cap_key(email):
--    lower-cased and trimmed, the +tag stripped from the local part for every domain, and for the providers known to
--    ignore dots (gmail.com and googlemail.com, which is folded into gmail.com) the dots removed from the local part.
--    No other provider's dots are removed: a.b@example.com and ab@example.com may be two people. Some providers
--    treat + as an ordinary character; their a+b@ and a@ then share one cap, which only makes the cap stricter for
--    them. The key decides the counts only, never who an invite is for: the invite still stores the email as given
--    (normalized), the pending-invite replacement and ALREADY_MEMBER still compare that email, and acceptance still
--    compares the stored email with the account's, so a.b+x@gmail.com never accepts an invite for ab@gmail.com.
--    Every address-keyed rule folds: the per-recipient cap, the org's per-email limit and the "first invite of the
--    address" exemption (otherwise an org would get a fresh exemption, and a fresh per-email limit, per spelling),
--    and the recipient lock, so that variants of one inbox also run one at a time. The key is computed in SQL inside
--    the definers, from an immutable helper with a pinned search_path, and an index on (key, created_at) keeps the
--    per-recipient count to one inbox's recent rows. The helper is part of an index, so its definition never changes
--    in place: a new folding rule is a new function and a new index.
--
-- 2. One clock. member_invite.created_at was the API's clock (ctx.now) while the window is the database's
--    (clock_timestamp()), so clock skew between API hosts and the database moved the window edge by the skew. The
--    command now writes created_at from the database's clock_timestamp() when it inserts the row, after the gate
--    and its locks, and the column default is clock_timestamp() too, so created_at and the window come from one
--    clock. Not now(): that is the start of the transaction, before the locks, and would age a row out of the
--    window up to that wait early. expires_at stays the API's clock plus the TTL (it is not part of the window, and
--    acceptance compares it with the database's clock as before). Only an API clock more than the TTL behind would
--    put that expiry before the database's clock; such an invite is born expired, and the command dates it just
--    before its expiry so the row still satisfies member_invite_expiry.
--
-- 3. Refuse obviously capped invites before the locks. A burst of invites to an address already at its cap used to
--    wait on the recipient lock (up to 3 seconds each) before being refused, and meanwhile turned other orgs'
--    invites of that address into invite_busy. The command now calls invite_mail_precheck first: the same counts and
--    refusals as invite_mail_gate, without the locks, before invite_mail_lock. It sees only committed invites, so it
--    can only miss a refusal (the gate, which counts under the locks, stays the authority), never refuse an invite
--    the gate would let through at that moment (an invite that would age out of the window during the lock wait,
--    at most 3 seconds, may be refused that much early). The command runs its other refusals before it too, in the same order
--    (ALREADY_MEMBER, INVITE_PENDING_BY_OWNER, TOO_MANY_INVITES), so the answer and its shape do not change.
--
-- The checks the definers share live in two internal functions no role but their owner may execute:
-- invite_mail_caller (context, email and the caller's role) and invite_mail_counts (the limits and the counts).
SET LOCAL lock_timeout = '2s';

-- The cap key of an address (see 1 above). Pure: no table, no setting, nothing but its argument.
CREATE OR REPLACE FUNCTION crove_kernel.invite_cap_key(p_email text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_parts text[] := pg_catalog.regexp_match(v_email, '^(.+)@([^@]+)$');
  v_local text;
  v_domain text;
BEGIN
  IF v_parts IS NULL THEN
    RETURN v_email;
  END IF;
  v_local := v_parts[1];
  v_domain := v_parts[2];
  -- The +tag; a local part that is nothing but a tag keeps it, so it never folds into another address.
  v_local := COALESCE(NULLIF(pg_catalog.split_part(v_local, '+', 1), ''), v_local);
  IF v_domain IN ('gmail.com', 'googlemail.com') THEN
    v_domain := 'gmail.com';
    v_local := COALESCE(NULLIF(pg_catalog.replace(v_local, '.', ''), ''), v_local);
  END IF;
  RETURN v_local || '@' || v_domain;
END $$;

-- Executed whenever a row is indexed, so by every role that writes invites (crove_app, crove_worker and
-- crove_definer_tenant are members of crove_tenant). It reads nothing.
REVOKE ALL ON FUNCTION crove_kernel.invite_cap_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.invite_cap_key(text) TO crove_tenant;

-- Every org's invites of one inbox, newest first: the per-recipient count reads only that inbox's recent rows. It
-- replaces the index on the email itself, which only that count used.
CREATE INDEX IF NOT EXISTS member_invite_cap_key_created_idx
  ON crove_kernel.member_invite (crove_kernel.invite_cap_key(email), created_at DESC);
DROP INDEX IF EXISTS crove_kernel.member_invite_email_created_idx;

-- One clock (see 2 above): writers that leave created_at out get the window's clock too.
ALTER TABLE crove_kernel.member_invite ALTER COLUMN created_at SET DEFAULT pg_catalog.clock_timestamp();

-- The context, email and role checks every invite mail definer starts with. Returns the org in context.
CREATE OR REPLACE FUNCTION crove_kernel.invite_mail_caller(p_email text)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The command passes the normalized email (lower-cased and trimmed, as stored); anything else is a bug in the
  -- caller, refused rather than counted under another key.
  IF p_email IS NULL OR p_email <> pg_catalog.lower(pg_catalog.btrim(p_email)) OR pg_catalog.length(p_email) NOT BETWEEN 3 AND 320 THEN
    RAISE EXCEPTION 'INVITE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Only an owner or admin of the org invites; nobody else may ask how many invites an address got, or hold the locks.
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'INVITE_GATE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_org;
END $$;

-- Takes the org's lock, then the inbox's, both held until the transaction ends (locks taken in the block's
-- subtransaction stay held after it commits). The lock key holds a hash of the cap key, never the email.
CREATE OR REPLACE FUNCTION crove_kernel.invite_mail_lock(p_email text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.invite_mail_caller(p_email);
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.member.invite:' || v_org::text, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('kernel.member.invite.recipient:' || crove_kernel.invite_cap_key(p_email), 0));
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION 'INVITE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'invite_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
END $$;

-- The daily limits: with p_lock, under the locks (the gate); without, on what has committed (the precheck).
CREATE OR REPLACE FUNCTION crove_kernel.invite_mail_counts(
  p_email text,
  p_org_per_day integer,
  p_email_per_day integer,
  p_recipient_per_day integer,
  p_lock boolean
)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_key text;
  v_since timestamptz;
  v_org_count integer;
  v_email_count integer;
  v_recipient_count integer;
BEGIN
  -- Limits from the command's configuration; anything else is a bug in the caller.
  IF p_org_per_day IS NULL OR p_org_per_day NOT BETWEEN 1 AND 1000
     OR p_email_per_day IS NULL OR p_email_per_day NOT BETWEEN 1 AND 1000
     OR p_recipient_per_day IS NULL OR p_recipient_per_day NOT BETWEEN 1 AND 1000 OR p_lock IS NULL THEN
    RAISE EXCEPTION 'INVITE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_org := crove_kernel.invite_mail_caller(p_email);
  IF p_lock THEN
    -- At once when this transaction holds them already.
    PERFORM crove_kernel.invite_mail_lock(p_email);
  END IF;
  v_key := crove_kernel.invite_cap_key(p_email);

  -- Read after the locks, so the window is measured from the same instant as the counts, on the clock created_at
  -- comes from.
  v_since := pg_catalog.clock_timestamp() - interval '24 hours';
  SELECT pg_catalog.count(*)::integer, (pg_catalog.count(*) FILTER (WHERE crove_kernel.invite_cap_key(i.email) = v_key))::integer
    INTO v_org_count, v_email_count
  FROM crove_kernel.member_invite i
  WHERE i.org_id = v_org AND i.created_at > v_since;
  IF v_org_count >= p_org_per_day THEN
    RAISE EXCEPTION 'INVITE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'invite_org_per_day', 'limit', p_org_per_day)::text;
  END IF;
  IF v_email_count >= p_email_per_day THEN
    RAISE EXCEPTION 'INVITE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'invite_email_per_day', 'limit', p_email_per_day)::text;
  END IF;

  -- An org's first invite of the inbox in the window passes (see the header of 20261018110000). Its repeats are
  -- counted with every org's invites of this inbox, up to the limit only.
  IF v_email_count = 0 THEN
    RETURN;
  END IF;
  SELECT pg_catalog.count(*)::integer INTO v_recipient_count
  FROM (
    SELECT 1 FROM crove_kernel.member_invite i
    WHERE crove_kernel.invite_cap_key(i.email) = v_key AND i.created_at > v_since
    LIMIT p_recipient_per_day
  ) recent;
  IF v_recipient_count >= p_recipient_per_day THEN
    RAISE EXCEPTION 'INVITE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'invite_recipient_per_day', 'limit', p_recipient_per_day)::text;
  END IF;
END $$;

-- The authority: the limits counted under the locks, so it is exact even for a caller that skipped invite_mail_lock.
CREATE OR REPLACE FUNCTION crove_kernel.invite_mail_gate(
  p_email text,
  p_org_per_day integer,
  p_email_per_day integer,
  p_recipient_per_day integer
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.invite_mail_counts(p_email, p_org_per_day, p_email_per_day, p_recipient_per_day, true);
END $$;

-- The same refusals without the locks (see 3 above), called before invite_mail_lock.
CREATE OR REPLACE FUNCTION crove_kernel.invite_mail_precheck(
  p_email text,
  p_org_per_day integer,
  p_email_per_day integer,
  p_recipient_per_day integer
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.invite_mail_counts(p_email, p_org_per_day, p_email_per_day, p_recipient_per_day, false);
END $$;

-- EXECUTE matrix: the definers only for the API login role, which runs commands; the internal checks for nobody
-- but their owner, which the definers run as.
REVOKE ALL ON FUNCTION crove_kernel.invite_mail_lock(text), crove_kernel.invite_mail_gate(text, integer, integer, integer),
  crove_kernel.invite_mail_precheck(text, integer, integer, integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.invite_mail_lock(text), crove_kernel.invite_mail_gate(text, integer, integer, integer),
  crove_kernel.invite_mail_precheck(text, integer, integer, integer) TO crove_app;
REVOKE ALL ON FUNCTION crove_kernel.invite_mail_caller(text), crove_kernel.invite_mail_counts(text, integer, integer, integer, boolean)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
