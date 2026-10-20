-- Channel sets for the composer (issue #774): saved groups of channels ("Brand A: Facebook, Zalo, TikTok") picked in one
-- click. Idempotent; applied files stay untouched.
--
-- crove_social.channel_set  a name and the connections it picks, at most 20. The connections are ids, not a foreign key:
--                           a channel disconnected later drops out of its sets when they are read. Owners and admins
--                           edit; everyone reads. Names are unique in the org, whatever their case.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.channel_set (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  connection_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(connection_ids) <= 20),
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_set_name_uq ON crove_social.channel_set (org_id, lower(name));
SELECT crove_kernel.apply_tenant_rls('crove_social.channel_set');
