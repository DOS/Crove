#!/usr/bin/env bash
# Nightly backup of a Crove docker compose stack (issue #307). Runbook: docs/runbooks/backup-and-restore.md.
#
# One run writes <BACKUP_DIR>/<run id>/ (the run id is the UTC start time, 20261017T020000Z):
#   db.dump       pg_dump --format=custom of the whole database: every Crove schema, Supabase Auth's `auth` schema,
#                 the crove_jobs queue and the migration ledger. The rows of crove_kernel.context_key are left out:
#                 a restore makes a new key (docs/runbooks/context-key-rotation.md).
#   roles.sql     the cluster's roles, memberships and role settings, without passwords (migrate sets them again)
#   counts.tsv    the row count of every table, read in the same snapshot as the dump
#   file-refs.tsv every file row's (storage key, sha256, generation), from the same snapshot
#   files/        every blob: the `files` volume (STORAGE=local) or the bucket's current objects (STORAGE=s3),
#                 without staging/ uploads and temporary files
#   files.sha256  the sha256 of every blob; each file row's blob must be there with its sha256, or the run fails
#   meta.env      when, from which stack and schema version
#   SHA256SUMS    the sha256 of every file above except files/ (covered by files.sha256); written last
# and logs to <BACKUP_DIR>/logs/<run id>.log.
# It is written as <run id>.partial and renamed when complete. With BACKUP_S3_ENDPOINT set the run is then copied to
# that bucket (any S3-compatible store; SHA256SUMS is copied last, so a run without it is incomplete) and checked
# there. Runs older than BACKUP_KEEP_DAYS are deleted in both places.
#
# Exit 0 on success. On failure: `[backup] FAILED: <reason>` on stderr, an alert through the prober
# (`prober --backup-failed`, the same ALERT_WEBHOOK_URL as every other alert; BACKUP_ALERT=off turns it off) and
# exit 1.
#
# Settings come from the environment, then from $CROVE_DIR/.env (see .env.example, "Backups"):
#   CROVE_DIR                directory of docker-compose.yml and .env (default: this checkout)
#   BACKUP_DIR               where runs are written (default: $CROVE_DIR/.data/backups)
#   BACKUP_KEEP_DAYS         days a run is kept in BACKUP_DIR and in the bucket (default 30)
#   BACKUP_LOCAL_KEEP_DAYS   days a run is kept in BACKUP_DIR when a bucket is set (default BACKUP_KEEP_DAYS)
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (default crove), BACKUP_S3_ACCESS_KEY_ID,
#   BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_NETWORK (Docker network of the client container; default Docker's)
#   BACKUP_FILES_SERVICE     with STORAGE=local, the service that mounts the files volume (default crove)
#   BACKUP_ALERT             prober (default) or off
#   STORAGE, S3_*            the stack's own storage settings
set -Eeuo pipefail
LOG_TAG=backup
# shellcheck source=tools/backup/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env_file "$CROVE_DIR/.env"

BACKUP_DIR="${BACKUP_DIR:-$CROVE_DIR/.data/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
BACKUP_LOCAL_KEEP_DAYS="${BACKUP_LOCAL_KEEP_DAYS:-$BACKUP_KEEP_DAYS}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-crove}"
BACKUP_FILES_SERVICE="${BACKUP_FILES_SERVICE:-crove}"
BACKUP_ALERT="${BACKUP_ALERT:-prober}"
STORAGE="${STORAGE:-local}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export RUN_ID
RUN="$BACKUP_DIR/$RUN_ID"
PARTIAL="$RUN.partial"
LOCK="$BACKUP_DIR/.lock"
LOG_FILE="$BACKUP_DIR/logs/$RUN_ID.log"
STEP=setup
REPORTED=0

alert() {
  [ "$BACKUP_ALERT" = off ] && return 0
  dc run --rm --no-deps -T prober prober --backup-failed "$1" </dev/null || log "the backup alert could not be sent (see above)"
}

