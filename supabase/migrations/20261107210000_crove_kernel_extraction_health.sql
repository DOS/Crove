-- SPDX-License-Identifier: AGPL-3.0-only
-- The prober sees AI document extraction failing (issue #1998): a refused key, a used-up quota or a parser sandbox
-- that is down failed every attempt, the job recorded the failure on the file and completed, and nobody heard of it
-- until users complained (docs/runbooks/incidents.md). Idempotent; applied files stay untouched.
--
-- crove_kernel.extraction_health(window_seconds)   for crove_prober alone, read beside crove_kernel.health() in the
--                                                 prober's one read-only transaction (apps/kernel/src/prober.ts):
--   service_failures    kernel.file.read_failed events of the last window_seconds whose reason is 'service': every
--                       attempt to read the file threw (the AI provider or the parser sandbox), which the operator must
--                       see (apps/kernel/src/worker.ts, recordLastAttemptFailure).
--   document_failures   the others: the document itself could not be read (not an invoice, unreadable, unsupported,
--                       AI switched off or not configured), which pages nobody. An event written before #1998 carries no
--                       reason and counts here.
-- Counts only, no tenant data. The window is clamped to 60 s .. 1 day, and each count stops at 10000; the events are
-- read through the outbox's BRIN index on created_at, so only the window's rows are visited.
--
-- A function of its own, as archive_health() (#1997): health()'s result never changes (every migration file must
-- re-apply on the final schema). The invariant suite lets crove_prober execute this one since #2039.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.extraction_health(p_window_seconds int)
RETURNS TABLE (service_failures int, document_failures int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_since constant timestamptz := pg_catalog.now()
    - pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_window_seconds, 3600), 60), 86400));
BEGIN
  SELECT pg_catalog.count(*) FILTER (WHERE f.reason = 'service')::int, pg_catalog.count(*) FILTER (WHERE f.reason IS DISTINCT FROM 'service')::int
    INTO service_failures, document_failures
    FROM (
      SELECT e.payload ->> 'reason' AS reason FROM crove_kernel.outbox_event e
       WHERE e.created_at > v_since AND e.type = 'kernel.file.read_failed'
       LIMIT 10000
    ) f;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.extraction_health(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.extraction_health(int) TO crove_prober;
