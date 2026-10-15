-- ADR-0021 spike: single-session scenarios. Each line prints "ok: ..." or "error <sqlstate>: ...".
\pset footer off
SET search_path = spike, pg_catalog;

CREATE FUNCTION spike.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN 'ok: ' || coalesce(v, '(null)');
EXCEPTION WHEN OTHERS THEN
  RETURN 'error ' || SQLSTATE || ': ' || SQLERRM;
END $$;

\set org '''00000000-0000-0000-0000-00000000000a'''
\set le1 '''00000000-0000-0000-0000-0000000000e1'''

\echo '== 1. Money domains =='
SELECT '1.00005 as amount' AS "case", spike.try($$SELECT 1.00005::spike.amount::text$$) AS result
UNION ALL SELECT 'largest amount', spike.try($$SELECT 9999999999999999.9999::spike.amount::text$$)
UNION ALL SELECT '10^16 as amount', spike.try($$SELECT 10000000000000000::spike.amount::text$$)
UNION ALL SELECT 'VND posting with 100.5', spike.try($$SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-10-15', 'VND', 'S1', 'test', gen_random_uuid(), 1,
    '[{"line_no":1,"account_code":"642","debit":"100.5"},{"line_no":2,"account_code":"111","credit":"100.5"}]')::text$$)
UNION ALL SELECT 'USD posting with 100.50', spike.try($$SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-10-15', 'USD', 'S1', 'test', gen_random_uuid(), 1,
    '[{"line_no":1,"account_code":"642","debit":"100.50"},{"line_no":2,"account_code":"1122","credit":"100.50"}]')::text$$)
UNION ALL SELECT 'USD 1,234.56 x 25,432.5 VND/USD, rounded to the dong', spike.try($$SELECT round(1234.56::spike.amount * 25432.5::spike.fx_rate, 0)::text$$)
UNION ALL SELECT 'inverse rate 1/25,432.5 stored as fx_rate', spike.try($$SELECT (1 / 25432.5::numeric)::spike.fx_rate::text$$)
UNION ALL SELECT 'USD 1,000,000 via stored inverse vs direct (VND error)', spike.try($$SELECT (round(1000000 / (1 / 25432.5::numeric)::spike.fx_rate, 0) - 1000000 * 25432.5)::text$$)
UNION ALL SELECT 'qty 3 x unit 33,333.33333333 (unit_amount)', spike.try($$SELECT (3::spike.quantity * 33333.33333333::spike.unit_amount)::text$$)
UNION ALL SELECT 'same line amount rounded to the dong', spike.try($$SELECT round(3::spike.quantity * 33333.33333333::spike.unit_amount, 0)::text$$);

\echo '== 2. source_revision, replay, reversal =='
SELECT spike.post_entry(:org, :le1, '2026-10-15', 'VND', 'S2', 'purchase', '00000000-0000-0000-0000-0000000000b1', 1,
  '[{"line_no":1,"account_code":"642","debit":"1000000"},{"line_no":2,"account_code":"1331","debit":"100000"},{"line_no":3,"account_code":"331","credit":"1100000"}]') AS rev1 \gset
SELECT 'replay rev 1, same payload' AS "case",
       spike.try($$SELECT (spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-10-15', 'VND', 'S2', 'purchase', '00000000-0000-0000-0000-0000000000b1', 1,
  '[{"line_no":1,"account_code":"642","debit":"1000000"},{"line_no":2,"account_code":"1331","debit":"100000"},{"line_no":3,"account_code":"331","credit":"1100000"}]') = '$$ || :'rev1' || $$')::text$$) AS result
UNION ALL SELECT 'numbers allocated in series S2 after replay', spike.try($$SELECT count(*)::text FROM spike.number_allocation WHERE doc_type = 'S2'$$)
UNION ALL SELECT 'rev 1 again, different payload', spike.try($$SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-10-15', 'VND', 'S2', 'purchase', '00000000-0000-0000-0000-0000000000b1', 1,
  '[{"line_no":1,"account_code":"642","debit":"2000000"},{"line_no":2,"account_code":"331","credit":"2000000"}]')::text$$)
UNION ALL SELECT 'rev 2 while rev 1 is still posted', spike.try($$SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-10-16', 'VND', 'S2', 'purchase', '00000000-0000-0000-0000-0000000000b1', 2,
  '[{"line_no":1,"account_code":"642","debit":"2000000"},{"line_no":2,"account_code":"331","credit":"2000000"}]')::text$$);