# Every failure ends here once: the log line, the alert, the lock released.
report_failure() {
  REPORTED=1
  trap - ERR
  printf '[backup] FAILED: %s\n' "$1" >&2
  alert "$1"
  [ -d "$LOCK" ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
  return 0
}

on_error() {
  local status=$? line=$1
  # A failure inside a command substitution reaches the main shell as well: report it once, there.
  [ "$BASH_SUBSHELL" -gt 0 ] && exit "$status"
  report_failure "$STEP failed (exit $status, backup.sh line $line); run $RUN_ID, log $LOG_FILE"
  exit 1
}
trap 'on_error $LINENO' ERR

# Anything that ends the script without passing through on_error (a shell error such as an unset variable under
# set -u, a signal) is reported here, so no failure stays silent.
on_exit() {
  local status=$?
  [ "$BASH_SUBSHELL" -gt 0 ] && return
  if [ "$status" -ne 0 ] && [ "$REPORTED" -eq 0 ]; then
    report_failure "backup.sh stopped with exit $status during: $STEP; run $RUN_ID, log $LOG_FILE"
  fi
}
trap on_exit EXIT

STEP="settings"
case "$STORAGE" in local | s3) ;; *) STEP="settings: STORAGE must be local or s3, not $STORAGE"; false ;; esac
for n in BACKUP_KEEP_DAYS BACKUP_LOCAL_KEEP_DAYS; do
  [[ "${!n}" =~ ^[1-9][0-9]{0,3}$ ]] || { STEP="settings: $n must be a whole number of days"; false; }
done
if [ "$STORAGE" = s3 ] && [ -z "${S3_BUCKET:-}" ]; then STEP="settings: S3_BUCKET is required with STORAGE=s3"; false; fi
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  for n in BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
    [ -n "${!n:-}" ] || { STEP="settings: $n is required with BACKUP_S3_ENDPOINT"; false; }
  done
fi
set_mc_hosts

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STEP="taking the lock $LOCK (another backup running?)"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  # A lock left by a run that died (a reboot) is taken over; a live one is not.
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then false; fi
  rm -rf "$LOCK"
  mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"

mkdir -p "$PARTIAL/files" "$BACKUP_DIR/logs"
exec > >(tee -a "$LOG_FILE") 2>&1
log "run $RUN_ID into $BACKUP_DIR (storage $STORAGE)"

# --- Database: one REPEATABLE READ snapshot for the dump, the counts and the file references ------------------------
STEP="database dump"
dc exec -T db sh -c 'rm -rf /tmp/crove-backup && mkdir -m 700 /tmp/crove-backup'
# pg_dump runs inside the exported snapshot while this transaction holds it, so the counts and file references are
# exactly what the dump contains.
db_psql -d postgres <<SQL
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_catalog.pg_export_snapshot() AS snapshot \gset
\setenv CROVE_SNAPSHOT :snapshot
\! pg_dump -U postgres -d postgres --format=custom --snapshot="\$CROVE_SNAPSHOT" --exclude-table-data=crove_kernel.context_key --file=/tmp/crove-backup/db.dump && touch /tmp/crove-backup/dump.ok
$COUNTS_SQL \g /tmp/crove-backup/counts.tsv
$FILE_REFS_SQL \g /tmp/crove-backup/file-refs.tsv
COMMIT;
SQL
dc exec -T db test -f /tmp/crove-backup/dump.ok
dc exec -T db pg_restore --list /tmp/crove-backup/db.dump >/dev/null
for f in db.dump counts.tsv file-refs.tsv; do
  dc exec -T db cat "/tmp/crove-backup/$f" >"$PARTIAL/$f"
  inside="$(dc exec -T db sha256sum "/tmp/crove-backup/$f" | cut -d' ' -f1)"
  [ "$inside" = "$(sha256sum <"$PARTIAL/$f" | cut -d' ' -f1)" ] || { STEP="copying $f out of the db container (checksum differs)"; false; }
