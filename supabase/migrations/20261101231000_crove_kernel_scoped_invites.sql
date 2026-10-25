-- Crove kernel (issue #1281, plan §4.6 and the T8 row): an owner invites someone as an external accountant scoped to
-- some of the org's legal entities. Idempotent; applied files stay untouched.
--
-- crove_kernel.member_invite.legal_entity_ids  NULL for an ordinary invite. Otherwise 1 to 20 distinct legal entities of
--   the org: on accept the invitee becomes a member or viewer (never admin) holding one external_accountant
--   assignment per entity, in the accept transaction, before the kernel enters the org as them, so their first
--   sealed context is already limited to those entities (enter_context derives le_scope from the assignments).
--
-- member_invite_scope_guard (BEFORE INSERT): a scoped invite is written only by an owner of the org in the sealed
--   context, as its inviter, naming entities of that org. Role assignments are owner-only (plan §4.6); the command
--   checks the same first. member_invite_guard (restated) keeps the scope immutable like everything else on an invite.
-- invite_accept (restated): unchanged for an ordinary invite. For a scoped one it checks, under the locks
--   invite_for_user takes, that the inviter is still an owner and every entity still exists (INVITE_SCOPE_STALE
--   otherwise), then grants the assignments as the inviter. An invitee who is already a member keeps their membership
--   and their assignments: an invite never changes an existing member's access.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.member_invite ADD COLUMN IF NOT EXISTS legal_entity_ids uuid[];

DO $$
BEGIN
  ALTER TABLE crove_kernel.member_invite ADD CONSTRAINT member_invite_scope_check CHECK (
    legal_entity_ids IS NULL
    OR (pg_catalog.cardinality(legal_entity_ids) BETWEEN 1 AND 20
        AND pg_catalog.array_position(legal_entity_ids, NULL) IS NULL
        AND role IN ('member', 'viewer'))
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.member_invite_scope_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.legal_entity_ids IS NULL THEN
    RETURN NEW;
  END IF;
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR crove_kernel.ctx_user_id() IS DISTINCT FROM NEW.invited_by
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = NEW.invited_by AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'INVITE_SCOPE_OWNER_ONLY' USING ERRCODE = '42501',
      DETAIL = 'only an owner of the org invites someone scoped to legal entities';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(NEW.legal_entity_ids) x) <> pg_catalog.cardinality(NEW.legal_entity_ids)
     OR (SELECT pg_catalog.count(*) FROM crove_kernel.legal_entity e
         WHERE e.org_id = NEW.org_id AND e.id = ANY (NEW.legal_entity_ids)) <> pg_catalog.cardinality(NEW.legal_entity_ids) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_invite_scope_guard ON crove_kernel.member_invite;
CREATE TRIGGER member_invite_scope_guard BEFORE INSERT ON crove_kernel.member_invite
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_invite_scope_guard();

-- Restated from 20261015200000_crove_kernel_member_invites.sql with the scope added to what never changes.
CREATE OR REPLACE FUNCTION crove_kernel.member_invite_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending'
     OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.legal_entity_ids IS DISTINCT FROM OLD.legal_entity_ids THEN
    RAISE EXCEPTION 'INVITE_IMMUTABLE' USING ERRCODE = '42501',
      DETAIL = 'an invite only moves once from pending to accepted or revoked';
  END IF;
  RETURN NEW;
END $$;

-- Restated from 20261017010000_crove_kernel_invite_followups.sql with the scope step.
CREATE OR REPLACE FUNCTION crove_kernel.invite_accept(p_user_id uuid, p_token text, p_upstream boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite := crove_kernel.invite_for_user(p_user_id, p_token, true, p_upstream);
  v_joined boolean := false;
BEGIN
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
  VALUES (v_invite.org_id, p_user_id, v_invite.role)
  ON CONFLICT (org_id, user_id) DO NOTHING
  RETURNING true INTO v_joined;
  IF v_invite.legal_entity_ids IS NOT NULL AND COALESCE(v_joined, false) THEN
    -- invite_for_user holds the inviter's membership row FOR SHARE: a demotion that committed first is seen here.
    IF NOT EXISTS (
         SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = v_invite.org_id AND m.user_id = v_invite.invited_by AND m.role = 'owner')
       OR (SELECT pg_catalog.count(*) FROM crove_kernel.legal_entity e
           WHERE e.org_id = v_invite.org_id AND e.id = ANY (v_invite.legal_entity_ids)) <> pg_catalog.cardinality(v_invite.legal_entity_ids) THEN
      RAISE EXCEPTION 'INVITE_SCOPE_STALE' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
    SELECT v_invite.org_id, p_user_id, 'external_accountant', x, v_invite.invited_by
    FROM pg_catalog.unnest(v_invite.legal_entity_ids) x
    ON CONFLICT ON CONSTRAINT role_assignment_uq DO NOTHING;
  END IF;
  UPDATE crove_kernel.member_invite
  SET status = 'accepted', accepted_at = pg_catalog.now(), accepted_by = p_user_id
  WHERE org_id = v_invite.org_id AND id = v_invite.id;
  RETURN v_invite.org_id;
END $$;

-- EXECUTE matrix: the guards are callable by nobody; invite_accept keeps its grant (only the API login role).
REVOKE ALL ON FUNCTION crove_kernel.member_invite_scope_guard(), crove_kernel.member_invite_guard()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.invite_accept(uuid, text, boolean) FROM PUBLIC, crove_tenant, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.invite_accept(uuid, text, boolean) TO crove_app;
