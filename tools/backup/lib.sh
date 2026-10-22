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

# Expands a .env value the way docker compose does, into REPLY: $NAME, ${NAME}, ${NAME:-word}, ${NAME-word},
# ${NAME:+word}, ${NAME+word}, ${NAME:?message} and ${NAME?message} (word expanded in turn), $$ for a literal $. A $
# before anything else stays. Never evaluates anything: no command substitution, no arithmetic, no globbing.
env_interpolate() {
  local s="$1" out='' i=0 rest name op word val depth j body
  while [ "$i" -lt "${#s}" ]; do
    if [ "${s:i:1}" != '$' ]; then
      out+="${s:i:1}"
      i=$((i + 1))
      continue
    fi
    rest="${s:i+1}"
    if [[ "$rest" == '$'* ]]; then
      out+='$'
      i=$((i + 2))
    elif [[ "$rest" =~ ^([A-Za-z_][A-Za-z0-9_]*) ]]; then
      name="${BASH_REMATCH[1]}"
      out+="${!name-}"
      i=$((i + 1 + ${#name}))
    elif [[ "$rest" != '{'* ]]; then
      out+='$'
      i=$((i + 1))
    else
      depth=0
      for ((j = 0; j < ${#rest}; j++)); do
        case "${rest:j:1}" in
          '{') depth=$((depth + 1)) ;;
          '}') depth=$((depth - 1)); [ "$depth" -eq 0 ] && break ;;
        esac
      done
      [ "$depth" -eq 0 ] || { ENV_ERROR='an unclosed ${'; return 1; }
      body="${rest:1:j-1}"
      [[ "$body" =~ ^([A-Za-z_][A-Za-z0-9_]*)((:?[-+?])(.*))?$ ]] || { ENV_ERROR="\${$body} is not a variable reference"; return 1; }
      name="${BASH_REMATCH[1]}" op="${BASH_REMATCH[3]}" word="${BASH_REMATCH[4]}"
      val="${!name-}"
      case "$op" in
        ':-') [ -n "$val" ] || { env_interpolate "$word" || return 1; val="$REPLY"; } ;;
        '-') [ -n "${!name+x}" ] || { env_interpolate "$word" || return 1; val="$REPLY"; } ;;
        ':+') if [ -n "$val" ]; then env_interpolate "$word" || return 1; val="$REPLY"; fi ;;
        '+') if [ -n "${!name+x}" ]; then env_interpolate "$word" || return 1; val="$REPLY"; else val=''; fi ;;
        ':?') [ -n "$val" ] || { ENV_ERROR="$name is required: $word"; return 1; } ;;
        '?') [ -n "${!name+x}" ] || { ENV_ERROR="$name is required: $word"; return 1; } ;;
      esac
      out+="$val"
      i=$((i + 2 + j))
    fi
  done
  REPLY="$out"
}

