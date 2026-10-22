#!/usr/bin/env bash
# Restores a backup made by backup.sh onto a fresh Crove stack and verifies it (issues #307, #351). Runbook:
# docs/runbooks/backup-and-restore.md.
#
#   tools/backup/restore.sh <run>      <run> is a run directory, s3:<run id> or s3:latest (from BACKUP_S3_*)
#
# The target is the compose stack that CROVE_DIR, COMPOSE_PROJECT_NAME, COMPOSE_FILE and .env name, with an empty
# database volume: the script refuses a database that already holds Crove, and a STORAGE or S3_BUCKET that differs
# from what that project resolves. A run downloaded for s3: is deleted once the restore passes. Steps:
#   1. fetch the run (for s3: its files, opened with BACKUP_ENCRYPTION_KEY when sealed, and the org blobs it lists from
#      the shared blob store) and check it against SHA256SUMS and files.sha256; a file neither lists is refused;
#   2. start RESTORE_PRESTART (default: db), load the roles and pg_restore the dump (pg_restore --create, so the
#      database's own settings and grants come back too);
#   3. compare the row count of every table with counts.tsv; check that no journal entry is stamped in the future
#      of this cluster (docs/runbooks/ledger-after-restore.md); make a new context key (the backup has none);
#   4. put the blobs back: into the files volume (STORAGE=local) or the bucket (STORAGE=s3). In a bucket every
#      object gets a new version id, so each file row's recorded generation is pointed at the restored version
#      (a superuser update past the file_guard trigger, listed in the restore log); the sha256 is unchanged. With
#      RESTORE_GENERATIONS=content (the default on GCS, whose generations the MinIO client cannot list) rows point at
#      content:<sha256> instead and are read as the current object, checked by sha256. When a row has no object, the
#      transaction rolls back and no row changes. RESTORE_FILES=skip leaves the files alone, for a bucket that survived
#      the incident;
#   5. read back RESTORE_SAMPLE blobs (default 50, 0 for all) named by restored file rows and check their sha256;
#   6. run migrate, which must succeed (it applies migrations newer than the backup, sets the role passwords and runs
#      the hardening guard); after a restore into a new bucket, re-record each org's export with the restored object
#      versions before the worker starts (main.ts exports-rebind; an org that fails is reported, the restore goes
#      on); then start the whole stack, and /readyz must answer ready.
# Exit 0 when everything passed; otherwise `[restore] FAILED: <reason>` and exit 1. The log goes to stdout and to
# <BACKUP_DIR>/logs/restore-<time>.log.
#
# Settings (environment, then $CROVE_DIR/.env, read as docker compose reads it): STORAGE and S3_* of the target
# stack, BACKUP_DIR, BACKUP_S3_* (for s3:<run>), BACKUP_ENCRYPTION_KEY and BACKUP_ENCRYPTION_KEY_PREVIOUS (for a
# sealed run), RESTORE_PRESTART, RESTORE_SAMPLE, RESTORE_FILES_SERVICE (default crove), BACKUP_NODE_SERVICE (default
# crove), RESTORE_API_SERVICE (default crove when the stack defines it, else api), RESTORE_WORKER_SERVICE (default
# crove when the stack defines it, else worker), RESTORE_GENERATIONS (versions, or content; default content on
# storage.googleapis.com), RESTORE_READY_TIMEOUT (seconds, default 600). RESTORE_ALLOW_UNSEALED=yes, set on the
# command (never read from .env) with an explicit s3:<run id>, restores an unsealed run from the bucket although
# BACKUP_ENCRYPTION_KEY is set, for a run older than the key.
set -Eeuo pipefail
LOG_TAG=restore
# shellcheck source=tools/backup/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STEP=setup
REPORTED=0
LOG_FILE='(none yet)'
on_error() {
  local status=$? line=$1
  [ "$BASH_SUBSHELL" -gt 0 ] && exit "$status"
  trap - ERR
  REPORTED=1
  printf '[restore] FAILED: %s (exit %s, restore.sh line %s); log %s\n' "$STEP" "$status" "$line" "$LOG_FILE" >&2
  exit 1
}
trap 'on_error $LINENO' ERR
# A stop that bypasses on_error (a shell error, a signal) is reported too.
on_exit() {
  local status=$?
  [ "$BASH_SUBSHELL" -gt 0 ] && return
  [ "$status" -ne 0 ] && [ "$REPORTED" -eq 0 ] && printf '[restore] FAILED: stopped with exit %s during: %s; log %s\n' "$status" "$STEP" "$LOG_FILE" >&2
  return 0
}
trap on_exit EXIT

