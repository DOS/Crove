-- Crove finance (issue #1532, from #1280 part 2b): crove_finance.period_close_due answers one row per org again.
-- Idempotent; applied files stay untouched.
--
-- Since #1503 period_lock holds one row per (org, legal entity), so the join in period_close_due
-- (20261025030000_crove_kernel_notifications.sql) answered one row per entity while the sweep pages by org: a page could
-- end inside an org, and the next page, which starts after that org, skipped its other entities. It is a hint only
-- (finance.period.closing_remind reads the locks again), but the sweep could miss an org whose first row did not look
-- due.
--
-- One row per org, chosen over paging by (org, entity): the sweep and the reminder work per org (one reminder per org
-- and period, finance.period.closing_remind reads every entity's lock), so a per-entity row would only make the sweep
-- run the same org's reminder once per entity. The row carries what the reminder decides by: an org's period is still
-- open while any entity's books are (#1280), so locked_through is the earliest lock across its entities, and none
-- (NULL) while an entity has a lock row that locks nothing or the org has no lock row at all. The signature, its result
-- columns, the cursor and the page bound are unchanged, so the sweep (modules/finance/src/notifications.ts) needs no
-- change.
--
-- Unchanged: a SQL definer, STABLE, search_path = pg_catalog, pg_temp, and EXECUTE for crove_worker alone. CREATE OR
-- REPLACE keeps the owner and the grants; they are stated again below so the matrix is exact whatever an earlier
-- migration left.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.period_close_due(p_after uuid, p_limit int)
RETURNS TABLE (org_id uuid, vat_filing_period text, locked_through date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.org_id, t.vat_filing_period,
         CASE WHEN pg_catalog.bool_and(l.locked_through IS NOT NULL) THEN pg_catalog.min(l.locked_through) END
  FROM crove_kernel.tenant t
  LEFT JOIN crove_finance.period_lock l ON l.org_id = t.org_id
  WHERE t.status = 'active'
    AND t.org_id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
  GROUP BY t.org_id, t.vat_filing_period
  ORDER BY t.org_id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION crove_finance.period_close_due(uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.period_close_due(uuid, int) TO crove_worker;