done
dc exec -T db rm -rf /tmp/crove-backup
dc exec -T db pg_dumpall -U postgres --roles-only --no-role-passwords >"$PARTIAL/roles.sql"
grep -q 'CREATE ROLE crove_app' "$PARTIAL/roles.sql" || { STEP="roles dump (no crove_app role)"; false; }
log "database: $(du -h "$PARTIAL/db.dump" | cut -f1) dump, $(wc -l <"$PARTIAL/counts.tsv") tables, $(wc -l <"$PARTIAL/file-refs.tsv") file rows"

# --- Files ----------------------------------------------------------------------------------------------------------
STEP="file copy ($STORAGE)"
if [ "$STORAGE" = local ]; then
  dc exec -T "$BACKUP_FILES_SERVICE" tar -C /data/files --exclude='*.tmp' -cf - . | tar -xf - -C "$PARTIAL/files"
else
  network="${BACKUP_SOURCE_NETWORK:-$(stack_network)}"
  mc_run "$network" "$PARTIAL" "mc mirror --quiet --exclude 'staging/*' \"src/\$S3_BUCKET\" /work/files >/dev/null" </dev/null
fi
STEP="file checksums"
(cd "$PARTIAL/files" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) | normalize_sums >"$PARTIAL/files.sha256"
bad="$(content_address_mismatches <"$PARTIAL/files.sha256")"
[ -z "$bad" ] || { STEP="file checksums: blobs whose bytes do not match their content address: $(echo "$bad" | head -5 | tr '\n' ' ')"; false; }
# Every file row of the snapshot must have its blob, with its sha256, in the copy.
missing=0
while IFS=$'\t' read -r key sha _generation; do
  [ -n "$key" ] || continue
  grep -q "^$sha  ./$key\$" "$PARTIAL/files.sha256" || { missing=$((missing + 1)); log "missing blob: $key"; }
done <"$PARTIAL/file-refs.tsv"
[ "$missing" -eq 0 ] || { STEP="file copy: $missing file row(s) have no blob with their sha256 in the copy"; false; }
log "files: $(wc -l <"$PARTIAL/files.sha256") blob(s), $(du -sh "$PARTIAL/files" | cut -f1)"

# --- Manifest -------------------------------------------------------------------------------------------------------
STEP="manifest"
ledger="$(db_psql -d postgres -tA -c 'SELECT max(version) FROM crove_meta.schema_migrations')"
{
  echo "RUN_ID=$RUN_ID"
  echo "FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "STORAGE=$STORAGE"
  echo "SCHEMA_VERSION=$ledger"
  echo "POSTGRES_VERSION=$(db_psql -d postgres -tA -c 'SHOW server_version')"
  echo "COMPOSE_PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$(dc ps -q db)")"
} >"$PARTIAL/meta.env"
(cd "$PARTIAL" && sha256sum db.dump roles.sql counts.tsv file-refs.tsv files.sha256 meta.env) | normalize_sums >"$PARTIAL/SHA256SUMS"
# The umask covers what this script writes; tar run as root keeps the modes of the archive, so close those too.
chmod -R go-rwx "$PARTIAL" "$BACKUP_DIR/logs"
mv "$PARTIAL" "$RUN"
log "complete: $RUN"

