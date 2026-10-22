-- Outbox retention (issue #997, plan §4.9 retention table: "outbox_event | 30 days | Archived as org-prefixed JSONL
-- with a sha256 manifest before deletion"). Idempotent; applied files stay untouched.
--
-- Before: outbox_event was append-only for every role, so it grew by about one row per command forever.
--
-- After: the worker's daily retention run archives each org's events one UTC day at a time, once the whole day is
-- older than the keep period (at least 30 days), and only then deletes exactly those rows:
--   1. crove_kernel.outbox_archive_due()     the (org, day) pairs whose events are due, archived or not yet;
--   2. crove_kernel.outbox_archive_rows()    the day's events as canonical JSON lines, in (created_at, id) order;
--   3. the worker writes them once to the WORM archive store (outbox/v1/<org_id>/<day>.jsonl, plus a manifest),
--      reads the object back and checks its sha256;
--   4. crove_kernel.outbox_archive_record()  records the day with the object's key, sha256 and row count;
--   5. crove_kernel.outbox_archive_purge()   deletes the day's rows, refusing when an event is still waiting for the
--      relay (outbox_pending) and rolling back when the count differs from the recorded one.
--
-- crove_kernel.outbox_archive is definer-only machinery (MACHINERY in rls-matrix.db.test.ts, #1025).
--
-- The append-only trigger on outbox_event is replaced by crove_kernel.outbox_event_guard: UPDATE is refused as before,
-- and DELETE is refused unless the row's (org, day) is recorded as archived, the day is past the 30-day floor, and the
-- transaction named that (org, day) in crove.outbox_purge, which only outbox_archive_purge sets. A plain DELETE, by the
-- database owner included, still fails with "append-only" (kernel-invariants.db.test.ts). TRUNCATE stays refused.
--
-- Days are UTC dates of created_at. No other table references an outbox event (relay jobs and dispatch commands read
-- an event within minutes of its emit; pg-boss keeps a job at most 14 days, keep_until, below the 30-day floor).
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS outbox_event_created_brin ON crove_kernel.outbox_event USING brin (created_at);

CREATE TABLE IF NOT EXISTS crove_kernel.outbox_archive (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  day date NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 200),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  row_count int NOT NULL CHECK (row_count > 0),
  archived_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz,
  purged_rows int CHECK (purged_rows >= 0),
  PRIMARY KEY (org_id, day)
);
ALTER TABLE crove_kernel.outbox_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.outbox_archive FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.outbox_archive');

-- The first day that may be archived and purged lies before this: today (UTC) minus the keep days, never less than 30.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_retention_cutoff(p_keep_days int)
RETURNS date LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ((pg_catalog.now() AT TIME ZONE 'UTC')::date - GREATEST(coalesce(p_keep_days, 30), 30))
$$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_retention_cutoff(int) FROM PUBLIC;

-- Org days with events before the cutoff that are not purged yet, oldest first; archived tells whether step 4 is done.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_archive_due(p_keep_days int, p_limit int)
RETURNS TABLE (org_id uuid, day date, archived boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cutoff date := crove_kernel.outbox_retention_cutoff(p_keep_days);
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT d.org_id, d.day, (a.org_id IS NOT NULL)
  FROM (
    SELECT e.org_id, (e.created_at AT TIME ZONE 'UTC')::date AS day
    FROM crove_kernel.outbox_event e
    WHERE e.created_at < (v_cutoff::timestamp AT TIME ZONE 'UTC')
    GROUP BY 1, 2
  ) d
  LEFT JOIN crove_kernel.outbox_archive a ON a.org_id = d.org_id AND a.day = d.day
  ORDER BY d.day, d.org_id
  LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_archive_due(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_archive_due(int, int) TO crove_worker;

-- One org day's events, each as one canonical JSON line (jsonb text: keys in a fixed order, times in UTC with
-- microseconds), in (created_at, id) order.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_archive_rows(p_org_id uuid, p_day date)
RETURNS TABLE (id uuid, line text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  RETURN QUERY
  SELECT e.id, pg_catalog.jsonb_build_object(
           'org_id', e.org_id, 'id', e.id, 'type', e.type, 'payload', e.payload,
           'actor_type', e.actor_type, 'actor_id', e.actor_id, 'agent_id', e.agent_id, 'agent_run', e.agent_run,
           'command_id', e.command_id, 'created_at', crove_kernel.archive_ts(e.created_at))::text
  FROM crove_kernel.outbox_event e
  WHERE e.org_id = p_org_id
    AND e.created_at >= (p_day::timestamp AT TIME ZONE 'UTC')
    AND e.created_at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
  ORDER BY e.created_at, e.id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_archive_rows(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_archive_rows(uuid, date) TO crove_worker;

-- Records an archived org day. A second call with the same object answers false; a different one is refused.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_archive_record(p_org_id uuid, p_day date, p_object_key text, p_sha256 text, p_rows int)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_existing crove_kernel.outbox_archive;
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  IF p_day >= crove_kernel.outbox_retention_cutoff(30) THEN
    RAISE EXCEPTION 'OUTBOX_DAY_TOO_RECENT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_existing FROM crove_kernel.outbox_archive a WHERE a.org_id = p_org_id AND a.day = p_day;
  IF FOUND THEN
    IF v_existing.object_key = p_object_key AND v_existing.sha256 = p_sha256 AND v_existing.row_count = p_rows THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'OUTBOX_ARCHIVE_CONFLICT' USING ERRCODE = '23505';
  END IF;
  INSERT INTO crove_kernel.outbox_archive (org_id, day, object_key, sha256, row_count)
  VALUES (p_org_id, p_day, p_object_key, p_sha256, p_rows);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_archive_record(uuid, date, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_archive_record(uuid, date, text, text, int) TO crove_worker;

-- Deletes an archived org day's events. Answers the rows deleted, 0 when the day is already purged, and -1 when an
-- event of the day still waits for the relay (the next run tries again). The count must match the archived one, or
-- the whole delete rolls back: a row the archive does not hold is never deleted.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_archive_purge(p_org_id uuid, p_day date, p_keep_days int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_archive crove_kernel.outbox_archive;
  v_from timestamptz := p_day::timestamp AT TIME ZONE 'UTC';
  v_to timestamptz := (p_day + 1)::timestamp AT TIME ZONE 'UTC';
  v_deleted int;
BEGIN
  PERFORM crove_kernel.archive_require_worker();
  IF p_day >= crove_kernel.outbox_retention_cutoff(p_keep_days) THEN
    RAISE EXCEPTION 'OUTBOX_DAY_TOO_RECENT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_archive FROM crove_kernel.outbox_archive a WHERE a.org_id = p_org_id AND a.day = p_day FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTBOX_DAY_NOT_ARCHIVED' USING ERRCODE = '42501';
  END IF;
  IF v_archive.purged_at IS NOT NULL THEN
    RETURN 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.outbox_pending p
    JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
    WHERE p.org_id = p_org_id AND e.created_at >= v_from AND e.created_at < v_to
  ) THEN
    RETURN -1;
  END IF;
  PERFORM pg_catalog.set_config('crove.outbox_purge', p_org_id::text || ':' || p_day::text, true);
  DELETE FROM crove_kernel.outbox_event e WHERE e.org_id = p_org_id AND e.created_at >= v_from AND e.created_at < v_to;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM pg_catalog.set_config('crove.outbox_purge', '', true);
  IF v_deleted <> v_archive.row_count THEN
    RAISE EXCEPTION 'OUTBOX_PURGE_MISMATCH' USING ERRCODE = '40001',
      DETAIL = pg_catalog.format('archived %s, found %s', v_archive.row_count, v_deleted);
  END IF;
  UPDATE crove_kernel.outbox_archive a SET purged_at = pg_catalog.now(), purged_rows = v_deleted
  WHERE a.org_id = p_org_id AND a.day = p_day;
  RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_archive_purge(uuid, date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_archive_purge(uuid, date, int) TO crove_worker;

-- Replaces the append-only row trigger: UPDATE never, DELETE only of an archived day named by the purge.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_event_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_day date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_day := (OLD.created_at AT TIME ZONE 'UTC')::date;
    IF pg_catalog.current_setting('crove.outbox_purge', true) = OLD.org_id::text || ':' || v_day::text
       AND v_day < crove_kernel.outbox_retention_cutoff(30)
       AND EXISTS (SELECT 1 FROM crove_kernel.outbox_archive a WHERE a.org_id = OLD.org_id AND a.day = v_day AND a.purged_at IS NULL) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_event_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS append_only_row ON crove_kernel.outbox_event;
DROP TRIGGER IF EXISTS outbox_event_guard ON crove_kernel.outbox_event;
CREATE TRIGGER outbox_event_guard BEFORE UPDATE OR DELETE ON crove_kernel.outbox_event
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.outbox_event_guard();
