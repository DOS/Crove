-- Supporting index for a tenant foreign key that had none (#1212, found by the G3 conformance test, #1200): without
-- it, deleting or re-keying a voucher (the org purge, #1024) scans input_vat_check. Partial on the key column being
-- set, since a NULL key is never checked. Idempotent; no data changes.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS input_vat_check_voucher_idx
  ON crove_finance.input_vat_check (org_id, voucher_id) WHERE voucher_id IS NOT NULL;
