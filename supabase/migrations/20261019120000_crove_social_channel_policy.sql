-- Review policy per channel (Social plan S9, issue #394). Idempotent; applied files stay untouched.
--
-- crove_social.channel_policy  how many different people approve a variant for a channel before it may be
--                              scheduled (1 to 3). A channel without a row needs one approval, as before. Each
--                              approval is a post_approval row bound to the revision and content hash it saw, so a
--                              step never carries over to edited content.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.channel_policy (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  approvals_required smallint NOT NULL DEFAULT 1 CHECK (approvals_required BETWEEN 1 AND 3),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT channel_policy_connection_uq UNIQUE (org_id, channel_connection_id),
  CONSTRAINT channel_policy_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.channel_policy');
REVOKE DELETE ON crove_social.channel_policy FROM crove_tenant;
