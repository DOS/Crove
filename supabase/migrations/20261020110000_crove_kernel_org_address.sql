-- Crove kernel (issue #324): the organization's address, as the public tax registry records it. Prefilled from the
-- tax code lookup when a firm adds a client company, shown and changed in Settings by an owner or admin with
-- kernel.org.set_address (audited). One line of free text, at most 500 characters; null until someone sets it. When
-- legal entities land (plan §4.6), this becomes the address of the org's default legal entity. Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS address text;

DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant
    ADD CONSTRAINT tenant_address_shape CHECK (
      address IS NULL OR (char_length(address) BETWEEN 1 AND 500 AND address = btrim(address) AND address !~ '[[:cntrl:]]')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
