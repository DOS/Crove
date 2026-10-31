#!/usr/bin/env bash
# Deploys a Crove release to a single docker compose host, and rolls it back (issue #56, docs/runbooks/deploy.md).
# Runs on the host. The deploy workflow (.github/workflows/deploy.yml) uploads it with the release's
# docker-compose.yml and runs it over SSH; it also installs itself as <dir>/.deploy/deploy.sh, so an operator can
# roll back from a shell on the host with one command.
#
#   deploy.sh deploy --release <id> --image <repo@sha256:...> --extract-image <repo@sha256:...> --compose <file>
#                    [--build <id>] [--dir <dir>] [--env-file <file>] [--registry <host> --registry-user <user>
#                    --registry-password-stdin]
#   deploy.sh rollback [--dir <dir>] [--env-file <file>]
#   deploy.sh status   [--dir <dir>]
#   deploy.sh smoke <base url> [build id]
#
# compose.pilot.yml (the pilot's split API and worker, #2133) is taken from the directory of the --compose file and
# staged with the release; the host chooses the layout by listing it in COMPOSE_FILE of the env file. A --compose file
# with no sibling falls back to the copy on the host, or stops before pulling when there is none.
#
# Smoke: the checks a user needs to sign in (health, readiness, config, Supabase Auth, the sign-in page), and, with
# SMOKE_EMAIL, SMOKE_PASSWORD and SMOKE_ORG set, an account step that signs in and uploads one synthetic e-invoice
# (see smoke_account). Without them it says the account step is skipped. With a build id (#892: the git SHA the image
# was built from, its CROVE_BUILD) it also checks that /version reports that build and no missing migration, so an
# old container that still answers fails the test. A deploy given --build checks the same, and so does a rollback to
# a release that was deployed with one; a release without a build id (deployed before /version) skips that step.
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
# Order of separate services (plan §3.5, #1965): toward a newer build the worker before the API, toward an older one
# the API before the worker, so a newer API does not serve beside an older worker (whose work it may not know; its
# /readyz answers 503 worker_build then, #1952). A build is older by the build time its image carries
# (CROVE_BUILD_TIME, the commit's date, recorded as BUILD_EPOCH in release.env), so a deploy of an older tag rolls the
# API first and the rollback from it the worker first; between releases without one (images from before #1952), by
# the time each was deployed (STAGED_AT).
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
# Seconds the account step of the smoke test waits for the worker to turn its upload into a proposal.
SMOKE_POLL_SECONDS="${CROVE_SMOKE_POLL_SECONDS:-120}"

# Output may go to an SSH session that has dropped (see the signal traps in main): a failed write never stops a
# deploy halfway.
log() { printf '[deploy] %s\n' "$*" 2>/dev/null || true; }
err() { printf '[deploy] ERROR: %s\n' "$*" >&2 2>/dev/null || true; }
die() {
  err "$2"
  exit "$1"
}

# A release id becomes a directory name and a log field: letters, digits, dot, dash and underscore only.
valid_release() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }
# An image pinned by digest: registry/name@sha256:<64 hex>, with an optional tag before the digest.
valid_image() { [[ "$1" =~ ^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$ ]]; }
# A build id (#892): the git SHA the image was built from, or another id of letters, digits, dot, dash and underscore.
valid_build() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; }
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

# The account step (#690): sign in with a password, upload one synthetic e-invoice into the smoke org, wait until the
# worker extracts it into a proposal, then reject that proposal so the smoke org's inbox stays empty. It runs only
# where SMOKE_EMAIL and SMOKE_PASSWORD are set: the workflow's public smoke test, from the environment's secrets
# (docs/runbooks/deploy.md, "Smoke account"). SMOKE_ORG is the smoke org's slug. Needs jq.
#
# Neither the password nor the access token is ever on a command line: the sign-in body is built by jq from the
# environment and piped to curl, and the token goes to curl in a header file only this user can read.

