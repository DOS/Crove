-- One number per transaction from series (org, LE1, :dt, 2026).
SELECT spike.allocate_number('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', ':dt', '2026', gen_random_uuid());
