-- Baseline: a PostgreSQL sequence with the same 1-in-10 rollback.
\set r random(1, 10)
BEGIN;
INSERT INTO spike.baseline_seq_doc VALUES (nextval('spike.baseline_seq'));
\if :r = 1
ROLLBACK;
\else
COMMIT;
\endif