# The synthetic e-invoice: a fixed fake seller and buyer (tax codes that fail the checksum, so they belong to nobody)
# and a number from the clock, so each run files a new document instead of a duplicate of the last one.
smoke_invoice() {
  local number="$1" day="$2"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon Id="data">
    <TTChung>
      <PBan>2.1.0</PBan><THDon>HÓA ĐƠN GIÁ TRỊ GIA TĂNG</THDon><KHMSHDon>1</KHMSHDon><KHHDon>C26SMK</KHHDon>
      <SHDon>$number</SHDon><NLap>$day</NLap><DVTTe>VND</DVTTe><TGia>1</TGia><HTTToan>TM/CK</HTTToan>
    </TTChung>
    <NDHDon>
      <NBan><Ten>CÔNG TY KIỂM THỬ TRIỂN KHAI</Ten><MST>0101234564</MST><DChi>1 Đường Mẫu, Hà Nội</DChi></NBan>
      <NMua><Ten>TỔ CHỨC KIỂM THỬ CROVE</Ten><MST>0309876546</MST><DChi>2 Đường Thử, TP Hồ Chí Minh</DChi></NMua>
      <DSHHDVu>
        <HHDVu>
          <TChat>1</TChat><STT>1</STT><THHDVu>Kiểm thử sau triển khai</THHDVu><DVTinh>Lần</DVTinh>
          <SLuong>1</SLuong><DGia>100000</DGia><ThTien>100000</ThTien><TSuat>10%</TSuat>
        </HHDVu>
      </DSHHDVu>
      <TToan>
        <THTTLTSuat><LTSuat><TSuat>10%</TSuat><ThTien>100000</ThTien><TThue>10000</TThue></LTSuat></THTTLTSuat>
        <TgTCThue>100000</TgTCThue><TgTThue>10000</TgTThue><TgTTTBSo>110000</TgTTTBSo>
        <TgTTTBChu>Một trăm mười nghìn đồng</TgTTTBChu>
      </TToan>
    </NDHDon>
  </DLHDon>
</HDon>
EOF
}

# smoke_version <base> <build>: /version reports this build and no committed migration missing from the ledger.
smoke_version() {
  local body
  body="$(smoke_get "$1/version")" || return 1
  if [[ "$body" != *"\"build\":\"$2\""* || "$body" != *'"migrationsMissing":[]'* ]]; then
    err "smoke: expected build $2 with no missing migration; /version answered: ${body:0:500}"
    return 1
  fi
}

# smoke_api <headers file> <url> [curl args...]: like smoke_get, as the signed-in user, without following redirects.
smoke_api() {
  local headers="$1" url="$2"
  shift 2
  curl --silent --show-error --fail --max-time 30 --header "@$headers" "$@" "$url"
}

# smoke_rpc <headers file> <base> <procedure> [input json]: the web app's oRPC call, POST /api/rpc/<procedure>.
smoke_rpc() {
  local body='{}'
  if [ -n "${4:-}" ]; then body="{\"json\":$4}"; fi
  smoke_api "$1" "$2/api/rpc/$3" --request POST --header 'content-type: application/json' --data-binary "$body"
}

