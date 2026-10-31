-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2144, review of #2132, part of #1374): disconnecting a calendar revokes the grant at the
-- provider. The API cannot open a sealed token, so a disconnect no longer deletes the connection at once: it marks it
-- `disconnecting` (hidden from the member, busy blocks gone, token still sealed) and the worker, which can open the
-- token, revokes the grant and then finishes the removal (kernel.calendar.finish_disconnect). Idempotent; applied files
-- stay untouched.
--
-- calendar_connection.status         gains `disconnecting`.
-- calendar_credential_get            also hands out the sealed credential of a disconnecting connection to the worker (system
--                                    context only, as before), and for that one whatever became of its member: the revoke at
--                                    the provider is the only use of the token there, and a member who left, was demoted to
--                                    viewer or was disabled after disconnecting still gets the grant revoked.
-- calendar_sync_due                  also lists the disconnecting connections of active orgs, whose member may since have
--                                    left (the removal is finished either way); same signature, result and grants.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'calendar_connection_status_v2' AND conrelid = 'crove_kernel.calendar_connection'::regclass
  ) THEN
    ALTER TABLE crove_kernel.calendar_connection DROP CONSTRAINT IF EXISTS calendar_connection_status_check;
    ALTER TABLE crove_kernel.calendar_connection ADD CONSTRAINT calendar_connection_status_v2 CHECK (status IN ('active', 'expired', 'disconnecting'));
  END IF;
END $$;

-- The sealed credential of an active or disconnecting connection, for the worker in the system context of its org.
-- Raises NO_CONTEXT (42501) outside a system context, CALENDAR_NOT_FOUND (P0002) when the org has no such connection or
-- it has no credential, CALENDAR_NOT_ACTIVE (55000) when the connection is expired, and, for an active one,
-- CALENDAR_OWNER_LEFT (42501) when the member who owns it has left the org, no longer edits in it, or is disabled.
CREATE OR REPLACE FUNCTION crove_kernel.calendar_credential_get(p_connection_id uuid)
RETURNS TABLE (key_id text, envelope bytea, provider text, external_account text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_connection crove_kernel.calendar_connection%ROWTYPE;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_connection FROM crove_kernel.calendar_connection c WHERE c.org_id = v_org AND c.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CALENDAR_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_connection.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_org AND m.user_id = v_connection.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'CALENDAR_OWNER_LEFT' USING ERRCODE = '42501';
  END IF;
  IF v_connection.status NOT IN ('active', 'disconnecting') THEN
    RAISE EXCEPTION 'CALENDAR_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
    SELECT k.key_id, k.envelope, v_connection.provider, v_connection.external_account
    FROM crove_kernel.calendar_credential k WHERE k.org_id = v_org AND k.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CALENDAR_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.calendar_credential_get(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.calendar_credential_get(uuid) TO crove_worker;

-- A page of the connections the worker has to take care of, after a key, in key order: the active ones of members who are
-- still in the org (to sync) and the disconnecting ones (to revoke and remove, whether or not their member is still in
-- the org). The worker reads each one's state to tell them apart (kernel.calendar.connection_state).
CREATE OR REPLACE FUNCTION crove_kernel.calendar_sync_due(p_after_org uuid, p_after_id uuid, p_limit int)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id, c.provider
  FROM crove_kernel.calendar_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE (p_after_org IS NULL OR (c.org_id, c.id) > (p_after_org, p_after_id))
    AND (
      c.status = 'disconnecting'
      OR (c.status = 'active' AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
        WHERE m.org_id = c.org_id AND m.user_id = c.user_id AND m.role IN ('owner', 'admin', 'member') AND u.disabled_at IS NULL))
    )
  ORDER BY c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_kernel.calendar_sync_due(uuid, uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.calendar_sync_due(uuid, uuid, int) TO crove_worker;
