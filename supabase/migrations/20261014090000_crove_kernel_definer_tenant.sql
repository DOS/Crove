-- crove_definer_tenant: NOLOGIN owner of the SECURITY DEFINER functions that write tenant data for the
-- context they run in (plan §7.1). It is a member of crove_tenant, so tenant RLS applies to it; it never
-- bypasses RLS. The API and worker roles are not members of it; only a migration runner that is not a
-- superuser joins it, to hand functions to it. Modules grant it only the writes their definers need.
-- Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crove_definer_tenant') THEN
    CREATE ROLE crove_definer_tenant NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- Drift guard: these attributes are what keep RLS in force for the definer.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'crove_definer_tenant'
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR NOT rolinherit)
  ) THEN
    RAISE EXCEPTION 'role crove_definer_tenant must be NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;
END $$;

GRANT crove_tenant TO crove_definer_tenant;
