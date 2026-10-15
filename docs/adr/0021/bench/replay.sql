-- Every client posts the same source revision with the same payload: one entry, one number, one id.
SELECT spike.post_entry('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '2026-10-15', 'VND', 'RP', 'bench', '00000000-0000-0000-0000-0000000000f1', 1,
  '[{"line_no":1,"account_code":"642","debit":"500000"},{"line_no":2,"account_code":"111","credit":"500000"}]'::jsonb);
