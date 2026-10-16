-- Invite mail limits that hold under concurrency, and a cap per recipient across orgs (issue #185, plan §7.3 item 2).
-- Idempotent; applied files stay untouched.
--
-- Each invite mails its accept link (#129), so kernel.member.invite.create limits the invites created in any 24 hours:
-- 50 per org and 3 per (org, email). Until now it counted them with no lock that invites take against each other
-- (the FOR SHARE locks on membership rows do not conflict), so a burst of parallel invites could overshoot both by
-- about the API's concurrency. And the limits were per org only: one account may create several orgs, so one
-- address could get 3 mails a day from each of them.
--
-- Two definers now decide all three limits in the database, across any number of API instances:
--   - invite_mail_lock(email), called by the command before it reads the pending invite it replaces, takes a
--     transaction-level advisory lock per org, then one per recipient email (always in that order, and no other path
--     takes them, so two invites never deadlock on them). From there on, invites of one org, and invites of one
--     address from any org, run one at a time: the counts below see every invite committed before (READ COMMITTED),
--     so two invites at a limit cannot both see room for one more, and the replacement always sees the previous
--     invite (two parallel invites of one email no longer race to the one-pending-invite index);
--   - invite_mail_gate(email, org_per_day, email_per_day, recipient_per_day), called where the command checked the
--     limits before (after its other refusals, which keep their order), takes the same locks (a transaction takes an
--     advisory lock it already holds again at once), so it is exact even for a caller that skipped invite_mail_lock,
--     and counts this org's invites of the last 24 hours, in total and for this email, and every org's invites of
--     this email in the last 24 hours (revoked, replaced and accepted ones count: each was a mail). Over a limit it
--     raises INVITE_RATE_LIMITED (P0001) with a JSON DETAIL naming the rule (invite_org_per_day,
--     invite_email_per_day, invite_recipient_per_day) and the limit, which the command answers with 429.
-- Both locks are taken under a 3s lock_timeout, set around them and restored after (the hardening check allows no
-- function setting beyond search_path), so a burst of invites cannot park a pooled connection each behind them: a
-- wait past it, or a deadlock, is refused with INVITE_RATE_LIMITED (rule invite_busy, retryAfterSeconds 1).
--
-- The cap per recipient reuses member_invite rows, so no new table keeps emails: the definer reads other orgs'
-- invites (it is owned by the migration runner, which owns the table, so tenant RLS does not filter its reads) and
-- returns nothing; its only answer is whether this address got too many invites, which the caller chose to send.
-- It never reads user_account, so the answer is the same whether or not the address has an account. The count of
-- other orgs' invites is bounded by the limit (LIMIT), and the index below keeps it to one address. The caller must
-- be an owner or admin of the org in the sealed context, the only members who may invite, so nobody else can ask
-- or hold up the invites of an org or an address. Only the API login role may execute either.
SET LOCAL lock_timeout = '2s';

-- Every org's invites of one address, newest first: the per-recipient count reads only that address's recent rows.
CREATE INDEX IF NOT EXISTS member_invite_email_created_idx ON crove_kernel.member_invite (email, created_at DESC);

-- Takes the org's lock, then the recipient's, both held until the transaction ends (locks taken in the block's
-- subtransaction stay held after it commits). The lock key holds a hash of the email, never the email.
CREATE OR REPLACE FUNCTION crove_kernel.invite_mail_lock(p_email text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
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

  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.member.invite:' || v_org::text, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.member.invite.recipient:' || p_email, 0));
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION 'INVITE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'invite_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.invite_mail_gate(
  p_email text,
  p_org_per_day integer,
  p_email_per_day integer,
  p_recipient_per_day integer
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_since timestamptz;
  v_org_count integer;
  v_email_count integer;
  v_recipient_count integer;
BEGIN
  -- Limits from the command's configuration; anything else is a bug in the caller.
  IF p_org_per_day IS NULL OR p_org_per_day NOT BETWEEN 1 AND 100000
     OR p_email_per_day IS NULL OR p_email_per_day NOT BETWEEN 1 AND 100000
     OR p_recipient_per_day IS NULL OR p_recipient_per_day NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'INVITE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- The context, email and role checks, and the locks (at once when this transaction holds them already).
  PERFORM crove_kernel.invite_mail_lock(p_email);

  -- Read after the locks, so the window is measured from the same instant as the counts.
  v_since := pg_catalog.clock_timestamp() - interval '24 hours';
  SELECT pg_catalog.count(*)::integer, (pg_catalog.count(*) FILTER (WHERE i.email = p_email))::integer
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

  -- Every org's invites of this address, counted up to the limit only.
  SELECT pg_catalog.count(*)::integer INTO v_recipient_count
  FROM (
    SELECT 1 FROM crove_kernel.member_invite i
    WHERE i.email = p_email AND i.created_at > v_since
    LIMIT p_recipient_per_day
  ) recent;
  IF v_recipient_count >= p_recipient_per_day THEN
    RAISE EXCEPTION 'INVITE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'invite_recipient_per_day', 'limit', p_recipient_per_day)::text;
  END IF;
END $$;

-- EXECUTE matrix: only the API login role, which runs commands.
REVOKE ALL ON FUNCTION crove_kernel.invite_mail_lock(text), crove_kernel.invite_mail_gate(text, integer, integer, integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.invite_mail_lock(text), crove_kernel.invite_mail_gate(text, integer, integer, integer) TO crove_app;