SELECT spike.reverse_entry(:org, :'rev1', '2026-10-16') AS rev1_reversal \gset
SELECT 'reverse rev 1 a second time (replay)' AS "case", spike.try($$SELECT (spike.reverse_entry('00000000-0000-0000-0000-00000000000a', '$$ || :'rev1' || $$', '2026-10-16') = '$$ || :'rev1_reversal' || $$')::text$$) AS result
UNION ALL SELECT 'rev 1 + reversal, net per account', spike.try($$SELECT string_agg(account_code || '=' || net, ', ' ORDER BY account_code) FROM (
    SELECT account_code, sum(debit - credit)::text AS net FROM spike.journal_line WHERE entry_id IN ('$$ || :'rev1' || $$', '$$ || :'rev1_reversal' || $$') GROUP BY 1) s$$)
UNION ALL SELECT 'rev 3 (skipping 2)', spike.try($$SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-10-16', 'VND', 'S2', 'purchase', '00000000-0000-0000-0000-0000000000b1', 3,
  '[{"line_no":1,"account_code":"642","debit":"2000000"},{"line_no":2,"account_code":"331","credit":"2000000"}]')::text$$)
UNION ALL SELECT 'rev 2 after the reversal', spike.try($$SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-10-16', 'VND', 'S2', 'purchase', '00000000-0000-0000-0000-0000000000b1', 2,
  '[{"line_no":1,"account_code":"642","debit":"2000000"},{"line_no":2,"account_code":"331","credit":"2000000"}]')::text$$);

\echo '== 3. Period close and reopen =='
SELECT spike.post_entry(:org, :le1, '2026-01-20', 'VND', 'S3', 'test', '00000000-0000-0000-0000-0000000000c1', 1,
  '[{"line_no":1,"account_code":"642","debit":"700000"},{"line_no":2,"account_code":"111","credit":"700000"}]') AS jan_entry \gset
SELECT 'close Feb while Jan is open' AS "case", spike.try($$SELECT spike.close_period('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-02-01')::text$$) AS result
UNION ALL SELECT 'close Jan', spike.try($$SELECT spike.close_period('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-01-01')::text$$)
UNION ALL SELECT 'close Feb', spike.try($$SELECT spike.close_period('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-02-01')::text$$)
UNION ALL SELECT 'S3 numbers before the refused post', spike.try($$SELECT max(number)::text FROM spike.number_allocation WHERE doc_type = 'S3'$$)
UNION ALL SELECT 'post dated 2026-01-25 (closed)', spike.try($$SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-01-25', 'VND', 'S3', 'test', gen_random_uuid(), 1,
  '[{"line_no":1,"account_code":"642","debit":"1"},{"line_no":2,"account_code":"111","credit":"1"}]')::text$$)
UNION ALL SELECT 'superuser direct INSERT dated 2026-01-25', spike.try($$INSERT INTO spike.journal_entry (org_id, id, legal_entity_id, entry_date, currency, doc_type, period_key, number, source_type, source_id, source_revision, payload_sha256)
  VALUES ('00000000-0000-0000-0000-00000000000a', gen_random_uuid(), '00000000-0000-0000-0000-0000000000e1', '2026-01-25', 'VND', 'S3', '2026', 1, 'x', gen_random_uuid(), 1, '\x00') RETURNING id::text$$)
UNION ALL SELECT 'S3 numbers after the refused post', spike.try($$SELECT max(number)::text FROM spike.number_allocation WHERE doc_type = 'S3'$$)
UNION ALL SELECT 'reverse the Jan entry, dated 2026-10-16', spike.try($$SELECT (spike.reverse_entry('00000000-0000-0000-0000-00000000000a', '$$ || :'jan_entry' || $$', '2026-10-16') IS NOT NULL)::text$$)
UNION ALL SELECT 'reopen Jan while Feb is closed', spike.try($$SELECT spike.reopen_period('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-01-01', 'audit adjustment')::text$$)
UNION ALL SELECT 'reopen Feb without a reason', spike.try($$SELECT spike.reopen_period('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-02-01', '')::text$$)
UNION ALL SELECT 'reopen Feb with a reason', spike.try($$SELECT spike.reopen_period('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-02-01', 'late supplier invoice')::text$$)
UNION ALL SELECT 'post dated 2026-02-10 after reopen', spike.try($$SELECT (spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-02-10', 'VND', 'S3', 'test', gen_random_uuid(), 1,
  '[{"line_no":1,"account_code":"642","debit":"5"},{"line_no":2,"account_code":"111","credit":"5"}]') IS NOT NULL)::text$$);

