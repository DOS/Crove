-- Crove finance (issue #669): the accountant asks a client company for the purchase invoices the tax portal lists and
-- Crove lacks (#465), by email, with an optional monthly reminder. The mail goes through the kernel mail pipeline
-- (E1a #538, E2 #539) and is sent by the worker through the mail queue (E1b, #548). Idempotent.
--
-- Added here:
--   crove_kernel.tenant.contact_email   the address the org's own mail goes to (here: the request for missing
--                                       invoices). Null until an owner or admin sets it in Settings
--                                       (kernel.org.set_contact_email). Stored lower-cased and trimmed. The mail's
--                                       Reply-To is the org's inbound address, which only owners and admins see, so
--                                       only they may change where it goes: tenant_contact_email_guard refuses any
--                                       other writer, as tenant_tax_code_guard does for the tax code.
--   crove_kernel.tenant.missing_invoice_reminder_day
--                                       the day of the month (1 to 28, so every month has it) on which the worker
--                                       reminds the client of the invoices still missing; null when off. Set by
--                                       finance.missing_invoices.reminder.set, cleared by the reminder itself once
--                                       nothing is missing.
--   crove_finance.missing_invoice_reminders_due
--                                       the worker's scan, across orgs, of the reminders due now (worker only).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS missing_invoice_reminder_day smallint;

DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant
    ADD CONSTRAINT tenant_contact_email_shape CHECK (
      contact_email IS NULL OR (
        contact_email = pg_catalog.lower(pg_catalog.btrim(contact_email))
        AND pg_catalog.length(contact_email) BETWEEN 3 AND 320
        AND contact_email ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant
    ADD CONSTRAINT tenant_missing_invoice_reminder_day_range CHECK (missing_invoice_reminder_day BETWEEN 1 AND 28);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A change of the contact email is refused (CONTACT_EMAIL_FORBIDDEN, 42501) unless the sealed context is a user who is
-- an owner or admin of the org. A row is inserted without one (org creation sets none). Staff (a superuser, or a role
-- that can act as the table's owner) may make any change, as in tenant_tax_code_guard.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_contact_email_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.contact_email IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.contact_email IS NOT DISTINCT FROM OLD.contact_email THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  v_user := crove_kernel.ctx_user_id();
  IF TG_OP = 'INSERT'
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION 'CONTACT_EMAIL_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only kernel.org.set_contact_email, run by an owner or admin of the org, changes its contact email';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_contact_email_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_contact_email_guard BEFORE INSERT OR UPDATE OF contact_email ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_contact_email_guard();
REVOKE ALL ON FUNCTION crove_kernel.tenant_contact_email_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The orgs whose monthly reminder is due now: the reminder is on, today (Vietnam time) is its day and it is 08:00 or
-- later, the org is active and has a contact email, and no reminder mail was written since the start of this month. Ids only; each job reads
-- the org again in its own system context and checks the same before it writes a mail.
CREATE OR REPLACE FUNCTION crove_finance.missing_invoice_reminders_due(p_limit int)
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH local AS (SELECT pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()) AS at),
  month_start AS (SELECT pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.date_trunc('month', l.at)) AS at FROM local l)
  SELECT t.org_id
  FROM crove_kernel.tenant t, local l, month_start s
  WHERE t.status = 'active'
    AND t.missing_invoice_reminder_day = pg_catalog.date_part('day', l.at)::int
    AND pg_catalog.date_part('hour', l.at) >= 8
    AND t.contact_email IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.mail_message m
      WHERE m.org_id = t.org_id AND m.source = 'finance.missing_invoices.remind' AND m.created_at >= s.at
    )
  ORDER BY t.org_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_finance.missing_invoice_reminders_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.missing_invoice_reminders_due(int) TO crove_worker;
