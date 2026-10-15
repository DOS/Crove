-- Pending member invites with consent (issue #35, plan §7.3). Idempotent; applied files stay untouched.
--
-- Before: an owner or admin added anyone who already had a Crove account straight into the org
-- (kernel.member.add), without the person agreeing.
--
-- After:
--   member_invite              one row per invite, a tenant table under the standard tenant RLS. Owners and
--                              admins create and revoke invites in the org through execute() (kernel.member.invite,
--                              kernel.member.invite_revoke); in-org code may only revoke (column-level UPDATE).
--   member_invite_accept       the invitee, who is not a member yet, accepts. Only the user whose account email is
--                              the invited address, only while the invite is pending; creates the membership and
--                              closes the invite in one statement. It runs as the bootstrap of the org-less command
--                              kernel.member.invite_accept, so execute() then enters the org as the new member and
--                              writes the audit row in the same transaction.
--   member_invite_decline      the invitee declines; writes its own audit row in the org, since a non-member cannot
--                              enter the org to have execute() write it.
--   my_invites                 the caller's pending invites: org name, role, inviter name and dates only.
--   member_invite_guard        the invited address, role, inviter and dates never change, and a closed invite
--                              never reopens.
--   member_invite_requires_audit  a deferred trigger: an invite is accepted, declined or revoked only together with
--                              the audit row of that decision, by the user who made it.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.member_invite (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- Normalized: trimmed and lower case. Matched against the invitee's account email, never a client value.
  email text NOT NULL CHECK (
    email = pg_catalog.lower(pg_catalog.btrim(email)) AND pg_catalog.length(email) BETWEEN 3 AND 320 AND pg_catalog.strpos(email, '@') > 1
  ),
  -- Owners are never invited: an owner promotes a member with kernel.member.change_role.
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  invited_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL DEFAULT pg_catalog.now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid REFERENCES crove_kernel.user_account (id),
  declined_at timestamptz,
  declined_by uuid REFERENCES crove_kernel.user_account (id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES crove_kernel.user_account (id),
  PRIMARY KEY (org_id, id),
  CONSTRAINT member_invite_expiry CHECK (expires_at > created_at),
  -- An invite closes once: accepted, declined or revoked.
  CONSTRAINT member_invite_one_outcome CHECK (pg_catalog.num_nonnulls(accepted_at, declined_at, revoked_at) <= 1),
  CONSTRAINT member_invite_accepted_by CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
  CONSTRAINT member_invite_declined_by CHECK ((declined_at IS NULL) = (declined_by IS NULL)),
  CONSTRAINT member_invite_revoked_by CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- At most one open invite per address and org (an expired one stays open until it is replaced or revoked).
CREATE UNIQUE INDEX IF NOT EXISTS member_invite_open_idx ON crove_kernel.member_invite (org_id, email)
  WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL;
-- my_invites finds the caller's open invites by address across orgs.
CREATE INDEX IF NOT EXISTS member_invite_email_idx ON crove_kernel.member_invite (email)
  WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS member_invite_invited_by_idx ON crove_kernel.member_invite (invited_by);
CREATE INDEX IF NOT EXISTS member_invite_accepted_by_idx ON crove_kernel.member_invite (accepted_by) WHERE accepted_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS member_invite_declined_by_idx ON crove_kernel.member_invite (declined_by) WHERE declined_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS member_invite_revoked_by_idx ON crove_kernel.member_invite (revoked_by) WHERE revoked_by IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_kernel.member_invite');
-- In the org, code creates, reads and revokes invites; it never deletes one (the invite is part of the trail) and
-- never accepts or declines one (only the invitee's definers do).
REVOKE ALL ON crove_kernel.member_invite FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT SELECT, INSERT ON crove_kernel.member_invite TO crove_tenant;
GRANT UPDATE (revoked_at, revoked_by) ON crove_kernel.member_invite TO crove_tenant;

-- Replays of kernel.member.invite_accept are found by the caller's key without knowing the org.
CREATE INDEX IF NOT EXISTS idempotency_key_invite_accept_idx
  ON crove_kernel.idempotency_key (actor_key, key) WHERE command = 'kernel.member.invite_accept';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR (OLD.accepted_at IS NOT NULL AND (NEW.accepted_at, NEW.accepted_by) IS DISTINCT FROM (OLD.accepted_at, OLD.accepted_by))
     OR (OLD.declined_at IS NOT NULL AND (NEW.declined_at, NEW.declined_by) IS DISTINCT FROM (OLD.declined_at, OLD.declined_by))
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by))
  THEN
    RAISE EXCEPTION 'MEMBER_INVITE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS member_invite_guard ON crove_kernel.member_invite;
CREATE TRIGGER member_invite_guard BEFORE UPDATE ON crove_kernel.member_invite
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_invite_guard();

-- Refuses to commit an accepted, declined or revoked invite without the ok audit row of that decision, written by
-- the user who made it, for this invite.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_requires_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_command text;
  v_actor uuid;
BEGIN
  IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
    v_command := 'kernel.member.invite_accept';
    v_actor := NEW.accepted_by;
  ELSIF OLD.declined_at IS NULL AND NEW.declined_at IS NOT NULL THEN
    v_command := 'kernel.member.invite_decline';
    v_actor := NEW.declined_by;
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    v_command := 'kernel.member.invite_revoke';
    v_actor := NEW.revoked_by;
  ELSE
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = NEW.org_id
      AND a.command = v_command
      AND a.outcome = 'ok'
      AND a.actor_type = 'user'
      AND a.actor_id = v_actor
      AND a.target_type = 'kernel.member_invite'
      AND a.target_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'MEMBER_INVITE_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS member_invite_requires_audit ON crove_kernel.member_invite;
CREATE CONSTRAINT TRIGGER member_invite_requires_audit
  AFTER UPDATE ON crove_kernel.member_invite
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_invite_requires_audit();

-- ---------------------------------------------------------------------------
-- Definers for the invitee (not a member of the org yet)
-- ---------------------------------------------------------------------------

-- The invite p_user_id may act on: it exists, the org is active and the invite was sent to the user's account
-- email. Anything else is INVITE_NOT_FOUND, so a wrong user learns nothing about the invite or the org. Locks the
-- invite row: two accepts, or an accept and a revoke, serialize here and the second sees the first one's outcome.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_lock(p_user_id uuid, p_org_id uuid, p_invite_id uuid)
RETURNS crove_kernel.member_invite LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite;
  v_email text;
  v_disabled timestamptz;
BEGIN
  SELECT pg_catalog.lower(pg_catalog.btrim(u.email)), u.disabled_at INTO v_email, v_disabled
  FROM crove_kernel.user_account u WHERE u.id = p_user_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND';
  END IF;
  IF v_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'USER_DISABLED' USING ERRCODE = '42501';
  END IF;
  SELECT i.* INTO v_invite
  FROM crove_kernel.member_invite i
  JOIN crove_kernel.tenant t ON t.org_id = i.org_id AND t.status = 'active'
  WHERE i.org_id = p_org_id AND i.id = p_invite_id
  FOR UPDATE OF i;
  IF v_invite.id IS NULL OR v_invite.email <> v_email THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND';
  END IF;
  RETURN v_invite;
END $$;

-- Raises unless the invite is still pending: not accepted, declined or revoked, and not expired.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_assert_pending(p_invite crove_kernel.member_invite)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_invite.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_REVOKED';
  END IF;
  IF p_invite.accepted_at IS NOT NULL OR p_invite.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_CLOSED';
  END IF;
  IF p_invite.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED';
  END IF;
END $$;

-- Accepts an invite for p_user_id: creates the membership with the invited role and closes the invite, and returns
-- the org. With an idempotency key the caller already used for kernel.member.invite_accept, returns that request's
-- org instead, so execute() replays the stored response. The deferred trigger above refuses the commit unless
-- execute() also wrote the accept's audit row in the org.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_accept(p_user_id uuid, p_org_id uuid, p_invite_id uuid, p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite;
  v_org uuid;
  v_inserted uuid;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('kernel.member.invite_accept:' || p_user_id::text || ':' || p_idempotency_key, 0));
    SELECT k.org_id INTO v_org
    FROM crove_kernel.idempotency_key k
    WHERE k.actor_key = 'user:' || p_user_id::text AND k.key = p_idempotency_key AND k.command = 'kernel.member.invite_accept';
    IF v_org IS NOT NULL THEN
      RETURN v_org;
    END IF;
  END IF;
  v_invite := crove_kernel.member_invite_lock(p_user_id, p_org_id, p_invite_id);
  PERFORM crove_kernel.member_invite_assert_pending(v_invite);
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
  VALUES (v_invite.org_id, p_user_id, v_invite.role)
  ON CONFLICT (org_id, user_id) DO NOTHING
  RETURNING user_id INTO v_inserted;
  IF v_inserted IS NULL THEN
    RAISE EXCEPTION 'ALREADY_MEMBER';
  END IF;
  UPDATE crove_kernel.member_invite
  SET accepted_at = pg_catalog.now(), accepted_by = p_user_id
  WHERE org_id = v_invite.org_id AND id = v_invite.id;
  RETURN v_invite.org_id;
END $$;

-- Declines an invite for p_user_id and writes the decline's audit row in the org. A decline the user already made
-- is a no-op, so a retried request succeeds.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_decline(p_user_id uuid, p_org_id uuid, p_invite_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite;
BEGIN
  v_invite := crove_kernel.member_invite_lock(p_user_id, p_org_id, p_invite_id);
  IF v_invite.declined_at IS NOT NULL THEN
    RETURN;
  END IF;
  PERFORM crove_kernel.member_invite_assert_pending(v_invite);
  UPDATE crove_kernel.member_invite SET declined_at = pg_catalog.now(), declined_by = p_user_id
  WHERE org_id = v_invite.org_id AND id = v_invite.id;
  INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
  VALUES (
    v_invite.org_id, 'user', p_user_id, 'kernel.member.invite_decline', crove_kernel.uuid_v7(), 'ok', 'kernel.member_invite', v_invite.id,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_invite.org_id::text || ':' || v_invite.id::text, 'UTF8')), 'hex'),
    pg_catalog.jsonb_build_object('role', v_invite.role, 'invited_by', v_invite.invited_by)
  );
