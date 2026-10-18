-- Crove kernel (issue #313): the organization's own tax code (MST). Finance compares it with the seller of an
-- e-invoice to tell a sale (the org issued the invoice) from a purchase. Optional: an org without one records every
-- invoice as a purchase, as before. The stored form is the normalized one of @crove/l10n-vn parseTaxCode: 10 digits,
-- 10 digits, a hyphen and 3 digits (a dependent unit), or 12 digits (an individual). It is set by
-- kernel.org.set_tax_code (owner or admin, audited). When legal entities land (plan §4.6, `legal_entity.tax_code`),
-- this becomes the tax code of the org's default legal entity. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS tax_code text;

DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant
    ADD CONSTRAINT tenant_tax_code_format CHECK (tax_code IS NULL OR tax_code ~ '^([0-9]{10}(-[0-9]{3})?|[0-9]{12})$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