\echo '== 4. Voided numbers =='
SELECT 'void S3 number 2' AS "case", spike.try($$SELECT spike.void_number('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'S3', '2026', 2, 'printed with wrong payee')::text$$) AS result
UNION ALL SELECT 'void it again', spike.try($$SELECT spike.void_number('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'S3', '2026', 2, 'again')::text$$)
UNION ALL SELECT 'void a number never allocated', spike.try($$SELECT spike.void_number('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'S3', '2026', 999, 'x')::text$$);

\echo '== 5. Hash chain =='
SELECT 'chain everything pending for LE1' AS "case", spike.try($$SELECT spike.chain_run('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 1000000)::text$$) AS result
UNION ALL SELECT 'verify, untouched', spike.try($$SELECT count(*)::text || ' problems' FROM spike.chain_verify('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1')$$);
-- Tamper as a superuser: change one line amount, then drop a void record.
SET session_replication_role = replica;
UPDATE spike.journal_line SET debit = debit + 1 WHERE entry_id = :'rev1' AND line_no = 1;
UPDATE spike.journal_line SET credit = credit + 1 WHERE entry_id = :'rev1' AND line_no = 3;
DELETE FROM spike.number_void WHERE doc_type = 'S3' AND number = 2;
SET session_replication_role = origin;
SELECT problem, chain_seq, detail FROM spike.chain_verify(:org, :le1);

\echo '== 6. Bank lines =='
SELECT 'statement 1: two identical SMS fees, distinct balances' AS "case", spike.try($$SELECT row(i.*)::text FROM spike.import_bank_lines('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ba', '[
  {"position":1,"value_date":"2026-10-01","amount":"-11000","running_balance":"989000","description":"Phi SMS"},
  {"position":2,"value_date":"2026-10-01","amount":"-11000","running_balance":"978000","description":"Phi SMS"},
  {"position":3,"value_date":"2026-10-02","amount":"5000000","running_balance":"5978000","description":"KH chuyen khoan"}]') i$$) AS result
UNION ALL SELECT 'statement 2 overlaps 1, adds one line', spike.try($$SELECT row(i.*)::text FROM spike.import_bank_lines('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ba', '[
  {"position":1,"value_date":"2026-10-01","amount":"-11000","running_balance":"989000","description":"Phi SMS"},
  {"position":2,"value_date":"2026-10-01","amount":"-11000","running_balance":"978000","description":"Phi SMS"},
  {"position":3,"value_date":"2026-10-02","amount":"5000000","running_balance":"5978000","description":"KH chuyen khoan"},
  {"position":4,"value_date":"2026-10-03","amount":"-11000","running_balance":"5967000","description":"Phi SMS"}]') i$$)
UNION ALL SELECT 'file without balances: two identical lines', spike.try($$SELECT row(i.*)::text FROM spike.import_bank_lines('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000bb', '[
  {"position":1,"value_date":"2026-10-01","amount":"-11000","description":"Phi SMS"},
  {"position":2,"value_date":"2026-10-01","amount":"-11000","description":"Phi SMS"}]') i$$)
UNION ALL SELECT 'same file re-imported', spike.try($$SELECT row(i.*)::text FROM spike.import_bank_lines('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000bb', '[
  {"position":1,"value_date":"2026-10-01","amount":"-11000","description":"Phi SMS"},
  {"position":2,"value_date":"2026-10-01","amount":"-11000","description":"Phi SMS"}]') i$$)
UNION ALL SELECT 'API lines with bank_ref, one sent twice', spike.try($$SELECT row(i.*)::text FROM spike.import_bank_lines('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000bc', '[
  {"position":1,"value_date":"2026-10-01","amount":"-11000","bank_ref":"FT2627400001","description":"Phi SMS"},
  {"position":2,"value_date":"2026-10-01","amount":"-11000","bank_ref":"FT2627400002","description":"Phi SMS"},
  {"position":3,"value_date":"2026-10-01","amount":"-11000","bank_ref":"FT2627400001","description":"Phi SMS"}]') i$$);