END $$;

-- The caller's pending invites: sent to the user's account email, not expired, in an active org the user is not a
-- member of yet. Only what the invitee needs to decide: the org's name, the role, who invited them and when.
CREATE OR REPLACE FUNCTION crove_kernel.my_invites(p_user_id uuid)
RETURNS TABLE (org_id uuid, invite_id uuid, org_name text, role text, invited_by_name text, created_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.org_id, i.id, t.name, i.role, COALESCE(inviter.display_name, inviter.email), i.created_at, i.expires_at
  FROM crove_kernel.user_account u
  JOIN crove_kernel.member_invite i
    ON i.email = pg_catalog.lower(pg_catalog.btrim(u.email))
   AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL
   AND i.expires_at > pg_catalog.now()
  JOIN crove_kernel.tenant t ON t.org_id = i.org_id AND t.status = 'active'
  JOIN crove_kernel.user_account inviter ON inviter.id = i.invited_by
  WHERE u.id = p_user_id AND u.disabled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = i.org_id AND m.user_id = p_user_id)
  ORDER BY i.created_at DESC
  LIMIT 50
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: the API login role calls the invitee's definers; helpers and triggers are callable by nobody.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.member_invite_guard(),
  crove_kernel.member_invite_requires_audit(),
  crove_kernel.member_invite_lock(uuid, uuid, uuid),
  crove_kernel.member_invite_assert_pending(crove_kernel.member_invite),
  crove_kernel.member_invite_accept(uuid, uuid, uuid, text),
  crove_kernel.member_invite_decline(uuid, uuid, uuid),
  crove_kernel.my_invites(uuid)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

GRANT EXECUTE ON FUNCTION
  crove_kernel.member_invite_accept(uuid, uuid, uuid, text),
  crove_kernel.member_invite_decline(uuid, uuid, uuid),
  crove_kernel.my_invites(uuid)
TO crove_app;
