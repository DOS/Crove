-- Crove finance (issue #326, ADR-0021 section 6): bank statement lines. Idempotent; applied files stay untouched.
--
-- A firm imports the statements its banks export (Excel or CSV) per bank account: a TT133 account under 112 or one of
-- the org's sub-accounts that rolls up to one (1121.VCB, #319). Each line is stored once and never changes:
--   - amount: signed, money into the account positive (the statement's "ghi có"), money out negative ("ghi nợ");
--   - running_balance: the balance after the line, when the file has one;
--   - bank_ref: the bank's transaction reference, when the file has one;
--   - dedupe_key (ADR-0021 section 6), computed by finance.bank.import: ref:<bank_ref>, else
--     bal:<value_date>|<amount>|<running_balance>|<n> (n counts the earlier lines of the same file with the same date,
--     amount and balance, the "+X, -X, +X" case the ADR left open), else NULL;
--   - ambiguous: a line with no key whose date and amount match a line of an earlier import. It is kept and flagged
--     for a person to decide, never dropped or doubled silently.
-- UNIQUE (org_id, bank_account, dedupe_key) holds every writer to one line per key, so an overlapping re-import inserts
-- only the lines it adds. import_id and position (the line's place in its file, oldest first) identify a line within
-- its import. Matching lines to payables and receivables (stage 2 of #326) records matches elsewhere; a line itself is
-- append-only: tenant roles read and insert, nobody updates or deletes.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.bank_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  bank_account text NOT NULL,
  import_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100000),
  value_date date NOT NULL,
  description text NOT NULL CHECK (pg_catalog.length(description) <= 1000),
  amount numeric(20,4) NOT NULL CHECK (amount <> 0),
  running_balance numeric(20,4),
  bank_ref text CHECK (bank_ref IS NULL OR pg_catalog.length(pg_catalog.btrim(bank_ref)) BETWEEN 1 AND 100),
  dedupe_key text CHECK (dedupe_key IS NULL OR pg_catalog.length(dedupe_key) BETWEEN 5 AND 200),
  ambiguous boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT bank_line_position_uq UNIQUE (org_id, import_id, position),
  -- Only a line without a key can be ambiguous: a key decides by itself whether a line is new.
  CONSTRAINT bank_line_ambiguous_keyless CHECK (NOT ambiguous OR dedupe_key IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_line_dedupe_uq ON crove_finance.bank_line (org_id, bank_account, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- Lines of one account by date (the ledger screen, the continuity check, the ambiguity lookup).
CREATE INDEX IF NOT EXISTS bank_line_account_date_idx ON crove_finance.bank_line (org_id, bank_account, value_date);

SELECT crove_kernel.apply_tenant_rls('crove_finance.bank_line', true);

-- The account is a bank account of the org: a TT133 account under 112, or a sub-account of the org whose TT133 root is
-- one (read as the writer, so another org's sub-account counts as missing). Raises 23503 like the other account
-- references (check_account_ref). A line keeps an account that was deactivated since; the import refuses inactive ones.
CREATE OR REPLACE FUNCTION crove_finance.check_bank_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM crove_finance.account a WHERE a.code = NEW.bank_account AND pg_catalog.left(a.code, 3) = '112') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_finance.org_account o
    WHERE o.org_id = NEW.org_id AND o.code = NEW.bank_account AND pg_catalog.left(o.root_code, 3) = '112'
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'account % is not a bank account (112) of org %', NEW.bank_account, NEW.org_id USING ERRCODE = '23503';
END $$;

DROP TRIGGER IF EXISTS bank_line_bank_account ON crove_finance.bank_line;
CREATE TRIGGER bank_line_bank_account
  BEFORE INSERT ON crove_finance.bank_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_bank_account();

-- Append-only for every role, the database owner included.
SELECT crove_kernel.make_append_only('crove_finance.bank_line');

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION crove_finance.check_bank_account() FROM PUBLIC, crove_tenant, crove_definer_tenant;
