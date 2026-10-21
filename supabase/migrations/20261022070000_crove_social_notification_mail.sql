-- Social notifications by email (issue #579). Idempotent; applied files stay untouched.
--
-- crove_social.notification_mail_off  a member who turned Social emails off in this org (the in-app notifications
--                                     stay). Under the same restrictive policy as the mutes: each member sees and
--                                     changes only their own; the worker's system context reads them all.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.notification_mail_off (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS notification_mail_off_user_idx ON crove_social.notification_mail_off (org_id, user_id);
SELECT crove_kernel.apply_tenant_rls('crove_social.notification_mail_off');
REVOKE UPDATE ON crove_social.notification_mail_off FROM crove_tenant;
DROP POLICY IF EXISTS own_notification_mail_off ON crove_social.notification_mail_off;
CREATE POLICY own_notification_mail_off ON crove_social.notification_mail_off AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL))
  WITH CHECK (user_id = (SELECT crove_kernel.ctx_user_id()) OR ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL));
