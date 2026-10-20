-- Crove Social: link preview cards (issue #641). Idempotent.
--
-- link_preview  what a link's page says about itself (title, description, site name), for the composer's preview
--               card, cached per org and URL for a day. A member asks for it (social.link_preview.request); the worker
--               fetches the page through the egress guard (public addresses only, size and time limits, every redirect
--               checked), reads its head in crove-extract and records the answer. Shown in Crove only: nothing here is
--               ever sent to a platform. Tenant roles change only the answer columns; nobody deletes a row.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.link_preview (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  -- The URL's SHA-256 (hex), the cache key.
  url_sha256 text NOT NULL CHECK (url_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  title text CHECK (length(title) BETWEEN 1 AND 300),
  description text CHECK (length(description) BETWEEN 1 AND 1000),
  site_name text CHECK (length(site_name) BETWEEN 1 AND 200),
  -- Why a fetch failed.
  error text CHECK (error IN ('invalid_url', 'blocked', 'dns', 'timeout', 'too_large', 'redirects', 'encoding', 'network', 'http', 'not_html')),
  requested_at timestamptz NOT NULL,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT link_preview_url UNIQUE (org_id, url_sha256),
  CONSTRAINT link_preview_answer CHECK (
    (status = 'pending' AND error IS NULL)
    OR (status = 'ready' AND error IS NULL AND fetched_at IS NOT NULL)
    OR (status = 'failed' AND error IS NOT NULL AND fetched_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS link_preview_requested_idx ON crove_social.link_preview (org_id, requested_at);
SELECT crove_kernel.apply_tenant_rls('crove_social.link_preview');
REVOKE UPDATE, DELETE ON crove_social.link_preview FROM crove_tenant;
GRANT UPDATE (status, title, description, site_name, error, requested_at, fetched_at) ON crove_social.link_preview TO crove_tenant;

-- The worker's queue for the fetch: one job per request (singleton key <org>:<preview>). create_queue skips a queue
-- that exists.
SELECT crove_jobs.create_queue('social-link-preview', '{"policy":"standard"}'::jsonb);
