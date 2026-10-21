-- Per-org abuse limits (issue #675, plan §4.12 "Per-org abuse limits, from v0"). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.org_usage       what an org used, one row per use: inbound emails received, attachment bytes, extraction
--                              pages and AI cost (in the deployment's configured price unit). The worker reads the sum
--                              over the last 24 hours (a sliding window, like the auth email budget) before it files a
--                              message or reads a document, and records the use after. Append-only for tenants.
-- crove_kernel.usage_deferral  an item kept for later because its org was over a limit: an inbound message (subject_id
--                              is the raw message's sha256) or a document (the file id), and when the worker tries it
--                              again. notified says the org's owners were mailed with this row; they are mailed at most
--                              once per metric in any 24 hours. Append-only for tenants.
--
-- The check and the record are two steps, not one locked reservation: two jobs of one org running at the same time may
-- both pass the check, so an org can go over a limit by what its jobs in flight use. The worker runs one extraction
-- and one inbound job at a time per process, so the overshoot is a few items, never a flood.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.org_usage (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  metric text NOT NULL CONSTRAINT org_usage_metric_check CHECK (metric IN ('inbound_emails', 'attachment_bytes', 'extraction_pages', 'ai_cost')),
  amount numeric(20, 6) NOT NULL CONSTRAINT org_usage_amount_check CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS org_usage_window_idx ON crove_kernel.org_usage (org_id, metric, created_at);
CREATE INDEX IF NOT EXISTS org_usage_created_idx ON crove_kernel.org_usage (created_at);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.org_usage');
REVOKE UPDATE, DELETE, TRUNCATE ON crove_kernel.org_usage FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.usage_deferral (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  metric text NOT NULL CONSTRAINT usage_deferral_metric_check CHECK (metric IN ('inbound_emails', 'attachment_bytes', 'extraction_pages', 'ai_cost')),
  subject_type text NOT NULL CONSTRAINT usage_deferral_subject_type_check CHECK (subject_type IN ('inbound_email', 'file')),
  subject_id text NOT NULL CHECK (pg_catalog.length(subject_id) BETWEEN 1 AND 100),
  retry_at timestamptz NOT NULL,
  notified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS usage_deferral_subject_idx ON crove_kernel.usage_deferral (org_id, subject_type, subject_id, created_at);
CREATE INDEX IF NOT EXISTS usage_deferral_metric_idx ON crove_kernel.usage_deferral (org_id, metric, created_at);
CREATE INDEX IF NOT EXISTS usage_deferral_created_idx ON crove_kernel.usage_deferral (created_at);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.usage_deferral');
REVOKE UPDATE, DELETE, TRUNCATE ON crove_kernel.usage_deferral FROM crove_tenant;
