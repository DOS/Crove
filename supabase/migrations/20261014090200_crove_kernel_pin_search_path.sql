-- Pins pg_catalog first and pg_temp last on every crove_kernel function. The bootstrap set an empty
-- search_path, but with an empty path PostgreSQL still resolves type names in the calling session's
-- temporary schema first, so a caller could substitute its own types (and casts) inside a definer.
-- Idempotent; applied files stay untouched.
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'crove_kernel'::regnamespace AND p.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = pg_catalog, pg_temp', f);
  END LOOP;
END $$;
