-- The deltas of the journal entries posted before 20261101160000 (issue #1284). Idempotent: an entry that already has
-- its deltas is skipped, so the statement adds each missing entry once whenever it runs.
--
-- Its own migration, so it runs after the new posting body is committed and every new posting appends its own deltas.
-- A posting that entered the old body before that commit inserts its lines without deltas; the SHARE lock below waits
-- for any such posting still in flight to commit, so its lines are read here, and holds new postings (the new body)
-- back until this commits. The deploy runs migrations while the old release still serves, so the lock is bounded by
-- lock_timeout: if postings keep it busy, the migration fails and the deploy stops with the old release running, to be
-- run again. Should an entry still end up without deltas, the nightly reconciler reports it as 'missing', and running
-- this statement again in a forward migration fills it in.
--
-- Reads the lines as stored, every org at once, as the migration runner (the table owner: no row security applies).
-- The append-only triggers do not refuse an INSERT.
SET LOCAL lock_timeout = '2s';

LOCK TABLE crove_finance.journal_entry, crove_finance.journal_line IN SHARE MODE;

INSERT INTO crove_finance.period_balance_delta (org_id, entry_id, account_code, period_month, debit, credit, line_count)
SELECT l.org_id, l.entry_id, l.account_code, pg_catalog.date_trunc('month', e.entry_date)::date,
       pg_catalog.sum(l.debit), pg_catalog.sum(l.credit), pg_catalog.count(*)
FROM crove_finance.journal_line l
JOIN crove_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id
WHERE NOT EXISTS (
  SELECT 1 FROM crove_finance.period_balance_delta d WHERE d.org_id = l.org_id AND d.entry_id = l.entry_id)
GROUP BY l.org_id, l.entry_id, l.account_code, e.entry_date
ON CONFLICT (org_id, entry_id, account_code) DO NOTHING;
