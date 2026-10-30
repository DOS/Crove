-- SPDX-License-Identifier: AGPL-3.0-only
-- An excuse is never silent (issue #2020). Idempotent; applied files stay untouched.
--
-- After a restore, the WORM verifier excuses the rows a restore acknowledgement names (apps/kernel/src/worm.ts). A run
-- that excuses rows is its own visible state: crove_kernel.archive_verification records how many rows it excused
-- (excused) and the sequence of the acknowledgement in force (restore_ack), for the record. The worker's alert does not
-- read them: it alerts on every run while the acknowledgement is recent by the store's own write time, which the
-- database owner cannot change.
-- crove_kernel.archive_verified(ok, batches, rows, problems, excused, restore_ack) records a run with them, to the worker
-- only. The four-argument form stays for a worker of the previous release during a deploy.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.archive_verification ADD COLUMN IF NOT EXISTS excused bigint NOT NULL DEFAULT 0;
ALTER TABLE crove_kernel.archive_verification ADD COLUMN IF NOT EXISTS restore_ack bigint;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'crove_kernel.archive_verification'::pg_catalog.regclass AND conname = 'archive_verification_excused_check') THEN
    ALTER TABLE crove_kernel.archive_verification
      ADD CONSTRAINT archive_verification_excused_check CHECK (excused >= 0 AND (restore_ack IS NULL OR restore_ack >= 1));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.archive_verified(p_ok boolean, p_batches int, p_rows bigint, p_problems jsonb, p_excused bigint,
                                                        p_restore_ack bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  INSERT INTO crove_kernel.archive_verification (ok, batches, rows_checked, problems, excused, restore_ack)
  VALUES (p_ok, p_batches, p_rows, coalesce(p_problems, '[]'::jsonb), coalesce(p_excused, 0), p_restore_ack);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.archive_verified(boolean, int, bigint, jsonb, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.archive_verified(boolean, int, bigint, jsonb, bigint, bigint) TO crove_worker;
