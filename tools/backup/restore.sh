#!/usr/bin/env bash
# Restores a backup made by backup.sh onto a fresh Crove stack and verifies it (issue #307). Runbook:
# docs/runbooks/backup-and-restore.md.
#
#   tools/backup/restore.sh <run>      <run> is a run directory, s3:<run id> or s3:latest (from BACKUP_S3_*)
#
# The target is the compose stack that CROVE_DIR, COMPOSE_PROJECT_NAME, COMPOSE_FILE and .env name, with an empty
# database volume: the script refuses a database that already holds Crove. Steps:
#   1. check the run against SHA256SUMS and files.sha256;
#   2. start RESTORE_PRESTART (default: db), load the roles and pg_restore the dump (pg_restore --create, so the
#      database's own settings and grants come back too);
#   3. compare the row count of every table with counts.tsv; check that no journal entry is stamped in the future
#      of this cluster (docs/runbooks/ledger-after-restore.md); make a new context key (the backup has none);
#   4. put the blobs back: into the files volume (STORAGE=local) or the bucket (STORAGE=s3). In a bucket every
#      object gets a new version id, so each file row's recorded generation is pointed at the restored version
#      (a superuser update past the file_guard trigger, listed in the restore log); the sha256 is unchanged;
#      RESTORE_FILES=skip leaves the files alone, for a bucket that survived the incident;
#   5. read back RESTORE_SAMPLE blobs (default 50, 0 for all) named by restored file rows and check their sha256;
#   6. start the whole stack: migrate must succeed (it applies migrations newer than the backup, sets the role
#      passwords and runs the hardening guard), then /readyz must answer ready.
# Exit 0 when everything passed; otherwise `[restore] FAILED: <reason>` and exit 1. The log goes to stdout and to
# <BACKUP_DIR>/logs/restore-<time>.log.
#
# Settings (environment, then $CROVE_DIR/.env): STORAGE and S3_* of the target stack, BACKUP_DIR, BACKUP_S3_* (for
# s3:<run>), RESTORE_PRESTART, RESTORE_SAMPLE, RESTORE_FILES_SERVICE (default crove), RESTORE_API_SERVICE (default
# crove when the stack defines it, else api), RESTORE_READY_TIMEOUT (seconds, default 600).
set -Eeuo pipefail
LOG_TAG=restore
# shellcheck source=tools/backup/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env_file "$CROVE_DIR/.env"

SOURCE="${1:?usage: restore.sh <run directory | s3:<run id> | s3:latest>}"
BACKUP_DIR="${BACKUP_DIR:-$CROVE_DIR/.data/backups}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-crove}"
STORAGE="${STORAGE:-local}"
RESTORE_PRESTART="${RESTORE_PRESTART:-db}"
RESTORE_SAMPLE="${RESTORE_SAMPLE:-50}"
RESTORE_FILES_SERVICE="${RESTORE_FILES_SERVICE:-crove}"
RESTORE_READY_TIMEOUT="${RESTORE_READY_TIMEOUT:-600}"
RESTORE_FILES="${RESTORE_FILES:-copy}"
S3_PATH="$(s3_path_style)"
export BACKUP_S3_PREFIX S3_PATH S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET \
  BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$BACKUP_DIR/restore-$STAMP"
LOG_FILE="$BACKUP_DIR/logs/restore-$STAMP.log"
STEP=setup
PHASE_AT="$STARTED_AT"
PHASES=()

on_error() {
  local status=$? line=$1
  [ "$BASH_SUBSHELL" -gt 0 ] && exit "$status"
  trap - ERR
  printf '[restore] FAILED: %s (exit %s, restore.sh line %s); log %s\n' "$STEP" "$status" "$line" "$LOG_FILE" >&2
  exit 1
}
trap 'on_error $LINENO' ERR

# Ends the current phase: records how long it took.
phase_done() {
  local now
  now="$(date +%s)"
  PHASES+=("$1: $((now - PHASE_AT)) s")
  log "$1 done in $((now - PHASE_AT)) s"
  PHASE_AT="$now"
}

case "$STORAGE" in local | s3) ;; *) STEP="settings: STORAGE must be local or s3, not $STORAGE"; false ;; esac
[[ "$RESTORE_SAMPLE" =~ ^[0-9]+$ ]] || { STEP="settings: RESTORE_SAMPLE must be a whole number"; false; }
case "$RESTORE_FILES" in copy | skip) ;; *) STEP="settings: RESTORE_FILES must be copy or skip"; false ;; esac
mkdir -p "$WORK" "$BACKUP_DIR/logs"
exec > >(tee -a "$LOG_FILE") 2>&1
log "restoring $SOURCE onto compose project ${COMPOSE_PROJECT_NAME:-of $CROVE_DIR} (storage $STORAGE)"

