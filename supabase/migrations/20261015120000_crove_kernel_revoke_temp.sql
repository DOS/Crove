-- Crove roles lose TEMPORARY on this database (External-tenant gate T17). Without it a session has no
-- temporary schema, so it cannot plant types, casts or functions for a definer body to resolve: the
-- second layer behind the pinned search_path. PostgreSQL grants TEMPORARY to PUBLIC by default, so
-- revoking it from the Crove roles alone changes nothing: it is revoked from PUBLIC.
-- Every other role that holds it today (the bundled or hosted Supabase Auth role `supabase_auth_admin`,
-- other Supabase service roles, the migration runner) first gets it back as a direct grant, so only
-- Crove roles (every role named crove_*, other than the one running this file) change. A role created
-- later has no TEMPORARY unless a migration grants it. The database owner and superusers keep it.
-- The migration runner checks the result on every run (`hardeningViolations` in packages/db). Idempotent.
DO $$
DECLARE
  r record;
BEGIN
  -- Database GRANT and REVOKE by any other role only warn and change nothing. Such a runner is refused
  -- while work remains (the file rolls back and stays out of the ledger), and passes once the owner has
  -- done the revokes by hand.
  IF NOT (
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)
    OR pg_catalog.pg_has_role(current_user,
         (SELECT datdba FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()), 'USAGE')
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname LIKE 'crove\_%' AND rolname <> current_user AND NOT rolsuper
        AND pg_catalog.has_database_privilege(oid, pg_catalog.current_database(), 'TEMPORARY')
    ) THEN
      -- The runner reports only the message, so the remedy goes in it.
      RAISE EXCEPTION '%', pg_catalog.format(
        'role %1$I is neither a superuser nor a member of the owner of database %2$I, so it cannot revoke TEMPORARY. '
        'Run migrate as the database owner, or have the owner run GRANT TEMPORARY ON DATABASE %2$I to every non-Crove role '
        'that needs it, then REVOKE TEMPORARY ON DATABASE %2$I FROM PUBLIC and from every crove_* role, then run migrate again',
        current_user, pg_catalog.current_database());
    END IF;
    RETURN;
  END IF;
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname NOT LIKE 'pg\_%'
      AND rolname NOT LIKE 'crove\_%'
      AND NOT rolsuper
      AND pg_catalog.has_database_privilege(oid, pg_catalog.current_database(), 'TEMPORARY')
  LOOP
    EXECUTE pg_catalog.format('GRANT TEMPORARY ON DATABASE %I TO %I', pg_catalog.current_database(), r.rolname);
  END LOOP;
  EXECUTE pg_catalog.format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', pg_catalog.current_database());
  -- Also drop any direct grant to a Crove role.
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'crove\_%' AND rolname <> current_user AND NOT rolsuper
  LOOP
    EXECUTE pg_catalog.format('REVOKE TEMPORARY ON DATABASE %I FROM %I', pg_catalog.current_database(), r.rolname);
  END LOOP;
END $$;