if [ $# -ne 1 ]; then
  echo 'usage: restore.sh <run directory | s3:<run id> | s3:latest>' >&2
  REPORTED=1
  exit 2
fi
SOURCE="$1"
# Taken from the command's own environment only, never from .env, where a forgotten line would switch the downgrade
# check off for good.
ALLOW_UNSEALED="${RESTORE_ALLOW_UNSEALED:-}"
STEP="reading $CROVE_DIR/.env"
load_env_file "$CROVE_DIR/.env"

BACKUP_DIR="${BACKUP_DIR:-$CROVE_DIR/.data/backups}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-crove}"
STORAGE="${STORAGE:-local}"
RESTORE_PRESTART="${RESTORE_PRESTART:-db}"
RESTORE_SAMPLE="${RESTORE_SAMPLE:-50}"
RESTORE_FILES_SERVICE="${RESTORE_FILES_SERVICE:-crove}"
RESTORE_READY_TIMEOUT="${RESTORE_READY_TIMEOUT:-600}"
RESTORE_FILES="${RESTORE_FILES:-copy}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
s3_host="${S3_ENDPOINT:-https://s3.amazonaws.com}"
s3_host="${s3_host#*://}"
s3_host="${s3_host%%/*}"
if [ "${s3_host%%:*}" = storage.googleapis.com ]; then RESTORE_GENERATIONS="${RESTORE_GENERATIONS:-content}"; fi
RESTORE_GENERATIONS="${RESTORE_GENERATIONS:-versions}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$BACKUP_DIR/restore-$STAMP"
LOG_FILE="$BACKUP_DIR/logs/restore-$STAMP.log"
PHASE_AT="$STARTED_AT"
PHASES=()

# Ends the current phase: records how long it took.
phase_done() {
  local now
  now="$(date +%s)"
  PHASES+=("$1: $((now - PHASE_AT)) s")
  log "$1 done in $((now - PHASE_AT)) s"
  PHASE_AT="$now"
}

STEP="settings"
case "$STORAGE" in local | s3) ;; *) STEP="settings: STORAGE must be local or s3, not $STORAGE"; false ;; esac
[[ "$RESTORE_SAMPLE" =~ ^[0-9]+$ ]] || { STEP="settings: RESTORE_SAMPLE must be a whole number"; false; }
case "$RESTORE_FILES" in copy | skip) ;; *) STEP="settings: RESTORE_FILES must be copy or skip"; false ;; esac
case "$RESTORE_GENERATIONS" in versions | content) ;; *) STEP="settings: RESTORE_GENERATIONS must be versions or content"; false ;; esac
[[ "$BACKUP_KEEP_DAYS" =~ ^[1-9][0-9]{0,3}$ ]] || { STEP="settings: BACKUP_KEEP_DAYS must be a whole number of days"; false; }
if [ "$STORAGE" = s3 ] && [ -z "${S3_BUCKET:-}" ]; then STEP="settings: S3_BUCKET is required with STORAGE=s3"; false; fi
if [[ "$SOURCE" == s3:* ]]; then
  for n in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
    [ -n "${!n:-}" ] || { STEP="settings: $n is required to restore $SOURCE"; false; }
  done
fi
set_mc_hosts

# The blobs go where the target stack reads them, and nowhere else. A STORAGE or S3_BUCKET here that differs from
# what the target compose project resolves (say, a scratch stack on STORAGE=local restored with production's
# STORAGE=s3 from .env) would write into a bucket the target does not use: the production bucket, where it would
# bring back erased blobs.
STEP="checking the target stack's storage"
stack_storage="$(stack_setting STORAGE)"
[ "$stack_storage" = "$STORAGE" ] ||
  { STEP="settings: STORAGE=$STORAGE here, but the target compose project uses STORAGE=$(echo $stack_storage) (set STORAGE to match)"; false; }
