-- The documents of a party, by direction (issue #999). Idempotent; applied files stay untouched.
--
-- finance.vendors.list counts each listed party's purchase documents and checks whether a party only ever sold to
-- the org (then it is a customer, not a vendor). No index led with (org_id, party_id) for sales, so each check
-- scanned the org's documents.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS purchase_document_party_idx ON crove_finance.purchase_document (org_id, party_id, direction);
