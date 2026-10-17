# Shared by backup.sh and restore.sh (issue #307, docs/runbooks/backup-and-restore.md). Sourced, never run.
# Needs bash, docker with the compose plugin, tar, sha256sum and the usual coreutils on the host. Every database
# command runs inside the stack's `db` container, every S3 command in a throwaway container of BACKUP_MC_IMAGE.

# Runs hold the whole database (password hashes, refresh tokens, MFA secrets): nothing written is readable by others.
umask 077

# Git Bash on Windows rewrites arguments that look like paths (/data/files); Linux ignores these.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CROVE_DIR="${CROVE_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

# The MinIO client, from the same pinned image as the MinIO in docker-compose.split.yml (AGENTS.md, "Updating
# pinned images").
BACKUP_MC_IMAGE_DEFAULT='pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372'

log() { printf '[%s +%ss] %s\n' "$LOG_TAG" "$(($(date +%s) - STARTED_AT))" "$*"; }
STARTED_AT="$(date +%s)"

# Reads KEY=VALUE lines from a .env file without overriding variables already set, and without evaluating anything
# (no command substitution, no expansion). Surrounding single or double quotes are removed.
load_env_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -n "${!key+x}" ] && continue
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    export "$key=$value"
  done <"$file"
}

# docker compose in CROVE_DIR, so it reads the same .env, COMPOSE_FILE and COMPOSE_PROJECT_NAME as the stack.
dc() { (cd "$CROVE_DIR" && docker compose "$@"); }

# psql as the superuser inside the db container, over its local socket. Extra arguments go to psql.
db_psql() { dc exec -T db psql -X -q -v ON_ERROR_STOP=1 -U postgres "$@"; }

# A host path as Docker wants it in -v (Git Bash: C:/..., elsewhere unchanged).
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# The stack's own network (<project>_default), found from its db container, for an mc container that must reach a
# bucket inside the stack (MinIO in docker-compose.split.yml). External buckets work from any network.
stack_network() {
  local id
  id="$(dc ps -q db)"
  [ -n "$id" ] || { echo "the db service is not running" >&2; return 1; }
  docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$id" | grep -m1 '_default$'
}

# mc_run <network> <host dir mounted at /work> <script>: runs a POSIX sh script in a throwaway MinIO client
# container, as the host user and with umask 077, so what it writes stays private. Its aliases `src` and `dst` come
# from MC_HOST_src and MC_HOST_dst (set_mc_hosts), passed by name with -e, so the keys appear on no command line,
# here or in the container. The image has sh, mc, sha256sum, cut and cat, nothing else.
mc_run() {
  local network="$1" dir="$2" script="$3"
  local args=(run --rm -i --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$(host_path "$dir"):/work")
  [ -n "$network" ] && args+=(--network "$network")
  local name
  for name in MC_HOST_src MC_HOST_dst S3_BUCKET BACKUP_S3_BUCKET BACKUP_S3_PREFIX RUN_ID; do
    args+=(-e "$name")
  done
  docker "${args[@]}" --entrypoint /bin/sh "${BACKUP_MC_IMAGE:-$BACKUP_MC_IMAGE_DEFAULT}" -c "umask 077; $script"
}

# Percent-encodes a string for the user information part of a URL.
urlencode() {
  local LC_ALL=C s="$1" out='' c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in [a-zA-Z0-9._~-]) out+="$c" ;; *) out+="$(printf '%%%02X' "'$c")" ;; esac
  done
  printf '%s' "$out"
}

# mc_host <endpoint> <access key> <secret>: an MC_HOST_<alias> value, scheme://key:secret@host[:port]. mc picks the
# addressing style itself (path style for anything but the large providers it knows).
mc_host() { printf '%s://%s:%s@%s' "${1%%://*}" "$(urlencode "$2")" "$(urlencode "$3")" "${1#*://}"; }

# The mc aliases: src is the stack's bucket (S3_*; an empty S3_ENDPOINT means AWS S3, as in the kernel), dst the
# backup bucket (BACKUP_S3_*). Exported for mc_run only.
set_mc_hosts() {
  if [ -n "${S3_BUCKET:-}" ]; then
    MC_HOST_src="$(mc_host "${S3_ENDPOINT:-https://s3.amazonaws.com}" "${S3_ACCESS_KEY_ID:-}" "${S3_SECRET_ACCESS_KEY:-}")"
    export MC_HOST_src
  fi
  if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
    MC_HOST_dst="$(mc_host "$BACKUP_S3_ENDPOINT" "${BACKUP_S3_ACCESS_KEY_ID:-}" "${BACKUP_S3_SECRET_ACCESS_KEY:-}")"
    export MC_HOST_dst
  fi
  export S3_BUCKET BACKUP_S3_BUCKET BACKUP_S3_PREFIX
}

# The values the target compose project resolves for an environment variable of its services (`docker compose
# config`), one per line. restore.sh compares them with its own settings.
stack_setting() { dc config 2>/dev/null | sed -n "s/^      $1: *//p" | sed 's/^"\(.*\)"$/\1/' | sort -u; }

# The row count of every table, as "schema.table<TAB>count" sorted by name, except crove_kernel.context_key, whose
# rows a backup leaves out on purpose (docs/runbooks/context-key-rotation.md). Run as the superuser, so row level
# security hides nothing. backup.sh runs it in the dump's snapshot, restore.sh on the restored database.
COUNTS_SQL="COPY (
  SELECT n.nspname || '.' || c.relname,
         (pg_catalog.xpath('/row/c/text()', pg_catalog.query_to_xml(
            pg_catalog.format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND (n.nspname, c.relname) <> ('crove_kernel', 'context_key')
   ORDER BY 1
) TO STDOUT"

# Every file row's blob reference, as "storage_key<TAB>sha256<TAB>generation".
FILE_REFS_SQL="COPY (
  SELECT storage_key, sha256, coalesce(generation, '') FROM crove_kernel.file
   ORDER BY storage_key
) TO STDOUT"

# Checks that every blob under org/ is named by its own sha256 (the content address, plan §7.6). Reads a
# sha256sum listing ("<hash>  ./org/<org_id>/<sha256>") on stdin and prints the mismatches.
content_address_mismatches() {
  local hash path
  while read -r hash path; do
    case "$path" in
      ./org/*/*) [ "${path##*/}" = "$hash" ] || printf '%s\n' "$path" ;;
    esac
  done
}

# sha256sum lines in text mode ("<hash>  <name>"): sha256sum on Windows (Git Bash) marks binary mode with "*", which
# the checks here and a Linux `sha256sum -c` would otherwise read as part of the name.
normalize_sums() { sed 's/^\([0-9a-f]\{64\}\) [ *]/\1  /'; }

# A date N days ago as YYYYMMDD (GNU date, else BSD date).
days_ago() { date -u -d "-$1 days" +%Y%m%d 2>/dev/null || date -u -v "-$1d" +%Y%m%d; }
