-- Removes the direct member add (issue #35, step 3). Idempotent; applied files stay untouched.
--
-- kernel.member.add, which attached any registered user to an org by email without consent, is gone from the kernel;
-- members join only by accepting an invite (20261015200000_crove_kernel_member_invites.sql). This file removes what
-- it needed in the database and closes the paths that could still create a membership without acceptance:
--   tenant_member        the runtime roles (through crove_tenant) lose INSERT and every UPDATE but the role column.
--                        Membership rows are then created only by the definers create_or_replay_org (the org's
--                        first owner) and invite_accept (an accepted invite). A user can no longer be moved into
--                        another membership by rewriting user_id or org_id. Role changes (kernel.member.change_role)
--                        update only role; removals keep DELETE.
--   user_id_by_email()   dropped: nothing looks users up by email any more, so no definer answers "does this
--                        email have an account".
SET LOCAL lock_timeout = '2s';

REVOKE INSERT, UPDATE ON crove_kernel.tenant_member FROM crove_tenant;
GRANT UPDATE (role) ON crove_kernel.tenant_member TO crove_tenant;

DROP FUNCTION IF EXISTS crove_kernel.user_id_by_email(text);