# --- 1. The run ------------------------------------------------------------------------------------------------------
STEP="fetching the run"
case "$SOURCE" in
  s3:*)
    : "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required for $SOURCE}" "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
    RUN_ID="${SOURCE#s3:}"
    if [ "$RUN_ID" = latest ]; then
      # The newest complete run: SHA256SUMS is uploaded last.
      RUN_ID=""
      for id in $(mc_run "${BACKUP_S3_NETWORK:-}" "$WORK" "$MC_ALIAS_DST && mc ls \"dst/\$BACKUP_S3_BUCKET/\$BACKUP_S3_PREFIX/\"" </dev/null |
        grep -o '[0-9]\{8\}T[0-9]\{6\}Z/$' | tr -d / | sort -r); do
        if mc_run "${BACKUP_S3_NETWORK:-}" "$WORK" "$MC_ALIAS_DST && mc stat \"dst/\$BACKUP_S3_BUCKET/\$BACKUP_S3_PREFIX/$id/SHA256SUMS\" >/dev/null 2>&1" </dev/null; then
          RUN_ID="$id"
          break
        fi
      done
      [ -n "$RUN_ID" ] || { STEP="fetching the run: no complete run under $BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX"; false; }
    fi
    [[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { STEP="fetching the run: $RUN_ID is not a run id"; false; }
    export RUN_ID
    mc_run "${BACKUP_S3_NETWORK:-}" "$WORK" "$MC_ALIAS_DST && mc mirror --quiet \"dst/\$BACKUP_S3_BUCKET/\$BACKUP_S3_PREFIX/\$RUN_ID\" \"/work/\$RUN_ID\" >/dev/null" </dev/null
    RUN="$WORK/$RUN_ID"
    ;;
  *)
    RUN="$(cd "$SOURCE" && pwd)"
    RUN_ID="${RUN##*/}"
    ;;
esac
STEP="checking the run against its checksums"
[ -f "$RUN/SHA256SUMS" ] || { STEP="checking the run: no SHA256SUMS, the run is incomplete"; false; }
(cd "$RUN" && sha256sum --quiet -c SHA256SUMS)
mkdir -p "$RUN/files"
(cd "$RUN/files" && sha256sum --quiet -c ../files.sha256)
[ -z "$(content_address_mismatches <"$RUN/files.sha256")" ]
BACKUP_STORAGE="$(grep '^STORAGE=' "$RUN/meta.env" | cut -d= -f2)"
log "run $RUN_ID ($(grep '^FINISHED_AT=' "$RUN/meta.env" | cut -d= -f2), storage $BACKUP_STORAGE, schema $(grep '^SCHEMA_VERSION=' "$RUN/meta.env" | cut -d= -f2)): checksums ok, $(wc -l <"$RUN/files.sha256") blob(s)"
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
[ "$(dc exec -T db sha256sum /tmp/crove-restore/db.dump | cut -d' ' -f1)" = "$(sha256sum <"$RUN/db.dump" | cut -d' ' -f1)" ]
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
log "row counts match counts.tsv: $(wc -l <"$WORK/counts.restored.tsv") tables, $rows rows"
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
if [ "$RESTORE_FILES" = skip ]; then
  # The bucket survived the incident: its objects keep the versions the file rows recorded. Step 5 reads them.
  log "files: not restored (RESTORE_FILES=skip), the stack keeps using bucket ${S3_BUCKET:-of STORAGE=$STORAGE}"
  network="${RESTORE_TARGET_NETWORK:-$( [ "$STORAGE" = s3 ] && stack_network || true)}"
elif [ "$STORAGE" = local ]; then
  tar -cf - -C "$RUN/files" . | dc run --rm --no-deps -T --entrypoint tar "$RESTORE_FILES_SERVICE" -xf - -C /data/files
else
  : "${S3_BUCKET:?S3_BUCKET is required with STORAGE=s3}"
  network="${RESTORE_TARGET_NETWORK:-$(stack_network)}"
  # The bucket must exist; with S3_VERSIONING=required (the default) it must keep versions.
  versioning=''
  [ "${S3_VERSIONING:-required}" = required ] && versioning='&& mc version enable "src/$S3_BUCKET" >/dev/null'
  mc_run "$network" "$RUN" "$MC_ALIAS_SRC && { mc stat \"src/\$S3_BUCKET\" >/dev/null 2>&1 || mc mb \"src/\$S3_BUCKET\" >/dev/null; } $versioning && mc mirror --quiet /work/files \"src/\$S3_BUCKET\" >/dev/null && mc ls --recursive --versions --json \"src/\$S3_BUCKET\"" </dev/null >"$WORK/objects.jsonl"

  STEP="pointing file rows at the restored object versions"
  # Each file row records the object version it was written as (ADR-0013). Restored objects have new version ids, so
  # rows whose generation names a version are updated to the version now under the same key, which holds the same
  # bytes (checked above against files.sha256, and below by reading back). file_guard refuses every change to a
  # file row; session_replication_role = replica (superuser only) skips it for this one transaction.
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
SET LOCAL session_replication_role = replica;
UPDATE crove_kernel.file f SET generation = r.new_generation
  FROM remap r WHERE r.found AND f.org_id = r.org_id AND f.id = r.id AND f.generation IS DISTINCT FROM r.new_generation;
COPY (SELECT CASE WHEN found THEN 'remapped' ELSE 'MISSING' END, storage_key, old_generation, new_generation FROM remap
       WHERE NOT found OR old_generation IS DISTINCT FROM new_generation ORDER BY 1, 2) TO STDOUT;
COMMIT;
SQL
  } | db_psql -d postgres | { grep -E $'^(remapped|MISSING)\t' || true; } >"$WORK/generations.tsv"
  missing="$(grep -c '^MISSING' "$WORK/generations.tsv" || true)"
  [ "$missing" -eq 0 ] || { STEP="file rows: $missing row(s) have no object in bucket $S3_BUCKET (see $WORK/generations.tsv)"; false; }
  log "generations: $(wc -l <"$WORK/generations.tsv") file row(s) pointed at the restored object versions (list: $WORK/generations.tsv)"
