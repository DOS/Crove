-- The same posting, then 5 ms more work in the same transaction (audit, outbox) while the number is held.
\set amt random(1, 1000000000)
BEGIN;
SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', ':le', '2026-10-15', 'VND', ':dt', 'bench', gen_random_uuid(), 1,
  ('[{"line_no":1,"account_code":"642","debit":' || :amt || '},{"line_no":2,"account_code":"111","credit":' || :amt || '}]')::jsonb,
  NULL, false);
SELECT pg_sleep(0.005);
COMMIT;