if [ "$STORAGE" = s3 ]; then
  stack_bucket="$(stack_setting S3_BUCKET)"
  [ "$stack_bucket" = "$S3_BUCKET" ] ||
    { STEP="settings: S3_BUCKET=$S3_BUCKET here, but the target compose project uses $(echo $stack_bucket) (set S3_BUCKET to match)"; false; }
fi

mkdir -p "$BACKUP_DIR/logs"
# Each restore gets a directory of its own: one started in the same second as another (or as a failed one, which
# keeps its downloaded run) waits for the next second instead of reading the other's files.
tries=0
until mkdir "$WORK" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -le 10 ] || { STEP="creating a restore directory in $BACKUP_DIR"; false; }
  sleep 1
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  WORK="$BACKUP_DIR/restore-$STAMP"
  LOG_FILE="$BACKUP_DIR/logs/restore-$STAMP.log"
done
chmod 700 "$BACKUP_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1
log "restoring $SOURCE onto compose project ${COMPOSE_PROJECT_NAME:-of $CROVE_DIR} (storage $STORAGE)"

# --- 1. The run ------------------------------------------------------------------------------------------------------
STEP="fetching the run"
remote='dst/$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX'
case "$SOURCE" in
  s3:*)
    RUN_ID="${SOURCE#s3:}"
    if [ "$RUN_ID" = latest ]; then
      # The newest complete run: SHA256SUMS (SHA256SUMS.enc when sealed) is uploaded last.
      mc_run "${BACKUP_S3_NETWORK:-}" "$WORK" "mc ls --recursive --json \"$remote/\"" </dev/null | mc_objects >"$WORK/bucket.tsv"
      RUN_ID="$(grep -o '^[0-9]\{8\}T[0-9]\{6\}Z/SHA256SUMS\(\.enc\)\?'$'\t' "$WORK/bucket.tsv" | cut -d/ -f1 | sort -r | head -1 || true)"
      [ -n "$RUN_ID" ] || { STEP="fetching the run: no complete run under $BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX"; false; }
    fi
    [[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { STEP="fetching the run: $RUN_ID is not a run id"; false; }
    export RUN_ID
    mc_run "${BACKUP_S3_NETWORK:-}" "$WORK" "mc mirror --quiet \"$remote/\$RUN_ID\" /work/fetched >/dev/null" </dev/null
    RUN="$WORK/$RUN_ID"
    if [ -f "$WORK/fetched/SHA256SUMS.enc" ]; then
      STEP="opening the sealed run (BACKUP_ENCRYPTION_KEY, or BACKUP_ENCRYPTION_KEY_PREVIOUS for a run sealed before a rotation)"
      [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || { STEP="opening the run: $RUN_ID is sealed; set BACKUP_ENCRYPTION_KEY to the key it was sealed with"; false; }
      SEALED=1
      : >"$WORK/open.list"
      (cd "$WORK/fetched" && find . -type f -printf '%P\n') >"$WORK/fetched.list"
      while IFS= read -r path; do
        [[ "$path" == *.enc ]] || { STEP="checking the run: $path in a sealed run is not sealed"; false; }
        printf '%s\t%s\t%s\n' "fetched/$path" "$RUN_ID/${path%.enc}" "$RUN_ID/${path%.enc}" >>"$WORK/open.list"
      done <"$WORK/fetched.list"
      seal_run "$WORK" open open.list
      rm -rf "$WORK/fetched"
    else
      # With a key set, runs in the bucket are sealed: an unsealed one there may have been written by whoever holds the
      # bucket's keys alone, and its dump would be restored unchecked. Only an explicit choice restores it: the
      # variable set on the command (not in .env) and the run named by its id (not s3:latest, which anyone who can
      # write to the bucket can point at a run of theirs).
      if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] && { [ "$ALLOW_UNSEALED" != yes ] || [ "$SOURCE" = s3:latest ]; }; then
        STEP="checking the run: $RUN_ID in the bucket is not sealed although BACKUP_ENCRYPTION_KEY is set; restore it only if you know it predates the key (RESTORE_ALLOW_UNSEALED=yes on the command, with s3:$RUN_ID)"
        false
      fi
      [ -z "${BACKUP_ENCRYPTION_KEY:-}" ] || log "WARNING: restoring the unsealed run $RUN_ID although BACKUP_ENCRYPTION_KEY is set (RESTORE_ALLOW_UNSEALED=yes)"
      SEALED=0
      mv "$WORK/fetched" "$RUN"
    fi
    ;;
  *)
    SEALED=0
    RUN="$(cd "$SOURCE" && pwd)"
    RUN_ID="${RUN##*/}"
    ;;
esac
[ -f "$RUN/SHA256SUMS" ] || { STEP="checking the run: no SHA256SUMS, the run is incomplete"; false; }
STEP="checking the run against its checksums"
(cd "$RUN" && sha256sum --quiet -c SHA256SUMS)
mkdir -p "$RUN/files"
# Org blobs of a run in a bucket live in the shared blob store its meta.env names: fetch the ones it lists.
if [[ "$SOURCE" == s3:* ]] && grep -q '^BLOB_STORE=' "$RUN/meta.env"; then
  STEP="fetching the org blobs the run lists"
  BLOB_STORE="$(meta_value BLOB_STORE "$RUN/meta.env")"
  [[ "$BLOB_STORE" =~ ^blobs/(plain|k[0-9a-f]{16})$ ]] || { STEP="checking the run: BLOB_STORE=$BLOB_STORE in meta.env is not a blob store"; false; }
  export BLOB_STORE
  : >"$WORK/fetch.list"
  : >"$WORK/open-blobs.list"
  while read -r _hash path; do
    path="${path#./}"
    [[ "$path" == org/*/* ]] && [ ! -f "$RUN/files/$path" ] || continue
    if [ "$SEALED" -eq 1 ]; then
      printf '%s\t%s\n' "$path" "blobs/$path" >>"$WORK/fetch.list"
      printf '%s\t%s\t%s\n' "blobs/$path" "$RUN_ID/files/$path" "blobs/$path" >>"$WORK/open-blobs.list"
    else
      printf '%s\t%s\n' "$path" "$RUN_ID/files/$path" >>"$WORK/fetch.list"
    fi
  done <"$RUN/files.sha256"
  if [ -s "$WORK/fetch.list" ]; then
    read -r -d '' fetch_script <<'SH' || true
tab=$(printf '\t')
while IFS="$tab" read -r key dest; do
  mc cp --quiet "dst/$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/$BLOB_STORE/$key" "/work/$dest" >/dev/null || exit 1
done </work/fetch.list
SH
    mc_run "${BACKUP_S3_NETWORK:-}" "$WORK" "$fetch_script" </dev/null
    if [ "$SEALED" -eq 1 ]; then
      seal_run "$WORK" open open-blobs.list
      rm -rf "$WORK/blobs"
    fi
  fi
  fetched="$(wc -l <"$WORK/fetch.list")"
  log "blobs: $fetched fetched from $BLOB_STORE"
fi
STEP="checking the blobs against files.sha256"
check_blob_sums "$RUN/files" "$RUN/files.sha256"
[ -z "$(content_address_mismatches <"$RUN/files.sha256")" ]
# Nothing the checksums do not cover may come along: a stray file under files/ would be copied into the store.
STEP="checking the run for files neither SHA256SUMS nor files.sha256 lists"
{ echo SHA256SUMS; awk '{print $2}' "$RUN/SHA256SUMS"; } | LC_ALL=C sort -u >"$WORK/listed-run"
(cd "$RUN" && find . -type f ! -path './files/*' -printf '%P\n') | LC_ALL=C sort | LC_ALL=C comm -23 - "$WORK/listed-run" >"$WORK/unlisted"
awk '{print $2}' "$RUN/files.sha256" | LC_ALL=C sort -u >"$WORK/listed-files"
(cd "$RUN/files" && find . -type f) | LC_ALL=C sort | LC_ALL=C comm -23 - "$WORK/listed-files" | sed 's|^\./|files/|' >>"$WORK/unlisted"
if [ -s "$WORK/unlisted" ]; then
  head -20 "$WORK/unlisted" | sed 's/^/  not listed: /'
  STEP="checking the run: $(wc -l <"$WORK/unlisted") file(s) that neither SHA256SUMS nor files.sha256 lists (above)"
  false
fi
STEP="reading meta.env"
BACKUP_STORAGE="$(meta_value STORAGE "$RUN/meta.env")"
finished_at="$(meta_value FINISHED_AT "$RUN/meta.env")"
schema_version="$(meta_value SCHEMA_VERSION "$RUN/meta.env")"
blob_count="$(wc -l <"$RUN/files.sha256")"
sealed=no
[ "$SEALED" -eq 0 ] || sealed=yes
log "run $RUN_ID ($finished_at, storage $BACKUP_STORAGE, schema $schema_version, sealed $sealed): checksums ok, $blob_count blob(s)"
phase_done "fetch and check"

# --- 2. Database -----------------------------------------------------------------------------------------------------
STEP="starting $RESTORE_PRESTART"
# shellcheck disable=SC2086
dc up -d --wait $RESTORE_PRESTART
STEP="checking that the target database is empty"
[ "$(db_psql -d postgres -tA -c "SELECT pg_catalog.to_regclass('crove_meta.schema_migrations') IS NULL")" = t ] ||
  { STEP="the target database already holds Crove: restore needs an empty database volume (a new project or docker compose down -v)"; false; }
STEP="loading the roles"
# The superuser exists in every cluster; every other role comes from the backup, without a password.
grep -v '^CREATE ROLE postgres;$' "$RUN/roles.sql" | db_psql -d postgres
STEP="loading the dump"
dc exec -T db sh -c 'rm -rf /tmp/crove-restore && mkdir -m 700 /tmp/crove-restore'
dc exec -T db sh -c 'cat > /tmp/crove-restore/db.dump' <"$RUN/db.dump"
inside="$(dc exec -T db sha256sum /tmp/crove-restore/db.dump | cut -d' ' -f1)"
outside="$(sha256sum <"$RUN/db.dump" | cut -d' ' -f1)"
[ "$inside" = "$outside" ] || { STEP="loading the dump: the copy in the db container differs"; false; }
# --create recreates the database with its own settings and grants (TEMPORARY revoked from PUBLIC and the rest).
dc exec -T db pg_restore -U postgres --clean --if-exists --create --exit-on-error -d template1 /tmp/crove-restore/db.dump
dc exec -T db rm -rf /tmp/crove-restore
phase_done "database restore"

# --- 3. Checks on the restored database ------------------------------------------------------------------------------
STEP="row counts"
db_psql -d postgres <<<"$COUNTS_SQL" >"$WORK/counts.restored.tsv"
if ! diff "$RUN/counts.tsv" "$WORK/counts.restored.tsv" >"$WORK/counts.diff"; then
  cat "$WORK/counts.diff"
  STEP="row counts: the restored tables differ from counts.tsv (see the diff above)"
  false
fi
rows="$(awk -F'\t' '{s += $2} END {print s + 0}' "$WORK/counts.restored.tsv")"
tables="$(wc -l <"$WORK/counts.restored.tsv")"
log "row counts match counts.tsv: $tables tables, $rows rows"
STEP="ledger stamps (docs/runbooks/ledger-after-restore.md)"
future="$(db_psql -d postgres -tA -c 'SELECT count(*) FROM crove_finance.journal_entry WHERE created_xact_start >= now()')"
[ "$future" = 0 ] || { STEP="ledger stamps: $future journal entries are stamped in the future of this cluster; fix the clock (NTP) first"; false; }
log "ledger: no journal entry stamped in the future"
STEP="new context key (docs/runbooks/context-key-rotation.md)"
db_psql -d postgres -tA -c 'SELECT crove_kernel.context_key_rotate()' >/dev/null
log "context key: a new key was made (the backup holds none)"
phase_done "database checks"

# --- 4. Files --------------------------------------------------------------------------------------------------------
STEP="restoring the files ($STORAGE)"
network=''
if [ "$RESTORE_FILES" = skip ]; then
  # The bucket survived the incident: its objects keep the versions the file rows recorded. Step 5 reads them.
  log "files: not restored (RESTORE_FILES=skip), the stack keeps using bucket ${S3_BUCKET:-of STORAGE=$STORAGE}"
  if [ "$STORAGE" = s3 ]; then network="${RESTORE_TARGET_NETWORK:-$(stack_network)}"; fi
elif [ "$STORAGE" = local ]; then
  tar -cf - -C "$RUN/files" . | dc run --rm --no-deps -T --entrypoint tar "$RESTORE_FILES_SERVICE" -xf - -C /data/files
else
  network="${RESTORE_TARGET_NETWORK:-$(stack_network)}"
  # The bucket must exist; with S3_VERSIONING=required (the default) it must keep versions. With
  # RESTORE_GENERATIONS=content (GCS) versions are neither switched on nor listed: on GCS, turn on object versioning
  # in the bucket's own settings.
  versioning=''
  list_versions=''
  if [ "$RESTORE_GENERATIONS" = versions ]; then
    [ "${S3_VERSIONING:-required}" = required ] && versioning='&& mc version enable "src/$S3_BUCKET" >/dev/null'
    list_versions='--versions'
  fi
  mc_run "$network" "$RUN" "{ mc stat \"src/\$S3_BUCKET\" >/dev/null 2>&1 || mc mb \"src/\$S3_BUCKET\" >/dev/null; } $versioning && mc mirror --quiet /work/files \"src/\$S3_BUCKET\" >/dev/null && mc ls --recursive $list_versions --json \"src/\$S3_BUCKET\"" </dev/null >"$WORK/objects.jsonl"

  STEP="pointing file rows at the restored object versions"
  # Each file row records the object version it was written as (ADR-0013). Restored objects have new version ids, so
  # rows whose generation names a version are updated to the version now under the same key, which holds the same
  # bytes (checked above against files.sha256, and below by reading back). Without a listed version (an unversioned
  # bucket, or RESTORE_GENERATIONS=content) the row gets content:<sha256>, read as the current object and checked by
  # sha256. file_guard refuses every change to a file row; session_replication_role = replica (superuser only) skips
  # it for this one transaction, which rolls back, changing nothing, when any row has no object.
  {
    cat <<'SQL'
BEGIN;
CREATE TEMP TABLE restored_object (line text);
COPY restored_object FROM STDIN WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02');
SQL
    cat "$WORK/objects.jsonl"
    printf '\\.\n'
    cat <<'SQL'
CREATE TEMP TABLE remap AS
  SELECT f.org_id, f.id, f.storage_key, f.generation AS old_generation,
         CASE WHEN coalesce(o.version_id, '') IN ('', 'null') THEN 'content:' || f.sha256 ELSE 's3:' || o.version_id END AS new_generation,
         o.key IS NOT NULL AS found
    FROM crove_kernel.file f
    LEFT JOIN (SELECT j->>'key' AS key, j->>'versionId' AS version_id
                 FROM (SELECT line::jsonb AS j FROM restored_object) s
                WHERE j->>'type' = 'file' AND coalesce((j->>'isLatest')::boolean, true)
                  AND NOT coalesce((j->>'isDeleteMarker')::boolean, false)) o ON o.key = f.storage_key
   WHERE f.generation LIKE 's3:%' OR f.generation LIKE 'gcs:%';
COPY (SELECT CASE WHEN found THEN 'remapped' ELSE 'MISSING' END, storage_key, old_generation, new_generation FROM remap
       WHERE NOT found OR old_generation IS DISTINCT FROM new_generation ORDER BY 1, 2) TO STDOUT;
SELECT CASE WHEN coalesce(bool_and(found), true) THEN 'true' ELSE 'false' END AS all_found FROM remap \gset
\if :all_found
SET LOCAL session_replication_role = replica;
UPDATE crove_kernel.file f SET generation = r.new_generation
  FROM remap r WHERE f.org_id = r.org_id AND f.id = r.id AND f.generation IS DISTINCT FROM r.new_generation;
COMMIT;
\else
ROLLBACK;
\endif
SQL
  } | db_psql -d postgres | { grep -E $'^(remapped|MISSING)\t' || true; } >"$WORK/generations.tsv"
  missing="$(grep -c '^MISSING' "$WORK/generations.tsv" || true)"
  [ "$missing" -eq 0 ] || { STEP="file rows: $missing row(s) have no object in bucket $S3_BUCKET, so no row was changed (see $WORK/generations.tsv)"; false; }
  remapped="$(wc -l <"$WORK/generations.tsv")"
  log "generations ($RESTORE_GENERATIONS): $remapped file row(s) pointed at the restored objects (list: $WORK/generations.tsv)"
fi
phase_done "file restore"

# --- 5. Blob sample --------------------------------------------------------------------------------------------------
STEP="reading back a sample of blobs"
limit=ALL
[ "$RESTORE_SAMPLE" -eq 0 ] || limit="$RESTORE_SAMPLE"
db_psql -d postgres -c "COPY (SELECT storage_key, sha256, coalesce(generation, '') FROM crove_kernel.file ORDER BY random() LIMIT $limit) TO STDOUT" >"$WORK/sample.tsv"
total_files="$(db_psql -d postgres -tA -c 'SELECT count(*) FROM crove_kernel.file')"
# Each line read back is the blob's sha256, or MISSING when there is no blob (never the hash of empty input, which a
# row of an empty file would match).
if [ "$STORAGE" = local ]; then
  cut -f1 "$WORK/sample.tsv" | dc run --rm --no-deps -T --entrypoint sh "$RESTORE_FILES_SERVICE" -c \
    'while read -r key; do if [ -f "/data/files/$key" ]; then sha256sum "/data/files/$key" | cut -d" " -f1; else echo MISSING; fi; done' >"$WORK/sample.read"
else
  # Each blob is read at its recorded version, as the kernel reads it (a gcs: generation, which mc cannot name, and
  # content: read the current object).
  read -r -d '' sample_script <<'SH' || true
tab=$(printf '\t')
while IFS="$tab" read -r key sha gen; do
  case "$gen" in
    s3:*) mc cat --version-id "${gen#s3:}" "src/$S3_BUCKET/$key" >/tmp/crove-blob 2>/dev/null ;;
    *) mc cat "src/$S3_BUCKET/$key" >/tmp/crove-blob 2>/dev/null ;;
  esac && sha256sum </tmp/crove-blob | cut -d' ' -f1 || echo MISSING
done </work/sample.tsv
rm -f /tmp/crove-blob
SH
  mc_run "$network" "$WORK" "$sample_script" </dev/null >"$WORK/sample.read"
fi
if ! diff <(cut -f2 "$WORK/sample.tsv") "$WORK/sample.read" >/dev/null; then
  paste "$WORK/sample.tsv" "$WORK/sample.read" | awk -F'\t' '$2 != $4 {print "  bad blob: " $1 ($4 == "MISSING" ? " (missing)" : " (wrong sha256)")}'
  STEP="blob sample: blobs missing or with the wrong sha256 (listed above)"
  false
fi
read_back="$(wc -l <"$WORK/sample.read")"
log "blobs: $read_back of $total_files file row(s) read back from the store with their sha256"
phase_done "blob check"

# --- 6. The stack ----------------------------------------------------------------------------------------------------
STEP="starting the stack"
services="$(dc config --services)"
api="${RESTORE_API_SERVICE:-}"
[ -n "$api" ] || { if grep -qx crove <<<"$services"; then api=crove; else api=api; fi; }
worker="${RESTORE_WORKER_SERVICE:-}"
[ -n "$worker" ] || { if grep -qx crove <<<"$services"; then worker=crove; else worker=worker; fi; }
deadline=$(($(date +%s) + RESTORE_READY_TIMEOUT))
# migrate first, alone: the exports below are re-recorded before the worker starts, so no export job the restored
# queue still holds can record a newer export that the re-record would then shadow.
dc up -d migrate
STEP="migrate (applies newer migrations, sets role passwords, runs the hardening guard)"
while :; do
  id="$(dc ps -a -q migrate)"
  state='none 0'
  [ -z "$id" ] || state="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$id")"
  case "$state" in
    'exited 0') break ;;
    exited*) dc logs --no-color migrate | tail -20; false ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || { STEP="migrate did not finish within $RESTORE_READY_TIMEOUT s"; false; }
  sleep 2
done
migrated="$(dc logs --no-color migrate | grep -o '\[migrate\] done, [0-9]* new migration(s)' | tail -1 || true)"
log "migrate: ${migrated:-done}"
# Org exports are recorded in audit rows, which keep the old object versions: after a restore into a new bucket they
# are re-recorded with the restored ones (kernel.org.export.record, as the worker), so they download again. The data
# is in place by now, so an org whose export cannot be re-recorded is reported and the restore goes on: its owner
# asks for a new export.
rebind_failed=0
if [ "$STORAGE" = s3 ] && [ "$RESTORE_FILES" = copy ]; then
  STEP="re-recording org exports with the restored object versions (main.ts exports-rebind)"
  orgs="$(db_psql -d postgres -tA -c "SELECT DISTINCT org_id FROM crove_kernel.audit_event WHERE command = 'kernel.org.export.record' AND outcome = 'ok' ORDER BY 1")"
  if [ -n "$orgs" ]; then
    # shellcheck disable=SC2086
    if ! dc run --rm --no-deps -T "$worker" exports-rebind $orgs </dev/null; then
      rebind_failed=1
      log "WARNING: some org exports could not be re-recorded (above); their owners ask for a new export (org.offboard again)"
    fi
  else
    log "exports: no org has an export to re-record"
  fi
fi
STEP="starting the stack"
dc up -d
STEP="waiting for /readyz on $api"
until ready="$(dc exec -T "$api" node -e "fetch('http://127.0.0.1:8080/readyz').then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))" 2>/dev/null)"; do
  [ "$(date +%s)" -lt "$deadline" ] || { STEP="/readyz did not answer ready within $RESTORE_READY_TIMEOUT s (last: ${ready:-no answer})"; false; }
  sleep 2
done
log "readyz: $ready"
phase_done "stack start"

STEP="cleaning up"
# The downloaded copy of the run is the whole database in plain text: it goes now, and restore directories older
# than BACKUP_KEEP_DAYS (a failed restore keeps its copy for diagnosis) go with the same cutoff as the runs. The log,
# counts, sample and generations.tsv stay in $WORK.
if [[ "$SOURCE" == s3:* ]]; then rm -rf "${WORK:?}/$RUN_ID"; fi
chmod -R go-rwx "$WORK"
cutoff="$(days_ago "$BACKUP_KEEP_DAYS")"
for dir in "$BACKUP_DIR"/restore-*; do
  name="${dir##*/restore-}"
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
  if [ "${name%%T*}" -lt "$cutoff" ]; then rm -rf "$dir" && log "deleted restore-$name (older than $BACKUP_KEEP_DAYS days)"; fi
done
for file in "$BACKUP_DIR"/logs/restore-*.log; do
  name="${file##*/restore-}"
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z\.log$ ]] || continue
  if [ "${name%%T*}" -lt "$cutoff" ]; then rm -f "$file"; fi
done

log "restore of $RUN_ID passed in $(($(date +%s) - STARTED_AT)) s: ${PHASES[*]/%/;}"
[ "$rebind_failed" -eq 0 ] || log "WARNING: some org exports were not re-recorded (see exports-rebind above): their owners ask for a new export"
log "before reopening writes: reconcile with the e-invoice providers (docs/runbooks/ledger-after-restore.md, step 4)"
