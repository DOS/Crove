#!/usr/bin/env bash
# WAL archiving and point-in-time recovery of a Crove docker compose stack (issue #2120). Runbook:
# docs/runbooks/backup-and-restore.md, "Point in time recovery". Needs tools/backup/compose.wal.yml in COMPOSE_FILE (the
# `db` service is then PostgreSQL plus pgBackRest, with the bucket's settings).
#
#   wal.sh setup                 once per database: turns archiving on (archive_mode, archive_command, archive_timeout;
#                                restarts `db` once when archiving was off), creates the pgBackRest stanza in the bucket,
#                                checks that a WAL segment reaches it and takes the first full base backup
#   wal.sh backup [--type full|diff|incr]
#                                a base backup (default diff; full when none exists), then the old ones are expired
#                                (WAL_RETENTION_FULL, WAL_RETENTION_DIFF). Run it from cron: a full one weekly, a
#                                differential one nightly. A failure alerts through the prober, as backup.sh does
#   wal.sh check                 pgBackRest's own check: the archive command works and the newest segment is in the bucket
#   wal.sh info                  the base backups and the WAL range the bucket holds, i.e. the times a restore can reach
#   wal.sh restore (--to <time> | --latest) [--archive-mode off|preserve]
#                                restores the database into the (empty, stopped) `db` volume of this stack, up to <time>
#                                ("2026-10-31 08:40:00+00": a timestamp with its time zone) or to the end of the archive.
#                                Then `docker compose up -d db` replays the WAL up to that moment and opens the database.
#                                Archiving is switched off on the restored cluster (--archive-mode off, the default), so
#                                a scratch copy never pushes into the bucket it was restored from; for the real thing,
#                                after checking the data, run `wal.sh setup` to start archiving again (a new timeline)
#
# Settings: the stack's .env (CROVE_DIR, default this checkout), as backup.sh reads it. The bucket and its keys are
# BACKUP_S3_*; the others are the WAL_* settings of tools/backup/compose.wal.yml (WAL_ENCRYPTION_KEY, WAL_S3_ENDPOINT,
# WAL_S3_PORT, WAL_S3_REGION, WAL_S3_URI_STYLE, WAL_RETENTION_FULL, WAL_RETENTION_DIFF). WAL_ARCHIVE_TIMEOUT (default 60) is
# the longest a write waits before its WAL segment is closed and pushed: the recovery point objective is that plus the
# upload time. BACKUP_ALERT=off turns the failure alert off.
set -Eeuo pipefail
LOG_TAG=wal
# shellcheck source=tools/backup/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STEP=setup
REPORTED=0

alert() {
  [ "${BACKUP_ALERT:-prober}" = off ] && return 0
  dc run --rm --no-deps -T prober prober --backup-failed "$1" </dev/null || log "the alert could not be sent (see above)"
}

report_failure() {
  REPORTED=1
  trap - ERR
  printf '[wal] FAILED: %s\n' "$1" >&2
  if [ "$COMMAND" = backup ]; then alert "$1"; fi
  return 0
}
trap 'status=$?; [ "$BASH_SUBSHELL" -gt 0 ] && exit "$status"; report_failure "$STEP failed (exit $status, wal.sh line $LINENO)"; exit 1' ERR
trap 'status=$?; [ "$BASH_SUBSHELL" -gt 0 ] && return; if [ "$status" -ne 0 ] && [ "$status" -ne 2 ] && [ "$REPORTED" -eq 0 ]; then report_failure "wal.sh stopped with exit $status during: $STEP"; fi' EXIT

COMMAND="${1:-}"
[ -n "$COMMAND" ] || {
  sed -n '2,/^set -Eeuo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//' >&2
  exit 2
}
shift

STEP="reading $CROVE_DIR/.env"
load_env_file "$CROVE_DIR/.env"
WAL_ARCHIVE_TIMEOUT="${WAL_ARCHIVE_TIMEOUT:-60}"
[[ "$WAL_ARCHIVE_TIMEOUT" =~ ^[0-9]+$ ]] && [ "$WAL_ARCHIVE_TIMEOUT" -ge 10 ] && [ "$WAL_ARCHIVE_TIMEOUT" -le 3600 ] || {
  echo '[wal] WAL_ARCHIVE_TIMEOUT is a whole number of seconds, 10 to 3600' >&2
  exit 2
}

# pgBackRest inside the db container, as the postgres user.
pgbr() { dc exec -T -u postgres db pgbackrest "$@"; }

wait_ready() {
  local i
  for i in $(seq 1 90); do
    if dc exec -T db pg_isready -q -U postgres -h /var/run/postgresql 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo '[wal] the database did not become ready' >&2
  return 1
}

# The timeline of the newest base backup in the bucket (from the first WAL segment it needs), or nothing when there is none.
newest_backup_timeline() {
  local start
  start="$(pgbr info --output=json | grep -o '"archive":{"start":"[0-9A-F]\{24\}"' | tail -n 1 | sed 's/.*"start":"\([0-9A-F]\{8\}\).*/\1/')"
  if [ -n "$start" ]; then echo "$((16#$start))"; fi
}

# True when there is no base backup, or the newest one is on another timeline than the database runs on now.
full_backup_needed() {
  local newest current
  newest="$(newest_backup_timeline)"
  current="$(db_psql -At -c 'SELECT timeline_id FROM pg_control_checkpoint()')"
  [ -z "$newest" ] || [ "$newest" != "$current" ]
}

