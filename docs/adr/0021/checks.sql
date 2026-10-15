-- Gapless check for every series: count, distinct, min, max and gaps must agree.
\echo '== series check (count = max, no gaps, no duplicates) =='
SELECT doc_type, period_key, count(*) AS allocated, count(DISTINCT number) AS distinct_numbers,
       min(number) AS min, max(number) AS max, max(number) - count(*) AS gaps
FROM spike.number_allocation GROUP BY 1, 2 ORDER BY 1;
\echo '== every allocation of a posting series belongs to an entry =='
SELECT a.doc_type, count(*) FILTER (WHERE e.id IS NULL) AS orphan_numbers
FROM spike.number_allocation a LEFT JOIN spike.journal_entry e
  ON e.org_id = a.org_id AND e.legal_entity_id = a.legal_entity_id AND e.doc_type = a.doc_type AND e.period_key = a.period_key AND e.number = a.number
WHERE a.doc_type LIKE 'P%' OR a.doc_type = 'RP' GROUP BY 1 ORDER BY 1;
\echo '== baseline: sequence with 1-in-10 rollback =='
SELECT count(*) AS committed, max(n) AS max_number, max(n) - count(*) AS gaps FROM spike.baseline_seq_doc;
\echo '== baseline: max()+1 =='
SELECT (SELECT count(*) FROM spike.baseline_max_doc) AS committed, (SELECT count(*) FROM spike.baseline_max_dup) AS duplicate_collisions;
\echo '== replay: 50 concurrent identical posts =='
SELECT count(*) AS entries_for_source FROM spike.journal_entry WHERE source_id = '00000000-0000-0000-0000-0000000000f1';