smoke_account() {
  local base="$1" work token headers number answer file_id status proposal error deadline rc=1
  command -v jq >/dev/null || {
    err 'the account step needs jq'
    return 1
  }
  # The password never travels in clear text.
  [[ "$base" == https://* || "$base" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] || {
    err 'the account step signs in only over https'
    return 1
  }
  [[ "${SMOKE_ORG:-}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || {
    err 'SMOKE_ORG must be the smoke org'"'"'s slug (lowercase letters, digits and dashes)'
    return 1
  }
  work="$(mktemp -d)" || return 1
  (
    umask 077
    headers="$work/headers"
    answer="$(jq -n '{email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD}' |
      curl --silent --show-error --fail --max-time 15 --request POST --header 'content-type: application/json' \
        --data-binary @- "$base/auth/v1/token?grant_type=password")" || {
      err 'smoke: signing in with SMOKE_EMAIL and SMOKE_PASSWORD failed'
      exit 1
    }
    token="$(jq -r '.access_token // empty' <<<"$answer")"
    # A JWT: written into the header file below, so nothing else (no line break) may come with it.
    [[ "$token" =~ ^[A-Za-z0-9._-]+$ ]] || {
      err 'smoke: sign-in answered without an access token'
      exit 1
    }
    printf 'authorization: Bearer %s\nx-crove-org: %s\n' "$token" "$SMOKE_ORG" >"$headers"

    number="$(date -u +%s)"
    smoke_invoice "$number" "$(date -u +%F)" >"$work/crove-smoke-$number.xml"
    answer="$(smoke_api "$headers" "$base/api/files" --form "file=@$work/crove-smoke-$number.xml;type=application/xml")" || {
      err "smoke: uploading the synthetic e-invoice to org $SMOKE_ORG failed"
      exit 1
    }
    file_id="$(jq -r '.files[0].fileId // empty' <<<"$answer")"
    [ -n "$file_id" ] || {
      err 'smoke: the upload answered without a file id'
      exit 1
    }

    deadline=$((SECONDS + SMOKE_POLL_SECONDS))
    while :; do
      answer="$(smoke_rpc "$headers" "$base" files/recent)" || {
        err 'smoke: listing the recent files failed'
        exit 1
      }
      # One field per line, so an empty field stays empty (a whitespace IFS would merge it with the next one); line
      # breaks in the error text become spaces, so it stays one log line.
      {
        IFS= read -r status
        IFS= read -r proposal
        IFS= read -r error
      } < <(jq -r --arg id "$file_id" 'first(.json[]? | select(.id == $id)) // {} | (.status // ""), (.proposalId // ""), (.error // "" | gsub("[\r\n]"; " "))' <<<"$answer")
      if [ "$status" = proposed ] && [ -n "$proposal" ]; then break; fi
      if [ "$status" = failed ]; then
        err "smoke: the worker could not extract the synthetic e-invoice: $error"
        exit 1
      fi
      if ((SECONDS >= deadline)); then
        err "smoke: no proposal after ${SMOKE_POLL_SECONDS}s (file ${status:-not listed})"
        exit 1
      fi
      sleep 2
    done

    smoke_rpc "$headers" "$base" inbox/reject "$(jq -cn --arg id "$proposal" '{id: $id, reason: "Kiểm thử sau triển khai"}')" >/dev/null || {
      err "smoke: rejecting the smoke proposal $proposal failed"
      exit 1
    }
  ) && rc=0
  rm -rf "$work"
  return "$rc"
}

# smoke <base url> [account] [build]: with "account" (the `smoke` command), the account step runs too when its settings
# are there. The deploy's own smoke test on the host never runs it: the workflow's public smoke test does, and a
# rollback must not depend on the smoke account, or a broken account would fail the rollback too. With a build id,
# /version must report it (#892).
smoke() {
  local base="${1%/}" account="${2:-}" build="${3:-}" failed=0
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
  if [ -n "$build" ]; then
    smoke_check "/version answers build $build with every migration applied" smoke_version "$base" "$build"
  fi
  smoke_check '/api/config answers' smoke_body "$base/api/config" '"authUrl"'
  # Supabase Auth through the kernel's /auth/v1 proxy, the way signing in goes.
  smoke_check '/auth/v1/health answers (Supabase Auth through the proxy)' smoke_body "$base/auth/v1/health" ''
  smoke_check '/login loads the app shell and its script bundle' smoke_login "$base"
  if [ "$account" = account ]; then
    if [ -n "${SMOKE_EMAIL:-}" ] && [ -n "${SMOKE_PASSWORD:-}" ]; then
      smoke_check "signs in, uploads a synthetic e-invoice to org ${SMOKE_ORG:-?} and gets a proposal" smoke_account "$base"
    else
      log 'smoke skipped: sign-in and upload (SMOKE_EMAIL and SMOKE_PASSWORD are not set)'
    fi
  fi
  return "$failed"
}

# ---------------------------------------------------------------------------------------------------------------
# State on the host, under $DEPLOY_DIR:
#   .env                         the instance's settings and secrets (owner managed; or --env-file)
#   compose.host.yml             optional owner managed override (reverse proxy, split roles, profiles)
#   compose.pilot.yml            the split API and worker with the finance module only (tools/deploy/compose.pilot.yml), copied
#                                from the active release when the env file's COMPOSE_FILE lists it; unused otherwise
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
    # No pid yet: another run may have just taken the lock. Only a lock older than a minute is stale.
    if [ -z "$pid" ] && [ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      die "$EXIT_USAGE" 'another deploy is starting'
    fi
    log "removing a stale lock left by pid ${pid:-unknown}"
    rm -rf "$lock"
    mkdir "$lock" || die "$EXIT_USAGE" "cannot take the lock $lock"
  fi
  printf '%s\n' "$$" >"$lock/pid"
  LOCK_HELD=1
}
release_lock() { if [ "$LOCK_HELD" = 1 ]; then rm -rf "$(state_dir)/lock"; fi; }

