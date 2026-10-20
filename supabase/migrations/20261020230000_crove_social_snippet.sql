-- Crove Social: saved snippets (issue #584). Idempotent.
--
-- snippet  a named piece of text an org reuses in posts: hashtags, a signature, or a whole post to start from
--          (is_template). provider: the platform it is meant for, or NULL for any. Members create them and change
--          or delete their own; owners and admins change or delete any (the commands check who).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.snippet (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  provider text CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  is_template boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS snippet_name_uq ON crove_social.snippet (org_id, lower(name));
SELECT crove_kernel.apply_tenant_rls('crove_social.snippet');
-- Who made it and when stay as they were.
REVOKE UPDATE ON crove_social.snippet FROM crove_tenant;
GRANT UPDATE (name, body, provider, is_template, updated_at) ON crove_social.snippet TO crove_tenant;
