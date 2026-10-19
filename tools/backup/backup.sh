#!/usr/bin/env bash
# Nightly backup of a Crove docker compose stack (issues #307, #351). Runbook: docs/runbooks/backup-and-restore.md.
#
# One run writes <BACKUP_DIR>/<run id>/ (the run id is the UTC start time, 20261017T020000Z):
#   db.dump       pg_dump --format=custom of the whole database: every Crove schema, Supabase Auth's `auth` schema,
#                 the crove_jobs queue and the migration ledger. The rows of crove_kernel.context_key are left out:
#                 a restore makes a new key (docs/runbooks/context-key-rotation.md).
#   roles.sql     the cluster's roles, memberships and role settings, without passwords (migrate sets them again)
#   counts.tsv    the row count of every table, read in the same snapshot as the dump
#   file-refs.tsv every file row's (storage key, sha256, generation), from the same snapshot
#   files/        every blob: the `files` volume (STORAGE=local) or the bucket's current objects (STORAGE=s3),
#                 without staging/ uploads and temporary files. An org blob the previous run already holds is a hard
#                 link to it (org blobs are content addressed), so a run costs disk only for new blobs.
#   files.sha256  the sha256 of every blob; each file row's blob must be there with its sha256, or the run fails
#   meta.env      when, from which stack, schema and PostgreSQL version (read in the dump's snapshot), and the layout
#                 of the copy in the bucket
#   SHA256SUMS    the sha256 of every file above except files/ (covered by files.sha256); written last
# and logs to <BACKUP_DIR>/logs/<run id>.log.
# It is written as <run id>.partial and renamed when complete. With BACKUP_S3_ENDPOINT set the run is then copied to
# that bucket (any S3-compatible store) and checked there:
#   <prefix>/<run id>/          the run's files, without the org blobs; SHA256SUMS is copied last, so a run without it
#                               is incomplete
#   <prefix>/blobs/<store>/org/ the org blobs, each uploaded once and shared by every run that lists it (only blobs
#                               the store does not hold yet are sent); <store> is `plain`, or `k<key id>` when sealed
# With BACKUP_ENCRYPTION_KEY set every file in the bucket is sealed first (tools/backup/seal.mjs, AES-256-GCM; the
# run's files get a .enc suffix), so the bucket alone does not expose the books. Runs older than BACKUP_KEEP_DAYS are
# deleted in both places, then the blobs no kept run lists. A complete run writes <BACKUP_DIR>/last-success and pings
# BACKUP_HEARTBEAT_URL through the prober (`prober --backup-ok`), so an outside monitor pages when runs stop.
#
# Exit 0 on success. On failure: `[backup] FAILED: <reason>` on stderr, an alert through the prober
# (`prober --backup-failed`, the same ALERT_WEBHOOK_URL as every other alert; BACKUP_ALERT=off turns it off) and
# exit 1. A deployment (PUBLIC_URL not on localhost) without BACKUP_S3_ENDPOINT keeps its run but fails the same way:
# a copy on the same disk is not a backup.
#
# Settings come from the environment, then from $CROVE_DIR/.env, read as docker compose reads it (see .env.example,
# "Backups"):
#   CROVE_DIR                directory of docker-compose.yml and .env (default: this checkout)
#   BACKUP_DIR               where runs are written (default: $CROVE_DIR/.data/backups)
#   BACKUP_KEEP_DAYS         days a run is kept in BACKUP_DIR and in the bucket (default 30)
#   BACKUP_LOCAL_KEEP_DAYS   days a run is kept in BACKUP_DIR when a bucket is set (default BACKUP_KEEP_DAYS)
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (default crove), BACKUP_S3_ACCESS_KEY_ID,
#   BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_NETWORK (Docker network of the client container; default Docker's)
#   BACKUP_ENCRYPTION_KEY    32 random bytes (base64 or hex): seals what goes to the bucket; keep a copy apart from it
#   BACKUP_ENCRYPTION_KEY_PREVIOUS  the key before a rotation, until the runs it sealed are gone
#   BACKUP_HEARTBEAT_URL     an outside heartbeat monitor's ping URL, pinged after each complete run
#   BACKUP_FILES_SERVICE     with STORAGE=local, the service that mounts the files volume (default crove)
#   BACKUP_NODE_SERVICE      the service whose image runs seal.mjs (default crove)
#   BACKUP_ALERT             prober (default) or off
#   STORAGE, S3_*            the stack's own storage settings
set -Eeuo pipefail
LOG_TAG=backup
# shellcheck source=tools/backup/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export RUN_ID
STEP=setup
REPORTED=0
LOG_FILE='(none yet)'
LOCK=''
TMP=''