# The registry login's throwaway Docker config (pull_images); removed on every exit.
PULL_CONFIG=''
cleanup() {
  if [ -n "$PULL_CONFIG" ]; then rm -rf "$PULL_CONFIG"; fi
  release_lock
}

# What runs in a deploy or rollback, for the history log when it is stopped.
CURRENT_WORK=''
on_signal() {
  record "${CURRENT_WORK:-run} interrupted by a signal; check the stack (deploy.sh status, docker compose ps)"
  err 'interrupted; the stack may be half rolled'
  exit 143
}

# Called once the lock is held. A dropped SSH session (a cancelled job, a network blip) must not stop a deploy
# halfway: hangups and writes to the closed connection are ignored, and the run finishes and records its result.
# An explicit stop (TERM, INT) is recorded in the history log.
guard_run() {
  CURRENT_WORK="$1"
  trap cleanup EXIT
  trap '' HUP PIPE
  trap on_signal TERM INT
}

# docker compose for the active files in $DEPLOY_DIR. The project name comes from the compose file (`crove`) or
# COMPOSE_PROJECT_NAME in the env file, so volumes stay the same from release to release.
dc() {
  local args=(compose --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml")
  # The pilot's split API and worker (tools/deploy/compose.pilot.yml, #2118) right after the release's file: they extend its
  # `crove` service, whose image the release's pins (next) must then replace. The host chooses the layout by listing the file
  # in COMPOSE_FILE (#2133); the file itself comes with each release (activate), so it stays in step with docker-compose.yml.
  if pilot_layout && [ -f "$DEPLOY_DIR/compose.pilot.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.pilot.yml"); fi
  args+=(-f "$DEPLOY_DIR/docker-compose.override.yml")
  # The database image with pgBackRest and the bucket's settings (tools/backup/compose.wal.yml, #2120). The image
  # (crove-db:local, built from tools/wal) is on the host, never pulled: a deploy starts `db` with --no-build.
  if [ -f "$DEPLOY_DIR/compose.wal.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.wal.yml"); fi
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

# Whether the host runs the pilot's split API and worker: its env file lists compose.pilot.yml in COMPOSE_FILE (the same
# line `pnpm pilot:check` reads). Read each time, so taking the file out of COMPOSE_FILE is all it takes to go back to one
# container (#2133).
pilot_layout() {
  # The last assignment wins, as in a dotenv file: `export` and spaces around `=` are allowed, a trailing ` # comment` is not
  # part of the value, and a commented-out line is not an assignment.
  sed -n -E 's/\r$//; s/^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" \
    | tail -n 1 | sed -E 's/[[:space:]]+#.*$//' | grep -q 'compose\.pilot\.yml'
}

# In the pilot layout, the same image pins for `api` and `worker`, so a plain `docker compose` in the stack directory
# (tools/backup/restore.sh, a manual `up`) runs the release's digest, not crove:local. Only in that layout: an `api` service
# defined by a pin alone would run the all-in-one role with no settings, and `has_service` would roll it.
pilot_pins() {
  pilot_layout || return 0
  printf "  api: { image: '%s', build: !reset null }\n  worker: { image: '%s', build: !reset null }\n" "$1" "$1"
}

# Makes a release directory the active files and exports its images.
ACTIVE_BUILD=''
activate() {
  local rel="$DEPLOY_DIR/releases/$1"
  [ -f "$rel/release.env" ] || die "$EXIT_USAGE" "release directory $rel is incomplete"
  rm -f "$DEPLOY_DIR/compose.pilot.yml.tmp"
  cp -f "$rel/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml.tmp"
  cp -f "$rel/docker-compose.override.yml" "$DEPLOY_DIR/docker-compose.override.yml.tmp"
  CROVE_IMAGE="$(release_field "$1" IMAGE)"
  CROVE_EXTRACT_IMAGE="$(release_field "$1" EXTRACT_IMAGE)"
  # The pins of `api` and `worker` follow the layout of now, whatever the release was staged under: taken out of a release
  # staged in the pilot layout when the host has gone back to one container (they would define bare services), put in
  # one staged before (#2133).
  { grep -v -E "^  (api|worker): \{ image:" "$DEPLOY_DIR/docker-compose.override.yml.tmp" || true; } >"$DEPLOY_DIR/docker-compose.override.yml.pins"
  mv -f "$DEPLOY_DIR/docker-compose.override.yml.pins" "$DEPLOY_DIR/docker-compose.override.yml.tmp"
  pilot_pins "$CROVE_IMAGE" >>"$DEPLOY_DIR/docker-compose.override.yml.tmp"
  # The pilot file ships with the release. A release staged before that (a rollback to it) keeps the host's copy.
  if pilot_layout; then
    if [ -f "$rel/compose.pilot.yml" ]; then
      cp -f "$rel/compose.pilot.yml" "$DEPLOY_DIR/compose.pilot.yml.tmp"
    elif [ ! -f "$DEPLOY_DIR/compose.pilot.yml" ]; then
      die "$EXIT_USAGE" "COMPOSE_FILE in $ENV_FILE lists compose.pilot.yml but release $1 does not carry it and $DEPLOY_DIR has none (docs/runbooks/deploy.md, \"The pilot layout\")"
    fi
  fi
  # The three files are moved in a row, so a plain `docker compose` (the backup cron) sees them together as nearly as it can.
  if [ -f "$DEPLOY_DIR/compose.pilot.yml.tmp" ]; then mv -f "$DEPLOY_DIR/compose.pilot.yml.tmp" "$DEPLOY_DIR/compose.pilot.yml"; fi
  mv -f "$DEPLOY_DIR/docker-compose.yml.tmp" "$DEPLOY_DIR/docker-compose.yml"
  mv -f "$DEPLOY_DIR/docker-compose.override.yml.tmp" "$DEPLOY_DIR/docker-compose.override.yml"
  export CROVE_IMAGE CROVE_EXTRACT_IMAGE
  # The build the release's image reports on /version; empty for a release deployed without --build.
  ACTIVE_BUILD="$(release_field "$1" BUILD)"
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

# Asks at least once before it looks at the clock: SECONDS counts whole seconds, so with a short timeout the deadline
# can pass before the first question, and an instance that is ready would be taken for one that never got ready (#1841).
wait_ready() {
  local url="$1" deadline=$((SECONDS + READY_TIMEOUT))
  log "waiting for $url/readyz (up to ${READY_TIMEOUT}s)"
  while :; do
    if smoke_body "$url/readyz" '"ready":true' 2>/dev/null; then
      log 'ready: every committed migration is applied'
      return 0
    fi
    ((SECONDS < deadline)) || break
    sleep 3
  done
  err "not ready after ${READY_TIMEOUT}s: $(curl --silent --max-time 5 "$url/readyz" 2>/dev/null || echo 'no answer')"
  return 1
}

up() { dc up --detach --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" "$@"; }

# The build time an image carries (CROVE_BUILD_TIME, #1952), in seconds since the epoch; nothing when it has none or
# the image is not on the host.
image_build_epoch() {
  local t
  t="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n 's/^CROVE_BUILD_TIME=//p' | head -n 1)" || true
  [ -n "$t" ] || return 0
  date -u -d "$t" +%s 2>/dev/null || true
}

# direction_to <release> <from release>: forward when the release's build is not older than the one it replaces, back
# when it is. By BUILD_EPOCH when both have one, else by STAGED_AT; forward when nothing runs.
direction_to() {
  local to="$1" from="$2" a b
  if [ -z "$from" ]; then
    echo forward
    return
  fi
  a="$(release_field "$to" BUILD_EPOCH)"
  b="$(release_field "$from" BUILD_EPOCH)"
  if [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ ]]; then
    if ((a < b)); then echo back; else echo forward; fi
    return
  fi
  if [[ "$(release_field "$to" STAGED_AT)" < "$(release_field "$from" STAGED_AT)" ]]; then echo back; else echo forward; fi
}

# Rolls the worker of the active release when it runs as its own service, and checks it stays up.
roll_worker() {
  log 'rolling the worker'
  dc up --detach --no-build --no-deps worker || return 1
  sleep "$WORKER_SETTLE"
  if ! dc ps --status running --services | grep -qx worker; then
    err 'the worker is not running'
    dc logs --tail 50 worker >&2 || true
    return 1
  fi
}

# roll_services [forward|back]: rolls the active release's services. The database and the migration are deploy only
# (step "migrate" in do_deploy); a rollback starts here with the older release's files. forward (toward a newer build,
# the default) rolls a separate worker before the API, back (toward an older one) the API before the worker (see the
# header and direction_to).
roll_services() {
  local direction="${1:-forward}" infra=() rest=() url s
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
  if has_service worker && has_service api; then
    # The first deploy of the pilot layout on a host that ran the all-in-one `crove`: that container would keep the API's
    # port and run the worker's jobs beside the new one (#2118). Nothing to remove on a later deploy.
    local removed
    if ! removed="$(dc rm --stop --force crove 2>&1)"; then log "could not remove the old crove container (the deploy goes on): ${removed:0:300}"; fi
    if [ "$direction" = back ]; then
      log 'rolling the API (toward an older build: the API before the worker)'
      up api || return 1
      roll_worker || return 1
    else
      roll_worker || return 1
      log 'rolling the API'
      up api || return 1
    fi
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
  smoke "$url" '' "$ACTIVE_BUILD"
}

pull_images() {
  local image="$1" extract="$2" registry="$3" user="$4" password="$5" rc=0
  # A throwaway Docker config for the registry login, removed right after the pull (and by cleanup on any exit): no
  # credential stays on the host. Only the plain `docker pull` uses it (compose may live in the default config's
  # cli-plugins).
  PULL_CONFIG="$(mktemp -d)"
  if [ -n "$password" ]; then
    printf '%s' "$password" | DOCKER_CONFIG="$PULL_CONFIG" docker login --username "$user" --password-stdin "$registry" >/dev/null || rc=$?
  fi
  if [ "$rc" = 0 ]; then
    log "pulling $image"
    DOCKER_CONFIG="$PULL_CONFIG" docker pull --quiet "$image" >/dev/null || rc=$?
  fi
  if [ "$rc" = 0 ]; then
    log "pulling $extract"
    DOCKER_CONFIG="$PULL_CONFIG" docker pull --quiet "$extract" >/dev/null || rc=$?
  fi
  rm -rf "$PULL_CONFIG"
  PULL_CONFIG=''
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
  # The WAL archiving overlay (#2120) stays the host's own file: without it the deploy would recreate `db` on the plain PostgreSQL image,
  # while the volume still tells PostgreSQL to push every WAL segment with a command that image does not have.
  if sed -n 's/^COMPOSE_FILE=//p' "$ENV_FILE" | tail -n 1 | grep -q 'compose\.wal\.yml' && [ ! -f "$DEPLOY_DIR/compose.wal.yml" ]; then
    die "$EXIT_USAGE" "COMPOSE_FILE in $ENV_FILE lists compose.wal.yml but $DEPLOY_DIR/compose.wal.yml does not exist: copy tools/backup/compose.wal.yml there (docs/runbooks/backup-and-restore.md, \"Point in time recovery\")"
  fi
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
  [ "$self" != "$target" ] || return 0
  if ! { cp -f "$self" "$target.tmp" && chmod 0755 "$target.tmp" && mv -f "$target.tmp" "$target"; }; then
    err "could not install $target; a manual rollback needs a copy of this script"
  fi
}

prune_releases() {
  local current previous keep=0 d name
  current="$(read_state current)"
  previous="$(read_state previous)"
  # Newest first, by the time each release was staged (recorded in its release.env).
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    name="$(basename "$d")"
    keep=$((keep + 1))
    if ((keep > KEEP_RELEASES)) && [ "$name" != "$current" ] && [ "$name" != "$previous" ]; then
      log "removing old release $name"
      rm -rf "$d"
    fi
  done < <(for d in "$DEPLOY_DIR"/releases/*/; do if [ -f "$d/release.env" ]; then printf '%s %s\n' "$(sed -n 's/^STAGED_AT=//p' "$d/release.env")" "${d%/}"; fi; done | sort -r | cut -d' ' -f2-)
}

# recover <release> <what> <failed release>: rolls back to a release after a failed deploy or rollback, in the order
# its build needs against the failed one (direction_to). Exit 1 when it is serving again, 3 when not.
recover() {
  local target="$1" what="$2" failed="$3"
  if [ -z "$target" ]; then
    record "$what failed, nothing to roll back to"
    die "$EXIT_FAILED" "$what failed and there is no earlier release to roll back to; the failed release is left as it is"
  fi
  log "rolling back to $target"
  activate "$target"
  if roll_services "$(direction_to "$target" "$failed")"; then
    record "$what failed, rolled back to $target"
    die "$EXIT_FAILED" "$what failed; rolled back to $target, which serves again"
  fi
  record "$what failed, rollback to $target FAILED"
  die "$EXIT_ROLLBACK_FAILED" "$what failed and the rollback to $target failed too: the instance needs an operator"
}

# Options both deploy and rollback take. Sets OPT_SHIFT to the number of arguments used (0: not one of these).
REGISTRY='' REGISTRY_USER='' REGISTRY_PASSWORD='' READ_PASSWORD=0 OPT_SHIFT=0
common_option() {
  OPT_SHIFT=2
  case "$1" in
    --dir) DEPLOY_DIR="${2:-}" ;;
    --env-file) ENV_FILE="${2:-}" ;;
    --registry) REGISTRY="${2:-}" ;;
    --registry-user) REGISTRY_USER="${2:-}" ;;
    --registry-password-stdin) READ_PASSWORD=1 OPT_SHIFT=1 ;;
    *) OPT_SHIFT=0 ;;
  esac
}

# Reads the registry password from stdin (one line) when asked to; never from an argument or the environment.
read_registry_password() {
  ((READ_PASSWORD)) || return 0
  [[ "$REGISTRY" =~ ^[a-z0-9.-]+(:[0-9]+)?$ ]] || die "$EXIT_USAGE" "--registry must be a host name: '$REGISTRY'"
  [[ "$REGISTRY_USER" =~ ^[A-Za-z0-9._-]+(\[bot\])?$ ]] || die "$EXIT_USAGE" "--registry-user is required with --registry-password-stdin"
  IFS= read -r REGISTRY_PASSWORD || true
  [ -n "$REGISTRY_PASSWORD" ] || die "$EXIT_USAGE" 'no registry password on stdin'
}

do_deploy() {
  local release="" image="" extract="" compose="" build="" build_given=0
  while (($# > 0)); do
    case "$1" in
      --release) release="${2:-}"; shift 2 ;;
      --image) image="${2:-}"; shift 2 ;;
      --extract-image) extract="${2:-}"; shift 2 ;;
      --compose) compose="${2:-}"; shift 2 ;;
      --build) build="${2:-}"; build_given=1; shift 2 ;;
      *)
        common_option "$@"
        ((OPT_SHIFT > 0)) || die "$EXIT_USAGE" "unknown option $1"
        shift "$OPT_SHIFT"
        ;;
    esac
  done
  valid_release "$release" || die "$EXIT_USAGE" "--release must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}: '$release'"
  valid_image "$image" || die "$EXIT_USAGE" "--image must be pinned by digest (name@sha256:...): '$image'"
  valid_image "$extract" || die "$EXIT_USAGE" "--extract-image must be pinned by digest (name@sha256:...): '$extract'"
  [ -f "$compose" ] || die "$EXIT_USAGE" "--compose file not found: '$compose'"
  ((build_given == 0)) || valid_build "$build" || die "$EXIT_USAGE" "--build must match [A-Za-z0-9._-]{1,64}: '$build'"
  read_registry_password
  preflight
  acquire_lock

  local digest name dir current
  digest="${image##*@sha256:}"
  name="$release-${digest:0:12}"
  dir="$DEPLOY_DIR/releases/$name"
  guard_run "deploy $name"
  install_self
  current="$(read_state current)"
  log "deploying $release ($name); running now: ${current:-nothing}"

  # Stage the release (before anything changes, so a failure here leaves the running stack alone).
  mkdir -p "$dir"
  cp -f "$compose" "$dir/docker-compose.yml"
  # The pilot's compose file travels with the release, from the directory of its compose file.
  if [ -f "$(dirname "$compose")/compose.pilot.yml" ]; then cp -f "$(dirname "$compose")/compose.pilot.yml" "$dir/compose.pilot.yml"; fi
  write_override "$image" "$extract" >"$dir/docker-compose.override.yml"
  # In the pilot layout the release, or at least the host, must have the file: found out now, before anything is pulled or changed.
  if pilot_layout && [ ! -f "$dir/compose.pilot.yml" ] && [ ! -f "$DEPLOY_DIR/compose.pilot.yml" ]; then
    die "$EXIT_USAGE" "COMPOSE_FILE in $ENV_FILE lists compose.pilot.yml but this release does not carry it (it ships tools/deploy/compose.pilot.yml next to its compose file) and $DEPLOY_DIR has none"
  fi
  printf 'RELEASE=%s\nIMAGE=%s\nEXTRACT_IMAGE=%s\nBUILD=%s\nSTAGED_AT=%s\n' "$release" "$image" "$extract" "$build" "$(date -u +%Y%m%dT%H%M%S.%NZ)" >"$dir/release.env"

  if ! pull_images "$image" "$extract" "$REGISTRY" "$REGISTRY_USER" "$REGISTRY_PASSWORD"; then
    record "deploy $name failed: pull"
    die "$EXIT_FAILED" 'pulling the images failed; nothing was changed'
  fi
  # The build time the image carries, which orders the rolls (#1965).
  printf 'BUILD_EPOCH=%s\n' "$(image_build_epoch "$image")" >>"$dir/release.env"

  activate "$name"
  # Check the merged files before touching any container.
  if ! dc config --quiet; then
    if [ -n "$current" ]; then activate "$current"; fi
    record "deploy $name failed: compose config"
    die "$EXIT_FAILED" 'the compose files do not load with this env file; nothing was changed'
  fi

  log 'starting the database'
  if ! up db; then
    recover "$current" "deploy $name (database)" "$name"
  fi
  # Migrations first, with the new image. They are forward only: the running release keeps working on the new
  # schema (expand and contract), so a failure here needs no rollback of the services.
  log 'running migrations'
  if ! dc run --rm --no-TTY --no-deps migrate; then
    if [ -n "$current" ]; then activate "$current"; fi
    record "deploy $name failed: migrate"
    die "$EXIT_FAILED" "migrations failed; the services were not changed${current:+ ($current still runs)}. Fix forward with a new migration"
  fi

  if ! roll_services "$(direction_to "$name" "$current")"; then
    recover "$current" "deploy $name" "$name"
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
    common_option "$@"
    ((OPT_SHIFT > 0)) || die "$EXIT_USAGE" "unknown option $1"
    shift "$OPT_SHIFT"
  done
  read_registry_password
  preflight
  acquire_lock
  local current previous
  current="$(read_state current)"
  previous="$(read_state previous)"
  guard_run "rollback to ${previous:-nothing}"
  install_self
  [ -n "$previous" ] || die "$EXIT_USAGE" 'no previous release is recorded; deploy a release instead'
  [ -f "$DEPLOY_DIR/releases/$previous/release.env" ] || die "$EXIT_USAGE" "the previous release $previous is no longer on the host"
  log "rolling back from ${current:-nothing} to $previous (images and compose files only; the schema stays)"
  # The images are normally still on the host. Pull them again (by digest, so nothing else can arrive) in case
  # they were pruned; without registry credentials a private image that is gone cannot come back.
  if ! pull_images "$(release_field "$previous" IMAGE)" "$(release_field "$previous" EXTRACT_IMAGE)" "$REGISTRY" "$REGISTRY_USER" "$REGISTRY_PASSWORD"; then
    log 'pulling the previous images failed; trying with the images on the host'
  fi
  # Usually toward an older build, the API first; back to a newer one (a second rollback), the worker first (#1965).
  activate "$previous"
  if ! roll_services "$(direction_to "$previous" "$current")"; then
    recover "$current" "rollback to $previous" "$previous"
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
      [ -n "${1:-}" ] || die "$EXIT_USAGE" 'usage: deploy.sh smoke <base url> [build id]'
      [ -z "${2:-}" ] || valid_build "$2" || die "$EXIT_USAGE" "the build id must match [A-Za-z0-9._-]{1,64}: '$2'"
      smoke "$1" account "${2:-}" || die "$EXIT_FAILED" "smoke test failed on $1"
      ;;
    *) die "$EXIT_USAGE" 'usage: deploy.sh deploy|rollback|status|smoke (see the header of this file)' ;;
  esac
}

main "$@"
