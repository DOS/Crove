-- Pending member invites with consent (issue #35, plan §7.3 item 2). Idempotent; applied files stay untouched.
--
-- Today kernel.member.add attaches any registered user to an org by email, without the user's consent, and answers
-- USER_NOT_FOUND for unknown emails (an account oracle). Combined with owner-scoped session revocation (#90), a
-- stranger can add a victim to their own org and then act on the victim's sessions there. This file adds invites
-- the invitee accepts; a later migration removes the direct add (kernel.member.add, user_id_by_email) and the
-- tenant roles' INSERT on tenant_member, once no test fixture depends on them (step 3 of #35).
--
-- Added here:
--   member_invite        an owner or admin invites an email with a role (kernel.member.invite.create, R3). The
--                        invite holds only the SHA-256 of a 256-bit random token; the token itself is returned
--                        once, to the inviter, inside the accept link. Invites expire (7 days, at most 30), can
--                        be revoked, are single-use, and a new invite for the same email replaces the pending one.
--                        Creating an invite never looks the email up, so it reveals nothing about accounts.
--   invite_accept()      the way a user joins an existing org with consent: the signed-in user presents the token; the
--                        definer checks that the invite is pending and unexpired, that the user's verified email
--                        (user_account.email, written only from verified access tokens) is the invited one, and
--                        that the inviter still may grant that role. It inserts the membership and marks the
--                        invite accepted, and returns the org; execute() then enters it as the user and writes the
--                        audit row in the same transaction (kernel.member.invite.accept, org-less like
--                        kernel.org.create). A deferred trigger refuses to commit an accepted invite without that
--                        audit row.
--   invite_peek()        what the invitee sees before consenting (org name, role, inviter, expiry), under the same
--                        token and email checks.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The invite table (tenant table: org_id, PRIMARY KEY (org_id, id), tenant RLS)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.member_invite (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- Stored lower-cased and trimmed; compared with the accepting user's email the same way.
  email text NOT NULL CONSTRAINT member_invite_email_format
    CHECK (email = pg_catalog.lower(pg_catalog.btrim(email)) AND pg_catalog.length(email) BETWEEN 3 AND 320 AND email LIKE '_%@_%'),
  -- Owners are never invited: a co-owner is made by changing an existing member's role.
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  -- SHA-256 (hex) of the token in the accept link. The token itself is never stored.
  -- The default is the hash of nothing anyone holds: a row inserted without a token can never be accepted.
  token_sha256 text NOT NULL
    DEFAULT pg_catalog.encode(pg_catalog.sha256(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid())), 'hex')
    CONSTRAINT member_invite_token_format CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  invited_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT pg_catalog.now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid REFERENCES crove_kernel.user_account (id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES crove_kernel.user_account (id),
  PRIMARY KEY (org_id, id),
  CONSTRAINT member_invite_token_uq UNIQUE (token_sha256),
  CONSTRAINT member_invite_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CONSTRAINT member_invite_accepted CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by IS NOT NULL)),
  CONSTRAINT member_invite_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
-- One pending invite per email and org; a new invite revokes the old one first.
CREATE UNIQUE INDEX IF NOT EXISTS member_invite_pending_uq ON crove_kernel.member_invite (org_id, email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS member_invite_org_created_idx ON crove_kernel.member_invite (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS member_invite_invited_by_idx ON crove_kernel.member_invite (invited_by);
CREATE INDEX IF NOT EXISTS member_invite_accepted_by_idx ON crove_kernel.member_invite (accepted_by) WHERE accepted_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS member_invite_revoked_by_idx ON crove_kernel.member_invite (revoked_by) WHERE revoked_by IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_kernel.member_invite');
-- Tenant roles create and revoke invites (through commands); they never delete one, never change what an invite
-- grants or to whom, and never accept one (accepted_at and accepted_by are not theirs to write).
REVOKE UPDATE, DELETE ON crove_kernel.member_invite FROM crove_tenant;
GRANT UPDATE (status, revoked_at, revoked_by) ON crove_kernel.member_invite TO crove_tenant;

-- An invite changes once, from pending to accepted or revoked, and nothing else about it ever changes; for every
-- role, the database owner included.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending'
     OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'INVITE_IMMUTABLE' USING ERRCODE = '42501',
      DETAIL = 'an invite only moves once from pending to accepted or revoked';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_invite_guard ON crove_kernel.member_invite;
CREATE TRIGGER member_invite_guard BEFORE UPDATE ON crove_kernel.member_invite
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_invite_guard();

-- An accepted invite commits only together with the kernel.member.invite.accept audit row execute() writes for
-- it, so no path can turn an invite into a membership without an audit row in the org.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_requires_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = NEW.org_id AND a.command = 'kernel.member.invite.accept' AND a.outcome = 'ok'
      AND a.actor_id = NEW.accepted_by AND a.detail ->> 'invite_id' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'INVITE_ACCEPT_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS member_invite_requires_audit ON crove_kernel.member_invite;
CREATE CONSTRAINT TRIGGER member_invite_requires_audit
  AFTER UPDATE ON crove_kernel.member_invite
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'accepted') EXECUTE FUNCTION crove_kernel.member_invite_requires_audit();

-- ---------------------------------------------------------------------------
-- Accepting and previewing an invite (org-less: the invitee is not a member yet)
-- ---------------------------------------------------------------------------
-- The invite a token names, locked when p_lock, after the checks every invitee-facing call shares. Raises
-- (P0001, mapped by the kernel): INVITE_NOT_FOUND (malformed or unknown token, or an org that is not active),
-- INVITE_EMAIL_MISMATCH (the signed-in user's email is not the invited one; checked before the status, so only
-- the invitee learns what happened to the invite), INVITE_USED, INVITE_REVOKED (revoked, or the inviter may no
-- longer grant the role), INVITE_EXPIRED.
CREATE OR REPLACE FUNCTION crove_kernel.invite_for_user(p_user_id uuid, p_token text, p_lock boolean)
RETURNS crove_kernel.member_invite LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite;
  v_email text;
  v_inviter_role text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_lock THEN
    SELECT i.* INTO v_invite FROM crove_kernel.member_invite i
    WHERE i.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
    FOR UPDATE;
  ELSE
    SELECT i.* INTO v_invite FROM crove_kernel.member_invite i
    WHERE i.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  END IF;
  IF v_invite.id IS NULL
     OR NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_invite.org_id AND t.status = 'active') THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT pg_catalog.lower(pg_catalog.btrim(u.email)) INTO v_email
  FROM crove_kernel.user_account u WHERE u.id = p_user_id AND u.disabled_at IS NULL;
  IF v_email IS NULL OR v_email <> v_invite.email THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status = 'accepted' THEN
    RAISE EXCEPTION 'INVITE_USED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status = 'revoked' THEN
    RAISE EXCEPTION 'INVITE_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  -- The inviter must still be allowed to grant the role: an owner or admin, and an owner for an admin invite. A
  -- removed or demoted inviter's invites stop working. FOR SHARE when accepting, so a role change of the inviter
  -- that commits first is seen and one that starts later waits.
  IF p_lock THEN
    SELECT m.role INTO v_inviter_role FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_invite.org_id AND m.user_id = v_invite.invited_by FOR SHARE;
  ELSE
    SELECT m.role INTO v_inviter_role FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_invite.org_id AND m.user_id = v_invite.invited_by;
  END IF;
  IF v_inviter_role IS NULL OR v_inviter_role NOT IN ('owner', 'admin') OR (v_invite.role = 'admin' AND v_inviter_role <> 'owner') THEN
    RAISE EXCEPTION 'INVITE_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_invite;
END $$;

-- Accepts the invite the token names for p_user_id and returns its org. The membership keeps an existing role
-- when the user already belongs to the org (an invite never changes a role). Called only by the org-less command
-- kernel.member.invite.accept inside execute(), which then enters the org as the user and writes the audit row.
CREATE OR REPLACE FUNCTION crove_kernel.invite_accept(p_user_id uuid, p_token text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite := crove_kernel.invite_for_user(p_user_id, p_token, true);
BEGIN
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
  VALUES (v_invite.org_id, p_user_id, v_invite.role)
  ON CONFLICT (org_id, user_id) DO NOTHING;
  UPDATE crove_kernel.member_invite
  SET status = 'accepted', accepted_at = pg_catalog.now(), accepted_by = p_user_id
  WHERE org_id = v_invite.org_id AND id = v_invite.id;
  RETURN v_invite.org_id;
END $$;

-- What the invitee consents to: the org, the role, who invited them and until when. Same checks as accepting.
CREATE OR REPLACE FUNCTION crove_kernel.invite_peek(p_user_id uuid, p_token text)
RETURNS TABLE (org_name text, role text, invited_by_email text, invited_by_name text, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite := crove_kernel.invite_for_user(p_user_id, p_token, false);
BEGIN
  RETURN QUERY
  SELECT t.name, v_invite.role, u.email, u.display_name, v_invite.expires_at
  FROM crove_kernel.tenant t
  JOIN crove_kernel.user_account u ON u.id = v_invite.invited_by
  WHERE t.org_id = v_invite.org_id;
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: only the API login role accepts and previews invites; the helper and the triggers are callable
-- by nobody (they run inside the definers and as triggers).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.invite_for_user(uuid, text, boolean),
  crove_kernel.invite_accept(uuid, text),
  crove_kernel.invite_peek(uuid, text),
  crove_kernel.member_invite_guard(),
  crove_kernel.member_invite_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

GRANT EXECUTE ON FUNCTION crove_kernel.invite_accept(uuid, text), crove_kernel.invite_peek(uuid, text) TO crove_app;