# The archiving settings, written to postgresql.auto.conf (they survive a restart and need no change to the image).
# The archive command is the one place the database hands a finished segment over: it fails (and PostgreSQL retries,
# keeping the segment) until the segment is in the bucket.
setup() {
  STEP='checking the database'
  wait_ready
  local mode
  mode="$(db_psql -At -c 'SHOW archive_mode')"
  STEP='setting the archiving parameters'
  db_psql -c "ALTER SYSTEM SET wal_level = 'replica'" \
    -c "ALTER SYSTEM SET archive_mode = 'on'" \
    -c "ALTER SYSTEM SET archive_command = 'pgbackrest --stanza=crove archive-push %p'" \
    -c "ALTER SYSTEM SET archive_timeout = '${WAL_ARCHIVE_TIMEOUT}s'" >/dev/null
  # The stanza first: while archive_mode is on and the stanza is missing every push fails, and a restart cannot finish.
  STEP='creating the stanza'
  pgbr stanza-create
  if [ "$mode" != on ] && [ "$mode" != always ]; then
    STEP='restarting the database (archive_mode takes a restart)'
    log 'archive_mode was off: restarting db once'
    dc restart db
    wait_ready
  else
    db_psql -c 'SELECT pg_reload_conf()' >/dev/null
  fi
  STEP='checking that a WAL segment reaches the bucket'
  pgbr check
  # A full base backup when there is none, and after a restore: the database then runs on a new timeline, and a
  # `restore --latest` must start from a backup of the timeline that carries the data (the older ones belong to the
  # branch the restore left).
  if full_backup_needed; then
    STEP='a full base backup'
    pgbr backup --type=full
  fi
  log "WAL archiving is on: segments are pushed at least every ${WAL_ARCHIVE_TIMEOUT} s while there are writes"
}

backup() {
  local type=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --type) type="${2:-}"; shift 2 ;;
      *) echo "[wal] unknown argument $1" >&2; exit 2 ;;
    esac
  done
  case "${type:-diff}" in full | diff | incr) ;; *) echo '[wal] --type is full, diff or incr' >&2; exit 2 ;; esac
  STEP='checking the archive'
  pgbr check
  # A differential or incremental backup needs a full one under it: the first run, or a lost one, takes a full one.
  if [ "${type:-diff}" != full ] && full_backup_needed; then
    log 'no full base backup on the current timeline yet: taking one'
    type=full
  fi
  STEP="the ${type:-diff} base backup"
  pgbr backup --type="${type:-diff}"
  STEP='expiring old backups'
  pgbr expire
  log "base backup done: $(pgbr info --output=text | grep -Ec '(full|diff|incr) backup:' || true) base backup(s) in the bucket; wal.sh info shows the window"
}

restore() {
  local target='' latest=0 archive_mode=off
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --to) target="${2:-}"; shift 2 ;;
      --latest) latest=1; shift ;;
      --archive-mode) archive_mode="${2:-}"; shift 2 ;;
      *) echo "[wal] unknown argument $1" >&2; exit 2 ;;
    esac
  done
  if [ -z "$target" ] && [ "$latest" -eq 0 ]; then
    echo '[wal] restore needs --to "<timestamp with time zone>" or --latest' >&2
    exit 2
  fi
  if [ -n "$target" ] && [ "$latest" -eq 1 ]; then
    echo '[wal] restore takes --to or --latest, not both' >&2
    exit 2
  fi
  case "$archive_mode" in off | preserve) ;; *) echo '[wal] --archive-mode is off or preserve' >&2; exit 2 ;; esac
  if [ -n "$target" ] && ! [[ "$target" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9:.]+(Z|[+-][0-9]{2}(:?[0-9]{2})?)$ ]]; then
    echo '[wal] --to is a timestamp with its time zone, for example "2026-10-31 08:40:00+00"' >&2
    exit 2
  fi
  STEP='checking that the database volume is empty'
  if ! dc run --rm --no-deps -T -u root --entrypoint sh db -c 'test -z "$(ls -A /var/lib/postgresql/data)"' </dev/null; then
    echo '[wal] the db volume of this stack is not empty (or cannot be read): restore into an empty one, on a new server or after copying what is there away and removing the volume; nothing was stopped' >&2
    exit 1
  fi
  STEP='stopping the database'
  dc stop db
  local mode_args=() recovery=() until='to its end'
  [ "$archive_mode" = off ] && mode_args=(--archive-mode=off)
  # With a time, recovery stops there and the database opens (promote); with none, it replays the whole archive, as a
  # crash recovery would, and opens at its end.
  if [ -n "$target" ]; then
    recovery=(--type=time "--target=$target" --target-action=promote)
    until="up to $target"
  fi
  STEP='restoring the base backup and the WAL'
  # root only to give the postgres user the (new, empty) volume; the restore itself runs as postgres.
  dc run --rm --no-deps -T -u root --entrypoint bash db -c '
    set -e
    chown postgres:postgres /var/lib/postgresql/data
    chmod 700 /var/lib/postgresql/data
    exec runuser -u postgres -- pgbackrest restore "$@"
  ' restore ${mode_args[@]+"${mode_args[@]}"} ${recovery[@]+"${recovery[@]}"}
  log "restored: start the database with \`docker compose up -d db\`; it replays the WAL $until and opens"
}

case "$COMMAND" in
  setup) setup ;;
  backup) backup "$@" ;;
  check) STEP=check; pgbr check ;;
  info) STEP=info; pgbr info ;;
  restore) restore "$@" ;;
  *)
    echo "[wal] unknown command $COMMAND (setup, backup, check, info, restore)" >&2
    exit 2
    ;;
esac
