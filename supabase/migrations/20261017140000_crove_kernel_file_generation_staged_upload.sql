-- Evidence storage and integrity (ADR-0013, issue #109, plan §7.6, red-team S25). Idempotent; applied files stay
-- untouched.
--
-- 1. Every file row keeps the triple (storage_key, generation, sha256): generation names the exact object version
--    the bytes were written as (s3:<VersionId>, gcs:<generation>, or content:<sha256> where the store has no
--    versions). Reads request that version and check the sha256, so an object swapped after approval is detected.
-- 2. The triple never changes: a guard trigger refuses every change to a file row.
-- 3. crove_kernel.file_upload holds the single-use grants behind presigned staging uploads.

-- ---------------------------------------------------------------------------
-- 1. generation on file
-- ---------------------------------------------------------------------------
-- NULL only on rows written before this migration: their object version was never recorded, so their reads are
-- checked by sha256 alone. kernel.file.ingest and kernel.inbound.receive require a generation for every new row.
ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS generation text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.file'::regclass AND conname = 'file_generation_format'
  ) THEN
    -- A content: generation is the row's own content address; a versioned one is printable ASCII (S3 version ids
    -- are at most 1024 bytes, GCS generations are decimal numbers).
    ALTER TABLE crove_kernel.file ADD CONSTRAINT file_generation_format CHECK (
      generation IS NULL
      OR (generation ~ '^(s3|gcs):[!-~]+$' AND pg_catalog.length(generation) <= 1028)
      OR generation = 'content:' || sha256
    );
  END IF;
  -- The key is the org's content address, whoever inserts the row (kernel.file.ingest already checks it). NOT VALID:
  -- enforced for every new row without failing an upgrade over a row that predates the check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.file'::regclass AND conname = 'file_storage_key_content_address'
  ) THEN
    ALTER TABLE crove_kernel.file ADD CONSTRAINT file_storage_key_content_address
      CHECK (storage_key = 'org/' || org_id::text || '/' || sha256) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The triple is immutable
-- ---------------------------------------------------------------------------
-- A file row is the reference that extractions, proposals and documents point at by id, so nothing about it ever
-- changes, for every role, the database owner included (only a superuser can skip triggers, for example with
-- session_replication_role = replica). Tenant roles keep UPDATE only because the commands lock the
-- file row (SELECT ... FOR UPDATE needs it); a guard trigger refuses every real change. org_id is left to RLS (a
-- move to another org is refused there), like extraction_guard.
CREATE OR REPLACE FUNCTION crove_kernel.file_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.sha256, NEW.storage_key, NEW.generation, NEW.filename, NEW.content_type, NEW.size_bytes, NEW.source,
      NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.sha256, OLD.storage_key, OLD.generation, OLD.filename, OLD.content_type, OLD.size_bytes,
      OLD.source, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a file reference (key, generation, sha256) never changes';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS file_guard ON crove_kernel.file;
CREATE TRIGGER file_guard BEFORE UPDATE ON crove_kernel.file
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.file_guard();
REVOKE ALL ON FUNCTION crove_kernel.file_guard() FROM PUBLIC;

-- Privileges, restated (unchanged).
REVOKE ALL ON crove_kernel.file FROM PUBLIC;
REVOKE TRUNCATE ON crove_kernel.file FROM crove_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON crove_kernel.file TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 3. Staged upload grants
-- ---------------------------------------------------------------------------
-- One row per presigned upload form (plan §7.6 step 1). The browser uploads to staging_key; the server claims the
-- row (used_at) before it reads the staging object, once. The staging object never becomes a file itself: the
-- server hashes what it read and writes those bytes to org/<org_id>/<sha256>.
CREATE TABLE IF NOT EXISTS crove_kernel.file_upload (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  staging_key text NOT NULL CONSTRAINT file_upload_staging_key_format CHECK (staging_key ~ '^staging/[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  max_bytes bigint NOT NULL CONSTRAINT file_upload_max_bytes CHECK (max_bytes BETWEEN 1 AND 104857600),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL DEFAULT pg_catalog.now() + interval '5 minutes',
  used_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT file_upload_staging_key_uq UNIQUE (staging_key),
  CONSTRAINT file_upload_window CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CONSTRAINT file_upload_used CHECK (used_at IS NULL OR used_at >= created_at)
);
-- Open grants per user, for the cap in kernel.file.upload.begin.
CREATE INDEX IF NOT EXISTS file_upload_open_idx ON crove_kernel.file_upload (org_id, created_by, expires_at) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS file_upload_created_by_idx ON crove_kernel.file_upload (created_by);

SELECT crove_kernel.apply_tenant_rls('crove_kernel.file_upload');

-- Fills what a new grant may not choose: the database clock sets created_at and expires_at (5 minutes), used_at
-- starts empty, and the creator is the user in the sealed context whenever there is one.
CREATE OR REPLACE FUNCTION crove_kernel.file_upload_assign() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  NEW.created_at := pg_catalog.now();
  NEW.expires_at := NEW.created_at + interval '5 minutes';
  NEW.used_at := NULL;
  IF v_user IS NOT NULL THEN
    NEW.created_by := v_user;
  END IF;
  RETURN NEW;
END $$;

-- A grant changes once: it is claimed (used_at, the database clock) while it is unused and unexpired, and only by
-- its creator when a user is in the context. Nothing else about it ever changes; for every role, the database
-- owner included (short of a superuser skipping triggers). Without a user in the context (the worker's system
-- context) the creator check does not apply: no system command creates or claims grants, and the worker never
-- touches this table.
CREATE OR REPLACE FUNCTION crove_kernel.file_upload_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF (NEW.org_id, NEW.id, NEW.staging_key, NEW.created_by, NEW.max_bytes, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.staging_key, OLD.created_by, OLD.max_bytes, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'UPLOAD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'UPLOAD_USED' USING ERRCODE = '42501', DETAIL = 'a staged upload grant is used at most once';
  END IF;
  IF NEW.used_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'UPLOAD_EXPIRED' USING ERRCODE = '42501';
  END IF;
  IF v_user IS NOT NULL AND v_user IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'UPLOAD_NOT_YOURS' USING ERRCODE = '42501';
  END IF;
  NEW.used_at := pg_catalog.now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS file_upload_assign ON crove_kernel.file_upload;
CREATE TRIGGER file_upload_assign BEFORE INSERT ON crove_kernel.file_upload
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.file_upload_assign();
DROP TRIGGER IF EXISTS file_upload_guard ON crove_kernel.file_upload;
CREATE TRIGGER file_upload_guard BEFORE UPDATE ON crove_kernel.file_upload
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.file_upload_guard();

REVOKE ALL ON FUNCTION crove_kernel.file_upload_assign(), crove_kernel.file_upload_guard() FROM PUBLIC;

-- Privileges, restated: tenant roles create and claim grants (through commands); they never delete one and never
-- change anything but used_at.
REVOKE ALL ON crove_kernel.file_upload FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON crove_kernel.file_upload FROM crove_tenant;
GRANT SELECT, INSERT ON crove_kernel.file_upload TO crove_tenant;
GRANT UPDATE (used_at) ON crove_kernel.file_upload TO crove_tenant;