# Reads KEY=VALUE lines from a .env file the way docker compose reads it, so the scripts see the values the stack
# runs with, without overriding variables already set (as in Compose, the environment wins). An `export ` prefix is
# allowed; a value is unquoted (trimmed, ` #` starts a comment, expanded), 'single-quoted' (literal) or
# "double-quoted" (\n, \t, \r, \", \\ and \$ escapes, then expanded); expansion sees the environment and the lines
# above (env_interpolate). Nothing is evaluated. A value Compose would read differently from this parser (an unclosed
# quote, a multi-line value, text after the closing quote) fails, naming the line and the key but never the value.
load_env_file() {
  local file="$1" line key value n=0 rest out c i
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '' | \#*) continue ;; esac
    if [[ "$line" =~ ^export[[:space:]]+(.*)$ ]]; then line="${BASH_REMATCH[1]}"; fi
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    ENV_ERROR=''
    case "$value" in
      \'*)
        rest="${value:1}"
        [[ "$rest" == *\'* ]] || { echo "$file line $n ($key): unclosed single quote (multi-line values are not supported)" >&2; return 1; }
        value="${rest%%\'*}"
        rest="${rest#*\'}"
        ;;
      \"*)
        out='' rest=''
        for ((i = 1; i < ${#value}; i++)); do
          c="${value:i:1}"
          if [ "$c" = '\' ]; then
            i=$((i + 1))
            case "${value:i:1}" in
              n) out+=$'\n' ;; t) out+=$'\t' ;; r) out+=$'\r' ;; '"') out+='"' ;; '\') out+='\' ;; '$') out+='$$' ;;
              *) out+="\\${value:i:1}" ;;
            esac
          elif [ "$c" = '"' ]; then
            rest="${value:i+1}"
            break
          else
            out+="$c"
          fi
        done
        [ "$i" -lt "${#value}" ] || { echo "$file line $n ($key): unclosed double quote (multi-line values are not supported)" >&2; return 1; }
        env_interpolate "$out" || { echo "$file line $n ($key): $ENV_ERROR" >&2; return 1; }
        value="$REPLY"
        ;;
      *)
        value="${value%%[[:space:]]#*}"
        value="${value%"${value##*[![:space:]]}"}"
        env_interpolate "$value" || { echo "$file line $n ($key): $ENV_ERROR" >&2; return 1; }
        value="$REPLY"
        rest=''
        ;;
    esac
    [[ "$rest" =~ ^([[:space:]]+#.*|[[:space:]]*)$ ]] || { echo "$file line $n ($key): text after the closing quote" >&2; return 1; }
    [ -n "${!key+x}" ] && continue
    export "$key=$value"
  done <"$file"
}

# A KEY=value line of a run's meta.env; fails when the key is missing, so a damaged file is never read as empty.
meta_value() {
  local line
  line="$(grep -m1 "^$1=" "$2")" || { echo "meta.env has no $1" >&2; return 1; }
  printf '%s' "${line#*=}"
}

# node_run <host dir> <args...>: runs node from the stack's own image (service BACKUP_NODE_SERVICE, default crove) as
# the host user, in the given directory (mounted at /work), with tools/backup at /crove-backup. The backup keys reach
# it by name (-e), never on a command line. The host itself needs no Node.
node_run() {
  local dir="$1"
  shift
  dc run --rm --no-deps -T --user "$(id -u):$(id -g)" -e HOME=/tmp -e BACKUP_ENCRYPTION_KEY -e BACKUP_ENCRYPTION_KEY_PREVIOUS \
    -v "$(host_path "$dir"):/work" -v "$(host_path "$SCRIPT_DIR"):/crove-backup:ro" -w /work --entrypoint node \
    "${BACKUP_NODE_SERVICE:-crove}" "$@" </dev/null
}

# Turns `mc ls --recursive --json` output on stdin into "key<TAB>size" lines, one per object (keys relative to the
# listed prefix); fails on an error line, so a listing that broke halfway is never read as a short one.
mc_objects() {
  local line key size
  while IFS= read -r line; do
    [[ "$line" == *'"status":"error"'* ]] && { printf 'mc: %s\n' "$line" >&2; return 1; }
    [[ "$line" == *'"type":"file"'* ]] || continue
    [[ "$line" =~ \"key\":\"([^\"]*)\" ]] || continue
    key="${BASH_REMATCH[1]}"
    [[ "$line" =~ \"size\":([0-9]+) ]] || continue
    size="${BASH_REMATCH[1]}"
    printf '%s\t%s\n' "$key" "$size"
  done
}

# True for a URL a development stack uses (localhost, *.localhost, 127.x.x.x, [::1]), false for anything else,
# including no URL at all: an unset PUBLIC_URL counts as a deployment, so its checks are not skipped by omission.
is_local_url() {
  local host="${1#*://}"
  host="${host%%/*}"
  if [[ "$host" == '['* ]]; then host="${host%%]*}]"; else host="${host%:*}"; fi
  host="${host,,}"
  [[ "$host" =~ ^(localhost|.+\.localhost|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|\[::1\])$ ]]
}

# The id of a backup key, as seal.mjs keyId computes it: the first 8 bytes of sha256("crove.backup.key-id|" + key),
# in hex. Fails on anything but 32 bytes as base64 (44 characters) or hex (64). The key moves through builtins and
# pipes only, never a command line.
backup_key_id() {
  local key="$1"
  if [[ "$key" =~ ^[0-9a-fA-F]{64}$ ]]; then
    { printf 'crove.backup.key-id|'; printf "$(printf '%s' "$key" | sed 's/../\\x&/g')"; } | sha256sum | cut -c1-16
  elif [[ "$key" =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]]; then
    { printf 'crove.backup.key-id|'; printf '%s' "$key" | base64 -d; } | sha256sum | cut -c1-16
  else
    return 1
  fi
}

# Runs seal.mjs (key-id, seal <list>, open <list>) in <dir>; see node_run.
seal_run() {
  local dir="$1"
  shift
  node_run "$dir" /crove-backup/seal.mjs "$@"
}

# The sealed size of a file of $1 bytes (seal.mjs sealedSize): a 28-byte header and a 16-byte tag per 64 KiB chunk.
sealed_size() {
  local chunks=$((($1 + 65535) / 65536))
  [ "$chunks" -gt 0 ] || chunks=1
  echo $((28 + $1 + chunks * 16))
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
  for name in MC_HOST_src MC_HOST_dst S3_BUCKET BACKUP_S3_BUCKET BACKUP_S3_PREFIX RUN_ID BLOB_STORE; do
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

# Checks the blobs under <dir> against <sums> (sha256sum lines, paths relative to <dir>). An empty list is a run taken
# while no file existed: it is valid when <dir> holds no file either. `sha256sum -c` alone refuses an empty list ("no
# properly formatted checksum lines"), which made such a run impossible to restore.
check_blob_sums() {
  local dir="$1" sums="$2"
  if [ -s "$sums" ]; then
    (cd "$dir" && sha256sum --quiet -c "$sums")
    return
  fi
  [ ! -d "$dir" ] || [ -z "$(find "$dir" -type f -print -quit)" ]
}

# sha256sum lines in text mode ("<hash>  <name>"): sha256sum on Windows (Git Bash) marks binary mode with "*", which
# the checks here and a Linux `sha256sum -c` would otherwise read as part of the name.
normalize_sums() { sed 's/^\([0-9a-f]\{64\}\) [ *]/\1  /'; }

# A date N days ago as YYYYMMDD (GNU date, else BSD date).
days_ago() { date -u -d "-$1 days" +%Y%m%d 2>/dev/null || date -u -v "-$1d" +%Y%m%d; }
