#!/usr/bin/env bash
# Deploys a Crove release to a single docker compose host, and rolls it back (issue #56, docs/runbooks/deploy.md).
# Runs on the host. The deploy workflow (.github/workflows/deploy.yml) uploads it with the release's
# docker-compose.yml and runs it over SSH; it also installs itself as <dir>/.deploy/deploy.sh, so an operator can
# roll back from a shell on the host with one command.
#
#   deploy.sh deploy --release <id> --image <repo@sha256:...> --extract-image <repo@sha256:...> --compose <file>
#                    [--dir <dir>] [--env-file <file>] [--registry <host> --registry-user <user>
#                    --registry-password-stdin]
#   deploy.sh rollback [--dir <dir>] [--env-file <file>]
#   deploy.sh status   [--dir <dir>]
#   deploy.sh smoke <base url>
#
# Deploy: pull both images by digest, start the database, run `migrate`, start Supabase Auth and run `auth-grants`,
# start the other services, then the app: the worker before the API when they run as separate services (`worker`
# and `api`), else the all-in-one `crove` service. It waits for /readyz (every committed migration in the ledger,
# Supabase Auth grants in place) and runs the smoke test. When anything after the migration fails, it rolls back to
# the release that ran before and exits 1.
#
# Rollback restores images and compose files only. Migrations are forward only: the schema stays where the newer
# release left it, so every migration must keep the previous release working (expand, then contract in a later
# release; plan §3.5).
#
# Exit codes: 0 done; 1 the deploy failed and the previous release runs again (or nothing was changed); 2 bad usage
# or configuration; 3 the deploy failed and so did the rollback: the instance needs an operator.
#
# Needs bash 4+, curl and docker with the compose plugin (v2.24 or newer, for `!reset`).
set -euo pipefail

readonly EXIT_FAILED=1 EXIT_USAGE=2 EXIT_ROLLBACK_FAILED=3

# Git Bash on Windows (the tests) rewrites arguments that look like paths; Linux ignores these.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

DEPLOY_DIR="${CROVE_DEPLOY_DIR:-/opt/crove}"
ENV_FILE="${CROVE_ENV_FILE:-}"
# Seconds: `docker compose up --wait` per step (Supabase Auth may migrate for minutes on an upgrade), /readyz, and
# how long a separate worker must stay running before the API is rolled.
WAIT_TIMEOUT="${CROVE_WAIT_TIMEOUT:-600}"
READY_TIMEOUT="${CROVE_READY_TIMEOUT:-300}"
WORKER_SETTLE="${CROVE_WORKER_SETTLE:-15}"
# Release directories kept on the host (the current and previous ones are never removed).
KEEP_RELEASES="${CROVE_KEEP_RELEASES:-5}"
# Base URL of the smoke test on the host; default: the loopback port the API service publishes.
SMOKE_URL="${CROVE_SMOKE_URL:-}"

log() { printf '[deploy] %s\n' "$*"; }
err() { printf '[deploy] ERROR: %s\n' "$*" >&2; }
die() {
  err "$2"
  exit "$1"
}

# A release id becomes a directory name and a log field: letters, digits, dot, dash and underscore only.
valid_release() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }
# An image pinned by digest: registry/name@sha256:<64 hex>, with an optional tag before the digest.
valid_image() { [[ "$1" =~ ^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$ ]]; }
# An absolute path with no spaces or shell characters (it is written into generated files and the history log).
valid_path() { [[ "$1" =~ ^/[A-Za-z0-9._/@+-]*$ || "$1" =~ ^[A-Za-z]:/[A-Za-z0-9._/@+-]*$ ]]; }

# ---------------------------------------------------------------------------------------------------------------
# Smoke test: what a user needs to sign in. Used on the host (loopback) and by the workflow (public URL).

# smoke_get <url>: prints the body; fails on a connection error, a timeout or a status of 400 or more.
smoke_get() { curl --silent --show-error --fail --location --max-time 15 "$1"; }

# smoke_body <url> <text>: the answer is a success and contains <text>.
smoke_body() {
  local body
  body="$(smoke_get "$1")" || return 1
  [[ "$body" == *"$2"* ]]
}

