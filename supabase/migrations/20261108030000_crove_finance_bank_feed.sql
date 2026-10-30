-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2044, ADR-0039 points 2 and 3): the bank accounts a bank feed connection reaches, each mapped
-- to one of the org's bank accounts in one legal entity, with the cursor its pulls start from. Idempotent; applied
-- files stay untouched.
--
-- A connection is a row of crove_kernel.channel_connection with a bank feed provider (`bank_sandbox` first), its
-- credential sealed in crove_kernel.credential (ADR-0025). Owners and admins map an account the provider lists to a
-- bank account under 112 and a legal entity (finance.bank_feed.map); the feed's lines are stored as the entity's bank
-- lines, deduplicated with a statement's (ADR-0021 section 6). One external account maps once per connection.
-- The row carries the entity and is under le_scope like the bank lines it feeds: a member limited to another entity
-- neither sees nor maps it. The account is checked as a bank line's is (check_bank_account).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.bank_feed_account (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  channel_connection_id uuid NOT NULL,
  external_account_id text NOT NULL CHECK (pg_catalog.length(external_account_id) BETWEEN 1 AND 200),
  bank_account text NOT NULL,
  -- Where the next pull starts, as the provider names it; null before the first pull.
  cursor text CHECK (cursor IS NULL OR pg_catalog.length(cursor) BETWEEN 1 AND 500),
  last_synced_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT bank_feed_account_external_uq UNIQUE (org_id, channel_connection_id, external_account_id),
  CONSTRAINT bank_feed_account_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id),
  CONSTRAINT bank_feed_account_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);
CREATE INDEX IF NOT EXISTS bank_feed_account_entity_idx ON crove_finance.bank_feed_account (org_id, legal_entity_id);

SELECT crove_kernel.apply_tenant_rls('crove_finance.bank_feed_account');

DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.bank_feed_account;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.bank_feed_account
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.bank_feed_account ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.bank_feed_account;
CREATE POLICY le_scope ON crove_finance.bank_feed_account AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

DROP TRIGGER IF EXISTS check_bank_account ON crove_finance.bank_feed_account;
CREATE TRIGGER check_bank_account BEFORE INSERT OR UPDATE OF bank_account ON crove_finance.bank_feed_account
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_bank_account();
