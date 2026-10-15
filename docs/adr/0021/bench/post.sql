-- A 2-line VND posting (chain appended later by the chainer).
\set amt random(1, 1000000000)
SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', ':le', '2026-10-15', 'VND', ':dt', 'bench', gen_random_uuid(), 1,
  ('[{"line_no":1,"account_code":"642","debit":' || :amt || '},{"line_no":2,"account_code":"111","credit":' || :amt || '}]')::jsonb,
  NULL, :sync);
