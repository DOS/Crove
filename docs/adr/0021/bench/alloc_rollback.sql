-- Allocates, then rolls back 1 transaction in 10: the rolled-back numbers must be handed out again.
\set r random(1, 10)
BEGIN;
SELECT spike.allocate_number('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', ':dt', '2026', gen_random_uuid());
\if :r = 1
ROLLBACK;
\else
COMMIT;
\endif
