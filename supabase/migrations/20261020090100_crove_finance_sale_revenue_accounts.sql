-- Crove finance (issue #430, review of #427): a sale line is credited to a revenue account, and a purchase line is
-- never debited to one. Before, check_line_direction (20261019150100) held each line to the account column of its
-- document's direction, but any account of the chart would do, so a sale could post its revenue to an expense account
-- and a purchase its cost to revenue. Now the same trigger, for every writer, also requires:
-- - a sale line's credit_account to be a revenue account: 511 and 515 (every TT133 account of class 5), 711 (other
--   income) or 3387 (unearned revenue), or a sub-account of one of them (a sub-account's code starts with its
--   parent's, 20261019060000);
-- - a purchase line's debit_account not to be one.
-- isRevenueAccount (@crove/kernel-contract) is the same rule, which finance.purchase.record and
-- finance.purchase.revise check first to answer with the line and the account. Rows already recorded are kept as they
-- are: lines are append-only and the trigger checks inserts. Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.check_line_direction() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_direction text;
BEGIN
  SELECT d.direction INTO v_direction
  FROM crove_finance.purchase_document d
  WHERE d.org_id = NEW.org_id AND d.id = NEW.document_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF (v_direction = 'purchase' AND NEW.debit_account IS NULL) OR (v_direction = 'sale' AND NEW.credit_account IS NULL) THEN
    RAISE EXCEPTION 'line % of document % must name the account of the document''s direction', NEW.line_no, NEW.document_id
      USING ERRCODE = '23514';
  END IF;
  IF v_direction = 'sale' AND NEW.credit_account !~ '^(5|711|3387)' THEN
    RAISE EXCEPTION 'line % of sale document % must be credited to a revenue account, not %', NEW.line_no, NEW.document_id, NEW.credit_account
      USING ERRCODE = '23514';
  END IF;
  IF v_direction = 'purchase' AND NEW.debit_account ~ '^(5|711|3387)' THEN
    RAISE EXCEPTION 'line % of purchase document % must not be debited to the revenue account %', NEW.line_no, NEW.document_id, NEW.debit_account
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- CREATE OR REPLACE keeps the function's ACL; repeated so this file states it.
REVOKE ALL ON FUNCTION crove_finance.check_line_direction() FROM PUBLIC, crove_tenant, crove_definer_tenant;