# The sign-in page: the app shell, and the first script bundle it loads.
smoke_login() {
  local base="$1" page asset
  page="$(smoke_get "$base/login")" || return 1
  [[ "$page" == *'id="root"'* ]] || return 1
  asset="$(grep -o 'src="/assets/[^"]*\.js"' <<<"$page" | head -n 1 | sed 's/^src="//; s/"$//')"
  [ -n "$asset" ] && smoke_get "$base$asset" >/dev/null
}

smoke() {
  local base="${1%/}" failed=0
  smoke_check() {
    local name="$1"
    shift
    if "$@"; then log "smoke ok: $name"; else
      err "smoke failed: $name"
      failed=1
    fi
  }
  smoke_check '/healthz answers ok' smoke_body "$base/healthz" '"ok":true'
  # Every committed migration is in the ledger, and the session check can read Supabase Auth's tables.
  smoke_check '/readyz answers ready' smoke_body "$base/readyz" '"ready":true'
  smoke_check '/api/config answers' smoke_body "$base/api/config" '"authUrl"'
  # Supabase Auth through the kernel's /auth/v1 proxy, the way signing in goes.
  smoke_check '/auth/v1/health answers (Supabase Auth through the proxy)' smoke_body "$base/auth/v1/health" ''
  smoke_check '/login loads the app shell and its script bundle' smoke_login "$base"
  return "$failed"
}

# ---------------------------------------------------------------------------------------------------------------
# State on the host, under $DEPLOY_DIR:
#   .env                         the instance's settings and secrets (owner managed; or --env-file)
#   compose.host.yml             optional owner managed override (reverse proxy, split roles, profiles)
#   docker-compose.yml           the running release's compose file
#   docker-compose.override.yml  the running release's image pins (generated), so plain `docker compose` in this
#                                directory (and tools/backup) sees the same stack
#   releases/<id>-<digest12>/    each deployed release: docker-compose.yml, docker-compose.override.yml, release.env
#   .deploy/current, previous    the release directory names that run now and ran before
#   .deploy/history.log          one line per deploy and rollback
#   .deploy/deploy.sh            this script, for a manual rollback

state_dir() { printf '%s/.deploy' "$DEPLOY_DIR"; }
read_state() { if [ -f "$(state_dir)/$1" ]; then cat "$(state_dir)/$1"; fi; }
write_state() { printf '%s\n' "$2" >"$(state_dir)/$1.tmp" && mv -f "$(state_dir)/$1.tmp" "$(state_dir)/$1"; }
record() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$(state_dir)/history.log"; }

LOCK_HELD=0
acquire_lock() {
  local lock pid
  lock="$(state_dir)/lock"
  if ! mkdir "$lock" 2>/dev/null; then
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then die "$EXIT_USAGE" "another deploy (pid $pid) is running"; fi
    log "removing a stale lock left by pid ${pid:-unknown}"
    rm -rf "$lock"
    mkdir "$lock" || die "$EXIT_USAGE" "cannot take the lock $lock"
  fi
  printf '%s\n' "$$" >"$lock/pid"
  LOCK_HELD=1
}
release_lock() { if [ "$LOCK_HELD" = 1 ]; then rm -rf "$(state_dir)/lock"; fi; }

# docker compose for the active files in $DEPLOY_DIR. The project name comes from the compose file (`crove`) or
# COMPOSE_PROJECT_NAME in the env file, so volumes stay the same from release to release.
dc() {
  local args=(compose --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" -f "$DEPLOY_DIR/docker-compose.override.yml")
  if [ -f "$DEPLOY_DIR/compose.host.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.host.yml"); fi
  docker "${args[@]}" "$@"
}

# Image pins of a release. The images are exported too, so compose.host.yml can use ${CROVE_IMAGE} for services it
# adds (`api` and `worker` with split roles).
write_override() {
  local image="$1" extract="$2"
  cat <<EOF
# Generated by tools/deploy/deploy.sh: the release's images by digest. Do not edit; put local changes in
# compose.host.yml.
services:
  migrate: { image: '$image', build: !reset null }
  auth-grants: { image: '$image', build: !reset null }
  crove: { image: '$image', build: !reset null }
  prober: { image: '$image', build: !reset null }
  usage: { image: '$image', build: !reset null }
  crove-extract: { image: '$extract', build: !reset null }
EOF
}

# Makes a release directory the active files and exports its images.
activate() {
  local rel="$DEPLOY_DIR/releases/$1"
  [ -f "$rel/release.env" ] || die "$EXIT_USAGE" "release directory $rel is incomplete"
  cp -f "$rel/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml.tmp"
  cp -f "$rel/docker-compose.override.yml" "$DEPLOY_DIR/docker-compose.override.yml.tmp"
  mv -f "$DEPLOY_DIR/docker-compose.yml.tmp" "$DEPLOY_DIR/docker-compose.yml"
  mv -f "$DEPLOY_DIR/docker-compose.override.yml.tmp" "$DEPLOY_DIR/docker-compose.override.yml"
  CROVE_IMAGE="$(release_field "$1" IMAGE)"
  CROVE_EXTRACT_IMAGE="$(release_field "$1" EXTRACT_IMAGE)"
  export CROVE_IMAGE CROVE_EXTRACT_IMAGE
}

release_field() { sed -n "s/^$2=//p" "$DEPLOY_DIR/releases/$1/release.env" | head -n 1; }

# Services by role, from the active files and the profiles enabled in the env file (COMPOSE_PROFILES).
SERVICES=()
load_services() {
  local out
  out="$(dc config --services)" || return 1
  mapfile -t SERVICES <<<"$out"
}
has_service() {
  local s
  for s in "${SERVICES[@]}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}
# One-shot jobs and the app are rolled by name; everything else (Supabase Auth, crove-extract, a reverse proxy from
# compose.host.yml) is infrastructure and starts before the app. The prober starts last.
infra_services() {
  local s
  for s in "${SERVICES[@]}"; do
    case "$s" in db | migrate | auth-grants | usage | crove | api | worker | prober | '') ;; *) printf '%s\n' "$s" ;; esac
  done
}

# The app's HTTP service and the loopback URL the smoke test uses.
api_service() { if has_service api; then echo api; else echo crove; fi; }
local_url() {
  local mapped port
  if [ -n "$SMOKE_URL" ]; then
    echo "${SMOKE_URL%/}"
    return
  fi
  mapped="$(dc port "$(api_service)" 8080 | head -n 1)" || return 1
  port="${mapped##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  echo "http://127.0.0.1:$port"
}

wait_ready() {
  local url="$1" deadline=$((SECONDS + READY_TIMEOUT))
  log "waiting for $url/readyz (up to ${READY_TIMEOUT}s)"
  while ((SECONDS < deadline)); do
    if smoke_body "$url/readyz" '"ready":true' 2>/dev/null; then
      log 'ready: every committed migration is applied'
      return 0
    fi
    sleep 3
  done
  err "not ready after ${READY_TIMEOUT}s: $(curl --silent --max-time 5 "$url/readyz" 2>/dev/null || echo 'no answer')"
  return 1
}

up() { dc up --detach --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" "$@"; }

# Rolls the active release's services. The database and the migration are deploy only (step "migrate" in
# do_deploy); a rollback starts here with the older release's files.
roll_services() {
  local infra=() rest=() url s
  load_services || return 1
  mapfile -t infra < <(infra_services)
  if has_service auth; then
    log 'starting Supabase Auth (it migrates its own schema before it is healthy)'
    up auth || return 1
  fi
  if has_service auth-grants; then
    log 'running auth-grants'
    dc run --rm --no-TTY --no-deps auth-grants || return 1
  fi
  for s in "${infra[@]}"; do if [ "$s" != auth ]; then rest+=("$s"); fi; done
  if ((${#rest[@]} > 0)); then
    log "starting ${rest[*]}"
    up "${rest[@]}" || return 1
  fi
  # Worker first (plan §3.5): the worker of a release must run before its API serves.
  if has_service worker && has_service api; then
    log 'rolling the worker'
    dc up --detach --no-build --no-deps worker || return 1
    sleep "$WORKER_SETTLE"
    if ! dc ps --status running --services | grep -qx worker; then
      err 'the worker is not running'
      dc logs --tail 50 worker >&2 || true
      return 1
    fi
    log 'rolling the API'
    up api || return 1
  else
    log 'rolling crove (api and worker in one container)'
    up crove || return 1
  fi
  url="$(local_url)" || {
    err 'cannot find the API port'
    return 1
  }
  wait_ready "$url" || return 1
  if has_service prober; then up prober || return 1; fi
  log "smoke test on $url"
  smoke "$url"
}

pull_images() {
  local image="$1" extract="$2" registry="$3" user="$4" password="$5" cfg rc=0
  # A throwaway Docker config for the registry login, removed right after the pull: no credential stays on the host.
  # Only the plain `docker pull` uses it (compose may live in the default config's cli-plugins).
  cfg="$(mktemp -d)"
  if [ -n "$password" ]; then
    printf '%s' "$password" | DOCKER_CONFIG="$cfg" docker login --username "$user" --password-stdin "$registry" >/dev/null || rc=$?
  fi
  if [ "$rc" = 0 ]; then
    log "pulling $image"
    DOCKER_CONFIG="$cfg" docker pull --quiet "$image" >/dev/null || rc=$?
  fi
  if [ "$rc" = 0 ]; then
    log "pulling $extract"
    DOCKER_CONFIG="$cfg" docker pull --quiet "$extract" >/dev/null || rc=$?
  fi
  rm -rf "$cfg"
  return "$rc"
}

compose_version_ok() {
  local v major minor
  v="$(docker compose version --short 2>/dev/null)" || return 1
  v="${v#v}"
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  ((major > 2 || (major == 2 && minor >= 24)))
}

preflight() {
  valid_path "$DEPLOY_DIR" || die "$EXIT_USAGE" "--dir must be an absolute path without spaces: $DEPLOY_DIR"
  [ -n "$ENV_FILE" ] || ENV_FILE="$DEPLOY_DIR/.env"
  valid_path "$ENV_FILE" || die "$EXIT_USAGE" "--env-file must be an absolute path without spaces: $ENV_FILE"
  [ -f "$ENV_FILE" ] || die "$EXIT_USAGE" "env file $ENV_FILE not found (copy .env.example there and change every secret)"
  command -v docker >/dev/null || die "$EXIT_USAGE" 'docker is not installed'
  command -v curl >/dev/null || die "$EXIT_USAGE" 'curl is not installed'
  compose_version_ok || die "$EXIT_USAGE" 'docker compose v2.24 or newer is required'
  mkdir -p "$(state_dir)" "$DEPLOY_DIR/releases"
}

# Installs this script on the host for manual rollbacks (when it is not already that copy).
install_self() {
  local self target
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  target="$(state_dir)/deploy.sh"
  if [ "$self" != "$target" ]; then cp -f "$self" "$target.tmp" && chmod 0755 "$target.tmp" && mv -f "$target.tmp" "$target"; fi
}

prune_releases() {
  local current previous keep=0 d name
  current="$(read_state current)"
  previous="$(read_state previous)"
  # Newest first, by the deploy time recorded in each release.env.
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    name="$(basename "$d")"
    keep=$((keep + 1))
    if ((keep > KEEP_RELEASES)) && [ "$name" != "$current" ] && [ "$name" != "$previous" ]; then
      log "removing old release $name"
      rm -rf "$d"
    fi
  done < <(for d in "$DEPLOY_DIR"/releases/*/; do [ -f "$d/release.env" ] && printf '%s %s\n' "$(sed -n 's/^STAGED_AT=//p' "$d/release.env")" "${d%/}"; done | sort -r | cut -d' ' -f2-)
}

# Rolls back to a release after a failed deploy or rollback. Exit 1 when it is serving again, 3 when not.
recover() {
  local target="$1" what="$2"
  if [ -z "$target" ]; then
    record "$what failed, nothing to roll back to"
    die "$EXIT_FAILED" "$what failed and there is no earlier release to roll back to; the failed release is left as it is"
  fi
  log "rolling back to $target"
  activate "$target"
  if roll_services; then
    record "$what failed, rolled back to $target"
    die "$EXIT_FAILED" "$what failed; rolled back to $target, which serves again"
  fi
  record "$what failed, rollback to $target FAILED"
  die "$EXIT_ROLLBACK_FAILED" "$what failed and the rollback to $target failed too: the instance needs an operator"
}

do_deploy() {
  local release="" image="" extract="" compose="" registry="" user="" password="" read_password=0
  while (($# > 0)); do
    case "$1" in
      --release) release="${2:-}"; shift 2 ;;
      --image) image="${2:-}"; shift 2 ;;
      --extract-image) extract="${2:-}"; shift 2 ;;
      --compose) compose="${2:-}"; shift 2 ;;
      --dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
      --env-file) ENV_FILE="${2:-}"; shift 2 ;;
      --registry) registry="${2:-}"; shift 2 ;;
      --registry-user) user="${2:-}"; shift 2 ;;
      --registry-password-stdin) read_password=1; shift ;;
      *) die "$EXIT_USAGE" "unknown option $1" ;;
    esac
  done
  valid_release "$release" || die "$EXIT_USAGE" "--release must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}: '$release'"
  valid_image "$image" || die "$EXIT_USAGE" "--image must be pinned by digest (name@sha256:...): '$image'"
  valid_image "$extract" || die "$EXIT_USAGE" "--extract-image must be pinned by digest (name@sha256:...): '$extract'"
  [ -f "$compose" ] || die "$EXIT_USAGE" "--compose file not found: '$compose'"
  if ((read_password)); then
    [[ "$registry" =~ ^[a-z0-9.-]+(:[0-9]+)?$ ]] || die "$EXIT_USAGE" "--registry must be a host name: '$registry'"
    [[ "$user" =~ ^[A-Za-z0-9._-]+(\[bot\])?$ ]] || die "$EXIT_USAGE" "--registry-user is required with --registry-password-stdin"
    IFS= read -r password || true
    [ -n "$password" ] || die "$EXIT_USAGE" 'no registry password on stdin'
  fi
  preflight
  acquire_lock
  trap release_lock EXIT
  install_self

  local digest name dir current
  digest="${image##*@sha256:}"
  name="$release-${digest:0:12}"
  dir="$DEPLOY_DIR/releases/$name"
  current="$(read_state current)"
  log "deploying $release ($name); running now: ${current:-nothing}"

  # Stage the release (before anything changes, so a failure here leaves the running stack alone).
  mkdir -p "$dir"
  cp -f "$compose" "$dir/docker-compose.yml"
  write_override "$image" "$extract" >"$dir/docker-compose.override.yml"
  printf 'RELEASE=%s\nIMAGE=%s\nEXTRACT_IMAGE=%s\nSTAGED_AT=%s\n' "$release" "$image" "$extract" "$(date -u +%Y%m%dT%H%M%SZ)" >"$dir/release.env"

  if ! pull_images "$image" "$extract" "$registry" "$user" "$password"; then
    record "deploy $name failed: pull"
    die "$EXIT_FAILED" 'pulling the images failed; nothing was changed'
  fi
  password=''

  activate "$name"
  # Check the merged files before touching any container.
  if ! dc config --quiet; then
    if [ -n "$current" ]; then activate "$current"; fi
    record "deploy $name failed: compose config"
    die "$EXIT_FAILED" 'the compose files do not load with this env file; nothing was changed'
  fi

  log 'starting the database'
  if ! up db; then
    recover "$current" "deploy $name (database)"
  fi
  # Migrations first, with the new image. They are forward only: the running release keeps working on the new
  # schema (expand and contract), so a failure here needs no rollback of the services.
  log 'running migrations'
  if ! dc run --rm --no-TTY --no-deps migrate; then
    if [ -n "$current" ]; then activate "$current"; fi
    record "deploy $name failed: migrate"
    die "$EXIT_FAILED" "migrations failed; the services were not changed${current:+ ($current still runs)}. Fix forward with a new migration"
  fi

  if ! roll_services; then
    recover "$current" "deploy $name"
  fi

  if [ "$current" != "$name" ]; then
    if [ -n "$current" ]; then write_state previous "$current"; fi
    write_state current "$name"
  fi
  record "deploy $name ok image=$image extract=$extract"
  prune_releases
  log "deployed $release ($name)"
}

do_rollback() {
  while (($# > 0)); do
    case "$1" in
      --dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
      --env-file) ENV_FILE="${2:-}"; shift 2 ;;
      *) die "$EXIT_USAGE" "unknown option $1" ;;
    esac
  done
  preflight
  acquire_lock
  trap release_lock EXIT
  install_self
  local current previous
  current="$(read_state current)"
  previous="$(read_state previous)"
  [ -n "$previous" ] || die "$EXIT_USAGE" 'no previous release is recorded; deploy a release instead'
  [ -d "$DEPLOY_DIR/releases/$previous" ] || die "$EXIT_USAGE" "the previous release $previous is no longer on the host"
  log "rolling back from ${current:-nothing} to $previous (images and compose files only; the schema stays)"
  activate "$previous"
  if ! roll_services; then
    recover "$current" "rollback to $previous"
  fi
  # Swap, so a second rollback returns to the release just left.
  write_state previous "$current"
  write_state current "$previous"
  record "rollback to $previous ok"
  log "rolled back to $previous"
}

do_status() {
  while (($# > 0)); do
    case "$1" in
      --dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
      *) die "$EXIT_USAGE" "unknown option $1" ;;
    esac
  done
  printf 'current:  %s\nprevious: %s\n' "$(read_state current)" "$(read_state previous)"
  if [ -f "$(state_dir)/history.log" ]; then tail -n 10 "$(state_dir)/history.log"; fi
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    deploy) do_deploy "$@" ;;
    rollback) do_rollback "$@" ;;
    status) do_status "$@" ;;
    smoke)
      [ -n "${1:-}" ] || die "$EXIT_USAGE" 'usage: deploy.sh smoke <base url>'
      smoke "$1" || die "$EXIT_FAILED" "smoke test failed on $1"
      ;;
    *) die "$EXIT_USAGE" 'usage: deploy.sh deploy|rollback|status|smoke (see the header of this file)' ;;
  esac
}

main "$@"
