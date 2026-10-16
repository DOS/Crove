-- Tenant roles lose direct access to user_account (step 2 of issue #169, issue #222, plan §3.6, Decision 14).
-- Idempotent; applied files stay untouched.
--
-- user_account is a control-plane table. Step 1 (20261017160000_crove_kernel_member_profiles.sql) moved every tenant
-- read behind the definer crove_kernel.member_profiles(uuid[]); the tenant roles still held SELECT under the
-- member_visibility RLS policy so that the invariant suite on main kept passing. This migration closes the table to
-- them: the database, not only the source scan, now enforces that tenant code reads accounts through a definer.
--
-- Every function whose body names the table is a SECURITY DEFINER owned by the migration runner, which owns the
-- table (RLS does not filter an owner's reads): identity_upsert, identity_resolve, session_check, session_revoke,
-- session_revoke_orgless, invite_peek and member_profiles. The one exception, invite_for_user, is not a definer, has
-- no EXECUTE grant to any Crove role and is called only from inside the definers invite_peek and invite_accept, so
-- it runs as their owner. No view reads the table. Foreign keys that reference it (tenant.created_by,
-- tenant_member.user_id, the invite, session and upload columns) are checked by PostgreSQL as the owner of the
-- referenced table, so inserts by the tenant roles are unaffected.
--
-- RLS stays enabled with no policy (as on context_key): if a grant ever came back by mistake, a non-owner would
-- still see no row.
SET LOCAL lock_timeout = '2s';

REVOKE ALL ON crove_kernel.user_account FROM PUBLIC;
REVOKE ALL ON crove_kernel.user_account FROM crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_auth_reader,
  crove_prober;

DROP POLICY IF EXISTS member_visibility ON crove_kernel.user_account;
ALTER TABLE crove_kernel.user_account ENABLE ROW LEVEL SECURITY;