alert() {
  [ "${BACKUP_ALERT:-prober}" = off ] && return 0
  dc run --rm --no-deps -T prober prober --backup-failed "$1" </dev/null || log "the backup alert could not be sent (see above)"
}

# Every failure ends here once: the log line, the alert, the lock released.
report_failure() {
  REPORTED=1
  trap - ERR
  printf '[backup] FAILED: %s\n' "$1" >&2
  alert "$1"
  [ -n "$TMP" ] && rm -rf "$TMP"
  [ -n "$LOCK" ] && [ -d "$LOCK" ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
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

STEP="reading $CROVE_DIR/.env"
load_env_file "$CROVE_DIR/.env"

BACKUP_DIR="${BACKUP_DIR:-$CROVE_DIR/.data/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
BACKUP_LOCAL_KEEP_DAYS="${BACKUP_LOCAL_KEEP_DAYS:-$BACKUP_KEEP_DAYS}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-crove}"
BACKUP_FILES_SERVICE="${BACKUP_FILES_SERVICE:-crove}"
BACKUP_ALERT="${BACKUP_ALERT:-prober}"
STORAGE="${STORAGE:-local}"
RUN="$BACKUP_DIR/$RUN_ID"
PARTIAL="$RUN.partial"
LOG_FILE="$BACKUP_DIR/logs/$RUN_ID.log"

STEP="settings"
case "$STORAGE" in local | s3) ;; *) STEP="settings: STORAGE must be local or s3, not $STORAGE"; false ;; esac
case "$BACKUP_ALERT" in prober | off) ;; *) STEP="settings: BACKUP_ALERT must be prober or off"; false ;; esac
for n in BACKUP_KEEP_DAYS BACKUP_LOCAL_KEEP_DAYS; do
  [[ "${!n}" =~ ^[1-9][0-9]{0,3}$ ]] || { STEP="settings: $n must be a whole number of days"; false; }
