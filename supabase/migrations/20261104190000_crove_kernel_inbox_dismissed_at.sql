-- A dismissal of an Inbox item is dated by the database (issue #1781, from the review of #1775). Idempotent; applied
-- files stay untouched.
--
-- Before (20261104030000_crove_kernel_inbox_item_grouped.sql): inbox_item_guard checked who dismissed an item (with the
-- RESTRICTIVE policy inbox_item_dismiss) but not when. A member context writing raw SQL could dismiss an item with
-- dismissed_at 40 days back, and the next daily retention run, which prunes an item 30 days after its dismissal, then
-- deleted it at once. kernel.inbox.dismiss itself always dated it ctx.now.
--
-- After: when an open item is dismissed, the guard sets dismissed_at to the transaction's time, whatever the statement
-- wrote, so a dismissal is pruned 30 days after it was made. Everything else is as in 20261104030000: the system
-- context counts failures on open items only and dismisses nothing, only it changes the detail, a dismissal once made
-- stays, and the key, kind, org and raise time are fixed for everyone.
--
-- crove_kernel.inbox_item_guard()  as in 20261104030000, dating a dismissal itself.
CREATE OR REPLACE FUNCTION crove_kernel.inbox_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key OR NEW.raised_at IS DISTINCT FROM OLD.raised_at THEN
    RAISE EXCEPTION 'INBOX_ITEM_FIXED' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'system' THEN
    -- The system counts another failure on an open item; it dismisses nothing and leaves a dismissed item alone.
    IF OLD.dismissed_at IS NOT NULL OR NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at
       OR NEW.dismissed_by IS DISTINCT FROM OLD.dismissed_by THEN
      RAISE EXCEPTION 'INBOX_ITEM_SYSTEM_COUNTS_ONLY' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.detail IS DISTINCT FROM OLD.detail THEN
    RAISE EXCEPTION 'INBOX_ITEM_DETAIL_SYSTEM_ONLY' USING ERRCODE = '42501';
  ELSIF OLD.dismissed_at IS NOT NULL
     AND (NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at OR NEW.dismissed_by IS DISTINCT FROM OLD.dismissed_by) THEN
    -- A dismissal stays as made: nobody re-dismisses it in their own name or opens the item again.
    RAISE EXCEPTION 'INBOX_ITEM_DISMISSED' USING ERRCODE = '42501';
  ELSIF OLD.dismissed_at IS NULL AND NEW.dismissed_at IS NOT NULL THEN
    -- Dismissed now: dated by the database, so a backdated dismissal cannot have the item pruned early (#1781). A
    -- dismissed item written back unchanged keeps its date.
    NEW.dismissed_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.inbox_item_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