fi
phase_done "file restore"

# --- 5. Blob sample --------------------------------------------------------------------------------------------------
STEP="reading back a sample of blobs"
limit="$([ "$RESTORE_SAMPLE" -eq 0 ] && echo ALL || echo "$RESTORE_SAMPLE")"
db_psql -d postgres -c "COPY (SELECT storage_key, sha256, coalesce(generation, '') FROM crove_kernel.file ORDER BY random() LIMIT $limit) TO STDOUT" >"$WORK/sample.tsv"
total_files="$(db_psql -d postgres -tA -c 'SELECT count(*) FROM crove_kernel.file')"
if [ "$STORAGE" = local ]; then
  # A missing blob prints no hash, so its line is empty and the comparison below fails.
  cut -f1 "$WORK/sample.tsv" | dc run --rm --no-deps -T --entrypoint sh "$RESTORE_FILES_SERVICE" -c \
    'while read -r key; do echo "$(sha256sum "/data/files/$key" | cut -d" " -f1)"; done' >"$WORK/sample.read"
else
  # Each blob is read at its recorded version, as the kernel reads it. A missing one hashes as empty input.
  read -r -d '' sample_script <<'SH' || true
tab=$(printf '\t')
while IFS="$tab" read -r key sha gen; do
  case "$gen" in
    s3:*) mc cat --version-id "${gen#s3:}" "src/$S3_BUCKET/$key" ;;
    *) mc cat "src/$S3_BUCKET/$key" ;;
  esac | sha256sum | cut -d' ' -f1
done </work/sample.tsv
SH
  mc_run "$network" "$WORK" "$MC_ALIAS_SRC && $sample_script" </dev/null >"$WORK/sample.read"
fi
if ! diff <(cut -f2 "$WORK/sample.tsv") "$WORK/sample.read" >/dev/null; then
  paste "$WORK/sample.tsv" "$WORK/sample.read" | awk -F'\t' '$2 != $4 {print "  bad blob: " $1}'
  STEP="blob sample: blobs missing or with the wrong sha256 (listed above)"
  false
fi
log "blobs: $(wc -l <"$WORK/sample.read") of $total_files file row(s) read back from the store with their sha256"
phase_done "blob check"

# --- 6. The stack ----------------------------------------------------------------------------------------------------
STEP="starting the stack"
dc up -d
api="${RESTORE_API_SERVICE:-$(dc config --services | grep -qx crove && echo crove || echo api)}"
deadline=$(($(date +%s) + RESTORE_READY_TIMEOUT))
STEP="migrate (applies newer migrations, sets role passwords, runs the hardening guard)"
while :; do
  id="$(dc ps -a -q migrate)"
  state="$([ -n "$id" ] && docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$id" || echo 'none 0')"
  case "$state" in
    'exited 0') break ;;
    exited*) dc logs --no-color migrate | tail -20; false ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || { STEP="migrate did not finish within $RESTORE_READY_TIMEOUT s"; false; }
  sleep 2
done
log "migrate: $(dc logs --no-color migrate | grep -o '\[migrate\] done, [0-9]* new migration(s)' | tail -1)"
STEP="waiting for /readyz on $api"
until ready="$(dc exec -T "$api" node -e "fetch('http://127.0.0.1:8080/readyz').then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))" 2>/dev/null)"; do
  [ "$(date +%s)" -lt "$deadline" ] || { STEP="/readyz did not answer ready within $RESTORE_READY_TIMEOUT s (last: ${ready:-no answer})"; false; }
  sleep 2
done
log "readyz: $ready"
phase_done "stack start"

log "restore of $RUN_ID passed in $(($(date +%s) - STARTED_AT)) s: ${PHASES[*]/%/;}"
log "before reopening writes: reconcile with the e-invoice providers (docs/runbooks/ledger-after-restore.md, step 4)"