done
if [ "$STORAGE" = s3 ] && [ -z "${S3_BUCKET:-}" ]; then STEP="settings: S3_BUCKET is required with STORAGE=s3"; false; fi
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  for n in BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
    [ -n "${!n:-}" ] || { STEP="settings: $n is required with BACKUP_S3_ENDPOINT"; false; }
  done
  [[ "$BACKUP_S3_PREFIX" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || { STEP="settings: BACKUP_S3_PREFIX must be a plain path (letters, digits, . _ - and /)"; false; }
fi
set_mc_hosts

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
ENCRYPTION=none
BLOB_STORE=blobs/plain
if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  STEP="settings: BACKUP_ENCRYPTION_KEY must be 32 random bytes as base64 or hex (openssl rand -base64 32)"
  key_id="$(backup_key_id "$BACKUP_ENCRYPTION_KEY")"
  [[ "$key_id" =~ ^[0-9a-f]{16}$ ]] || false
  ENCRYPTION=aes-256-gcm
  BLOB_STORE="blobs/k$key_id"
fi
export BLOB_STORE

STEP="taking the lock $BACKUP_DIR/.lock (another backup running?)"
if ! mkdir "$BACKUP_DIR/.lock" 2>/dev/null; then
  holder="$(cat "$BACKUP_DIR/.lock/pid" 2>/dev/null || true)"
  # A lock left by a run that died (a reboot) is taken over; a live one is not.
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then false; fi
  rm -rf "$BACKUP_DIR/.lock"
  mkdir "$BACKUP_DIR/.lock"
fi
LOCK="$BACKUP_DIR/.lock"
echo $$ >"$LOCK/pid"

# Scratch files of this run, never inside the run itself (restore refuses files the checksums do not list).
TMP="$BACKUP_DIR/.tmp-$RUN_ID"
mkdir -p "$PARTIAL/files" "$BACKUP_DIR/logs" "$TMP"
exec > >(tee -a "$LOG_FILE") 2>&1
log "run $RUN_ID into $BACKUP_DIR (storage $STORAGE)"
if [ -z "${BACKUP_S3_ENDPOINT:-}" ]; then
  log "WARNING: BACKUP_S3_ENDPOINT is empty, so this run stays on this server's disk only; that is not a backup outside development"
fi

# The newest complete run before this one, whose org blobs this run links to instead of copying again.
previous=''
for dir in "$BACKUP_DIR"/*; do
  [[ "${dir##*/}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && [ -f "$dir/SHA256SUMS" ] && [ -d "$dir/files" ] && previous="$dir"
done

# --- Database: one REPEATABLE READ snapshot for the dump, the counts, the file references and the versions ----------
STEP="database dump"
dc exec -T db sh -c 'rm -rf /tmp/crove-backup && mkdir -m 700 /tmp/crove-backup'
# pg_dump runs inside the exported snapshot while this transaction holds it, so the counts, file references and schema
# version are exactly what the dump contains.
db_psql -d postgres <<SQL
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_catalog.pg_export_snapshot() AS snapshot \gset
\setenv CROVE_SNAPSHOT :snapshot
\! pg_dump -U postgres -d postgres --format=custom --snapshot="\$CROVE_SNAPSHOT" --exclude-table-data=crove_kernel.context_key --file=/tmp/crove-backup/db.dump && touch /tmp/crove-backup/dump.ok
$COUNTS_SQL \g /tmp/crove-backup/counts.tsv
$FILE_REFS_SQL \g /tmp/crove-backup/file-refs.tsv
COPY (SELECT (SELECT max(version) FROM crove_meta.schema_migrations), pg_catalog.current_setting('server_version')) TO STDOUT \g /tmp/crove-backup/versions.tsv
COMMIT;
SQL
dc exec -T db test -f /tmp/crove-backup/dump.ok
dc exec -T db pg_restore --list /tmp/crove-backup/db.dump >/dev/null
for f in db.dump counts.tsv file-refs.tsv versions.tsv; do
  dest="$PARTIAL/$f"
  [ "$f" = versions.tsv ] && dest="$TMP/$f"
  dc exec -T db cat "/tmp/crove-backup/$f" >"$dest"
  inside="$(dc exec -T db sha256sum "/tmp/crove-backup/$f" | cut -d' ' -f1)"
  outside="$(sha256sum <"$dest" | cut -d' ' -f1)"
  [ "$inside" = "$outside" ] || { STEP="copying $f out of the db container (checksum differs)"; false; }
done
dc exec -T db rm -rf /tmp/crove-backup
IFS=$'\t' read -r schema_version postgres_version <"$TMP/versions.tsv"
[[ "$schema_version" =~ ^[0-9]{14}$ ]] || { STEP="database dump: no schema version in crove_meta.schema_migrations"; false; }
dc exec -T db pg_dumpall -U postgres --roles-only --no-role-passwords >"$PARTIAL/roles.sql"
grep -q 'CREATE ROLE crove_app' "$PARTIAL/roles.sql" || { STEP="roles dump (no crove_app role)"; false; }
dump_size="$(du -h "$PARTIAL/db.dump" | cut -f1)"
tables="$(wc -l <"$PARTIAL/counts.tsv")"
file_rows="$(wc -l <"$PARTIAL/file-refs.tsv")"
log "database: $dump_size dump, $tables tables, $file_rows file rows, schema $schema_version, PostgreSQL $postgres_version"

# --- Files ----------------------------------------------------------------------------------------------------------
STEP="file copy ($STORAGE)"
if [ "$STORAGE" = local ]; then
  dc exec -T "$BACKUP_FILES_SERVICE" tar -C /data/files --exclude='*.tmp' -cf - . | tar -xf - -C "$PARTIAL/files"
else
  # The previous run's org blobs are linked in first; mc mirror then downloads only the objects that are not there,
  # and --remove drops the ones the bucket no longer has (an erased blob must not come back through an old run).
  # mc never writes into an existing file of the same size, so the previous run's files stay as they are.
  if [ -n "$previous" ] && [ -d "$previous/files/org" ]; then
    (cd "$previous/files" && find org -type f) | while IFS= read -r path; do
      mkdir -p "$PARTIAL/files/${path%/*}"
      ln "$previous/files/$path" "$PARTIAL/files/$path" 2>/dev/null || cp -p "$previous/files/$path" "$PARTIAL/files/$path"
    done
  fi
  network="${BACKUP_SOURCE_NETWORK:-$(stack_network)}"
  mc_run "$network" "$PARTIAL" "mc mirror --quiet --remove --exclude 'staging/*' \"src/\$S3_BUCKET\" /work/files >/dev/null" </dev/null
fi
STEP="file checksums"
(cd "$PARTIAL/files" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) | normalize_sums >"$PARTIAL/files.sha256"
bad="$(content_address_mismatches <"$PARTIAL/files.sha256")"
[ -z "$bad" ] || { STEP="file checksums: blobs whose bytes do not match their content address: $(echo "$bad" | head -5 | tr '\n' ' ')"; false; }
# Every file row of the snapshot must have its blob, with its sha256, in the copy: one sorted comparison.
awk -F'\t' 'NF >= 2 && $1 != "" {print $2 "  ./" $1}' "$PARTIAL/file-refs.tsv" | LC_ALL=C sort -u >"$TMP/expected.sha256"
LC_ALL=C sort "$PARTIAL/files.sha256" >"$TMP/have.sha256"
LC_ALL=C comm -23 "$TMP/expected.sha256" "$TMP/have.sha256" >"$TMP/missing.sha256"
if [ -s "$TMP/missing.sha256" ]; then
  sed 's/^[0-9a-f]*  \.\//  missing blob: /' "$TMP/missing.sha256" | head -20
  missing="$(wc -l <"$TMP/missing.sha256")"
  STEP="file copy: $missing file row(s) have no blob with their sha256 in the copy"
  false
fi
# Org blobs the previous run holds with the same bytes become hard links to it (STORAGE=s3 linked them already).
linked=0
if [ -n "$previous" ]; then
  while read -r _hash path; do
    case "$path" in ./org/*/*) ;; *) continue ;; esac
    old="$previous/files/${path#./}"
    new="$PARTIAL/files/${path#./}"
    [ -f "$old" ] || continue
    if [ "$old" -ef "$new" ]; then
      linked=$((linked + 1))
    elif cmp -s "$old" "$new" && ln -f "$old" "$new" 2>/dev/null; then
      linked=$((linked + 1))
    fi
  done <"$PARTIAL/files.sha256"
fi
blobs="$(wc -l <"$PARTIAL/files.sha256")"
files_size="$(du -sh "$PARTIAL/files" | cut -f1)"
log "files: $blobs blob(s), $files_size; $linked shared with the previous run ${previous:+${previous##*/}}"

