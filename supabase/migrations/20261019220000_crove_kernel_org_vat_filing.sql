-- Crove kernel (issue #318): how often the organization files its VAT return, monthly or quarterly, so the
-- multi-client home screen can show each org's next deadline (the 20th of the following month, or the last day of the
-- first month of the following quarter). Optional: null means not chosen yet, and the home screen says so. Set by
-- kernel.org.set_vat_filing_period (owner or admin, audited), next to the tax code (#313).
--
-- The home screen also shows each org's last activity, max(occurred_at) of crove_kernel.activity in the org's own
-- context; the index below answers it without reading the org's whole feed. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS vat_filing_period text;

DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant
    ADD CONSTRAINT tenant_vat_filing_period_check CHECK (vat_filing_period IN ('month', 'quarter'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS activity_org_time_idx ON crove_kernel.activity (org_id, occurred_at DESC);