# --- Second location ------------------------------------------------------------------------------------------------
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  STEP="upload to the backup bucket"
  dest='dst/$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/$RUN_ID'
  # A run that does not read back whole is deleted from the bucket, so s3:latest never picks it.
  remove_remote_run() {
    mc_run "${BACKUP_S3_NETWORK:-}" "$RUN" "mc rm --quiet --recursive --force \"$dest/\" >/dev/null" </dev/null ||
      log "could not delete the incomplete run $RUN_ID from the backup bucket; delete it by hand"
  }
  if ! mc_run "${BACKUP_S3_NETWORK:-}" "$RUN" "mc mirror --quiet --exclude SHA256SUMS /work \"$dest\" >/dev/null && mc cp --quiet /work/SHA256SUMS \"$dest/SHA256SUMS\" >/dev/null && mc cat \"$dest/SHA256SUMS\"" </dev/null >"$BACKUP_DIR/.remote-sums" ||
    ! cmp -s "$BACKUP_DIR/.remote-sums" "$RUN/SHA256SUMS"; then
    remove_remote_run
    STEP="upload to the backup bucket: the upload failed or SHA256SUMS read back differs"
    false
  fi
  rm -f "$BACKUP_DIR/.remote-sums"
  remote_count="$(mc_run "${BACKUP_S3_NETWORK:-}" "$RUN" "mc ls --recursive \"$dest/\" | wc -l" </dev/null)"
  local_count="$(cd "$RUN" && find . -type f | wc -l)"
  if [ "$((remote_count))" -ne "$((local_count))" ]; then
    remove_remote_run
    STEP="upload to the backup bucket: $remote_count object(s) there, $local_count file(s) here"
    false
  fi
  log "uploaded to $BACKUP_S3_ENDPOINT, bucket $BACKUP_S3_BUCKET, prefix $BACKUP_S3_PREFIX/$RUN_ID ($remote_count objects)"

  STEP="pruning the backup bucket"
  cutoff="$(days_ago "$BACKUP_KEEP_DAYS")"
  old="$(mc_run "${BACKUP_S3_NETWORK:-}" "$RUN" "mc ls \"dst/\$BACKUP_S3_BUCKET/\$BACKUP_S3_PREFIX/\"" </dev/null |
    grep -o '[0-9]\{8\}T[0-9]\{6\}Z/$' | tr -d / | while read -r id; do [ "${id%%T*}" -lt "$cutoff" ] && echo "$id"; done || true)"
  for id in $old; do
    mc_run "${BACKUP_S3_NETWORK:-}" "$RUN" "mc rm --quiet --recursive --force \"dst/\$BACKUP_S3_BUCKET/\$BACKUP_S3_PREFIX/$id/\"" </dev/null
    log "deleted $id from the backup bucket (older than $BACKUP_KEEP_DAYS days)"
  done
  keep_local="$BACKUP_LOCAL_KEEP_DAYS"
else
  keep_local="$BACKUP_KEEP_DAYS"
fi

# --- Local retention ------------------------------------------------------------------------------------------------
STEP="pruning $BACKUP_DIR"
cutoff="$(days_ago "$keep_local")"
for dir in "$BACKUP_DIR"/*; do
  name="${dir##*/}"
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z(\.partial)?$ ]] || continue
  [ "$name" = "$RUN_ID" ] && continue
  # A .partial run is one that failed; the lock rules out one in progress.
  if [[ "$name" == *.partial ]] || [ "${name%%T*}" -lt "$cutoff" ]; then
    rm -rf "$dir"
    log "deleted $name from $BACKUP_DIR"
  fi
done
# Directories restore.sh left (a failed restore keeps its downloaded copy of a run) follow the same cutoff.
for dir in "$BACKUP_DIR"/restore-*; do
  name="${dir##*/restore-}"
  [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
  if [ "${name%%T*}" -lt "$cutoff" ]; then
    rm -rf "$dir"
    log "deleted restore-$name from $BACKUP_DIR"
  fi
done
for file in "$BACKUP_DIR"/logs/*.log; do
  name="${file##*/}"
  [[ "$name" =~ ^(restore-)?[0-9]{8}T[0-9]{6}Z\.log$ ]] || continue
  name="${name#restore-}"
  [ "${name%%T*}" -lt "$cutoff" ] && rm -f "$file"
done

rm -rf "$LOCK"
log "done in $(($(date +%s) - STARTED_AT)) s"