# --- Manifest -------------------------------------------------------------------------------------------------------
STEP="manifest"
db_id="$(dc ps -q db)"
compose_project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$db_id")"
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$PARTIAL/meta.env" <<META
RUN_ID=$RUN_ID
FINISHED_AT=$finished_at
STORAGE=$STORAGE
SCHEMA_VERSION=$schema_version
POSTGRES_VERSION=$postgres_version
COMPOSE_PROJECT=$compose_project
FORMAT=2
ENCRYPTION=$ENCRYPTION
BLOB_STORE=$BLOB_STORE
META
(cd "$PARTIAL" && sha256sum db.dump roles.sql counts.tsv file-refs.tsv files.sha256 meta.env) | normalize_sums >"$PARTIAL/SHA256SUMS"
# The umask covers what this script writes; tar run as root keeps the modes of the archive, so close those too.
chmod -R go-rwx "$PARTIAL" "$BACKUP_DIR/logs"
mv "$PARTIAL" "$RUN"
log "complete: $RUN"

# --- Second location ------------------------------------------------------------------------------------------------
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  remote='dst/$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX'
  sums=SHA256SUMS
  [ "$ENCRYPTION" = none ] || sums=SHA256SUMS.enc
  stage="$BACKUP_DIR/.upload-$RUN_ID"
  mkdir -p "$stage/run" "$stage/blobs"

  # One listing of the whole prefix serves the upload (which blobs the store holds) and the prune (which runs and
  # blobs there are). Only backup.sh writes there, and the lock keeps one at a time.
  STEP="upload to the backup bucket: listing the bucket"
  mc_run "${BACKUP_S3_NETWORK:-}" "$TMP" "mc ls --recursive --json \"$remote/\"" </dev/null | mc_objects >"$TMP/bucket.tsv"
  declare -A stored=()
  while IFS=$'\t' read -r key size; do
    [[ "$key" == "$BLOB_STORE/"* ]] && stored["${key#"$BLOB_STORE/"}"]="$size"
  done <"$TMP/bucket.tsv"
  declare -A sizes=()
  (cd "$RUN/files" && find . -type f -printf '%P\t%s\n') >"$TMP/sizes.tsv"
  while IFS=$'\t' read -r path size; do sizes["$path"]="$size"; done <"$TMP/sizes.tsv"

  STEP="upload to the backup bucket: staging"
  # What goes up: every run file but the org blobs, and the org blobs the store lacks (or holds with another size).
  : >"$TMP/seal.list"
  : >"$TMP/blob-sizes.tsv"
  new_blobs=0
  while read -r _hash path; do
    path="${path#./}"
    [[ "$path" == org/*/* ]] || continue
    want="${sizes[$path]}"
    [ "$ENCRYPTION" = none ] || want="$(sealed_size "$want")"
    printf '%s\t%s\n' "$path" "$want" >>"$TMP/blob-sizes.tsv"
    [ "${stored[$path]:-}" = "$want" ] && continue
    new_blobs=$((new_blobs + 1))
    if [ "$ENCRYPTION" = none ]; then
      mkdir -p "$stage/blobs/${path%/*}"
      ln "$RUN/files/$path" "$stage/blobs/$path" 2>/dev/null || cp -p "$RUN/files/$path" "$stage/blobs/$path"
    else
      printf '%s\t%s\t%s\n' "$RUN_ID/files/$path" ".upload-$RUN_ID/blobs/$path" "blobs/$path" >>"$TMP/seal.list"
    fi
  done <"$RUN/files.sha256"
  (cd "$RUN" && find . -type f ! -path './files/org/*' -printf '%P\n') >"$TMP/run-files"
  while IFS= read -r path; do
    if [ "$ENCRYPTION" = none ]; then
      mkdir -p "$stage/run/$(dirname "$path")"
      ln "$RUN/$path" "$stage/run/$path" 2>/dev/null || cp -p "$RUN/$path" "$stage/run/$path"
    else
      printf '%s\t%s\t%s\n' "$RUN_ID/$path" ".upload-$RUN_ID/run/$path.enc" "$RUN_ID/$path" >>"$TMP/seal.list"
    fi
  done <"$TMP/run-files"
  if [ "$ENCRYPTION" != none ]; then
    cp "$TMP/seal.list" "$BACKUP_DIR/.seal-$RUN_ID.list"
    seal_run "$BACKUP_DIR" seal ".seal-$RUN_ID.list"
    rm -f "$BACKUP_DIR/.seal-$RUN_ID.list"
  fi
  run_objects="$(wc -l <"$TMP/run-files")"

  STEP="upload to the backup bucket"
  # A run that does not read back whole is deleted from the bucket, so s3:latest never picks it. Blobs it uploaded stay
  # until the next prune finds no run that lists them. The same container reads back SHA256SUMS and lists what is
  # there for the checks below.
  remove_remote_run() {
    mc_run "${BACKUP_S3_NETWORK:-}" "$stage" "mc rm --quiet --recursive --force \"$remote/\$RUN_ID/\" >/dev/null" </dev/null ||
      log "could not delete the incomplete run $RUN_ID from the backup bucket; delete it by hand"
  }
  upload="mc mirror --quiet --exclude 'SHA256SUMS*' /work/run \"$remote/\$RUN_ID\" >/dev/null && mc cp --quiet /work/run/$sums \"$remote/\$RUN_ID/$sums\" >/dev/null"
  upload="$upload && mc cat \"$remote/\$RUN_ID/$sums\" >/work/remote-sums && mc ls --recursive --json \"$remote/\$RUN_ID/\" >/work/run.jsonl"
  upload="$upload && mc ls --recursive --json \"$remote/\$BLOB_STORE/\" >/work/store.jsonl"
  [ "$new_blobs" -eq 0 ] || upload="mc mirror --quiet --overwrite /work/blobs \"$remote/\$BLOB_STORE\" >/dev/null && $upload"
  if ! mc_run "${BACKUP_S3_NETWORK:-}" "$stage" "$upload" </dev/null || ! cmp -s "$stage/remote-sums" "$stage/run/$sums"; then
    remove_remote_run
    STEP="upload to the backup bucket: the upload failed or $sums read back differs"
    false
  fi
  STEP="upload to the backup bucket: checking what is there"
  remote_count="$(mc_objects <"$stage/run.jsonl" | wc -l)" || { remove_remote_run; false; }
  mc_objects <"$stage/store.jsonl" | LC_ALL=C sort >"$TMP/store-after.tsv" || { remove_remote_run; false; }
  LC_ALL=C sort "$TMP/blob-sizes.tsv" | LC_ALL=C comm -23 - "$TMP/store-after.tsv" >"$TMP/blobs-missing.tsv"
  if [ "$((remote_count))" -ne "$((run_objects))" ] || [ -s "$TMP/blobs-missing.tsv" ]; then
    head -5 "$TMP/blobs-missing.tsv" | sed 's/^/  not in the blob store (key, size): /'
    remove_remote_run
    STEP="upload to the backup bucket: $remote_count of $run_objects run object(s) there, $(wc -l <"$TMP/blobs-missing.tsv") blob(s) missing or with another size"
    false
  fi
  rm -rf "$stage"
  listed="$(wc -l <"$TMP/blob-sizes.tsv")"
  log "uploaded to $BACKUP_S3_ENDPOINT, bucket $BACKUP_S3_BUCKET, prefix $BACKUP_S3_PREFIX/$RUN_ID ($remote_count objects, encryption $ENCRYPTION); $new_blobs new blob(s) into $BLOB_STORE, $((listed - new_blobs)) already there"

  # Runs older than BACKUP_KEEP_DAYS go, then every blob no kept run lists. Each kept run's files.sha256 is read (opened
  # when sealed; this run's is here already); a complete run whose list is missing or does not open stops the prune,
  # so no blob a run needs is ever deleted.
  STEP="pruning the backup bucket"
  cutoff="$(days_ago "$BACKUP_KEEP_DAYS")"
  manifests="$BACKUP_DIR/.manifests-$RUN_ID"
  mkdir -p "$manifests"
  : >"$manifests/prune.sh"
  : >"$manifests/open.list"
  : >"$TMP/deleted-runs"
  cut -f1 "$TMP/bucket.tsv" | grep -o '^[0-9]\{8\}T[0-9]\{6\}Z/' | tr -d / | LC_ALL=C sort -u >"$TMP/run-ids" || true
  while IFS= read -r id; do
    [ "$id" = "$RUN_ID" ] && continue
    if [ "${id%%T*}" -lt "$cutoff" ]; then
      echo "mc rm --quiet --recursive --force \"$remote/$id/\" >/dev/null" >>"$manifests/prune.sh"
      echo "$id" >>"$TMP/deleted-runs"
    elif grep -q "^$id/files\.sha256\.enc"$'\t' "$TMP/bucket.tsv"; then
      echo "mc cp --quiet \"$remote/$id/files.sha256.enc\" /work/$id.enc >/dev/null" >>"$manifests/prune.sh"
      printf '%s\t%s\t%s\n' "$id.enc" "$id" "$id/files.sha256" >>"$manifests/open.list"
    elif grep -q "^$id/files\.sha256"$'\t' "$TMP/bucket.tsv"; then
      echo "mc cp --quiet \"$remote/$id/files.sha256\" /work/$id >/dev/null" >>"$manifests/prune.sh"
    elif grep -q "^$id/SHA256SUMS" "$TMP/bucket.tsv"; then
      STEP="pruning the backup bucket: run $id is complete but has no files.sha256 in the bucket"
      false
    fi
  done <"$TMP/run-ids"
  if [ -s "$manifests/prune.sh" ]; then
    sed -i '1i set -e' "$manifests/prune.sh"
    mc_run "${BACKUP_S3_NETWORK:-}" "$manifests" "sh /work/prune.sh" </dev/null
  fi
  while IFS= read -r id; do log "deleted $id from the backup bucket (older than $BACKUP_KEEP_DAYS days)"; done <"$TMP/deleted-runs"
  if [ -s "$manifests/open.list" ]; then
    STEP="pruning the blob stores: opening the sealed lists (a run sealed with an older key needs BACKUP_ENCRYPTION_KEY_PREVIOUS)"
    seal_run "$manifests" open open.list >/dev/null
  fi
  STEP="pruning the blob stores"
  cp "$RUN/files.sha256" "$manifests/$RUN_ID"
  : >"$TMP/referenced"
  for list in "$manifests"/*; do
    id="${list##*/}"
    [[ "$id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    store=blobs/plain
    if [ "$id" = "$RUN_ID" ]; then
      store="$BLOB_STORE"
    elif [ -f "$list.enc" ]; then
      store="blobs/k$(od -An -tx1 -j4 -N8 "$list.enc" | tr -d ' \n')"
    fi
    awk -v store="$store" '$2 ~ /^\.\/org\// {print store "/" substr($2, 3)}' "$list" >>"$TMP/referenced"
  done
  LC_ALL=C sort -u "$TMP/referenced" -o "$TMP/referenced"
  { cut -f1 "$TMP/bucket.tsv" | grep '^blobs/' || true; } | LC_ALL=C sort | LC_ALL=C comm -23 - "$TMP/referenced" >"$manifests/delete.txt"
  if [ -s "$manifests/delete.txt" ]; then
    mc_run "${BACKUP_S3_NETWORK:-}" "$manifests" "while IFS= read -r key; do mc rm --quiet \"$remote/\$key\" >/dev/null || exit 1; done </work/delete.txt" </dev/null
  fi
  referenced="$(wc -l <"$TMP/referenced")"
  deleted="$(wc -l <"$manifests/delete.txt")"
  log "blob stores: $referenced blob(s) listed by kept runs, $deleted deleted"
  rm -rf "$manifests"
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
# Scratch directories a failed run left (the lock rules out one in progress).
for dir in "$BACKUP_DIR"/.tmp-* "$BACKUP_DIR"/.upload-* "$BACKUP_DIR"/.manifests-* "$BACKUP_DIR"/.seal-*.list; do
  [ -e "$dir" ] || continue
  case "$dir" in "$TMP") continue ;; esac
  rm -rf "$dir"
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
rm -rf "$TMP"
TMP=''

# --- Done -----------------------------------------------------------------------------------------------------------
if [ -z "${BACKUP_S3_ENDPOINT:-}" ] && ! is_local_url "${PUBLIC_URL:-}"; then
  STEP="no second location: BACKUP_S3_ENDPOINT is empty, so run $RUN_ID stays on this server's disk only"
  report_failure "$STEP; log $LOG_FILE"
  exit 1
fi
# The marker of the last good run, for a look (`cat $BACKUP_DIR/last-success`) and for a monitor on the host.
STEP="writing $BACKUP_DIR/last-success"
second=no
[ -z "${BACKUP_S3_ENDPOINT:-}" ] || second=yes
printf 'RUN_ID=%s\nFINISHED_AT=%s\nSECOND_LOCATION=%s\nENCRYPTION=%s\n' "$RUN_ID" "$finished_at" "$second" "$ENCRYPTION" >"$BACKUP_DIR/.last-success.tmp"
mv "$BACKUP_DIR/.last-success.tmp" "$BACKUP_DIR/last-success"
rm -rf "$LOCK"
LOCK=''
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  dc run --rm --no-deps -T prober prober --backup-ok </dev/null || log "WARNING: the backup heartbeat could not be sent (see above); the monitor will report a missed run"
fi
log "done in $(($(date +%s) - STARTED_AT)) s"
