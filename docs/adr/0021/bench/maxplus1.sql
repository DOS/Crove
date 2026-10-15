-- Baseline: SELECT max(n) + 1 then INSERT, with 1 ms of work in between.
SELECT spike.baseline_max_plus_one();
