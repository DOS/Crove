#!/usr/bin/env bash
# Reproduces the ADR-0021 spike measurements on a throwaway postgres:17 container, then removes it.
# Usage: bash docs/adr/0021/run.sh   (needs Docker; nothing else touches the host)
set -euo pipefail
export MSYS_NO_PATHCONV=1
NAME=crove-spike-0b
HERE=$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))  # pwd -W: Windows path for docker cp under Git Bash
ORG=00000000-0000-0000-0000-00000000000a
LE1=00000000-0000-0000-0000-0000000000e1
LE2=00000000-0000-0000-0000-0000000000e2

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 -c max_connections=1100 >/dev/null
trap 'docker rm -f "$NAME" >/dev/null' EXIT
# The entrypoint restarts the server once after initdb; wait for the second "ready" line.
until [ "$(docker logs "$NAME" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do sleep 1; done
docker cp "$HERE/." "$NAME:/spike"

q() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
q -q -f /spike/spike.sql

bench() { # label script clients transactions [pgbench -D defines...]; GUARD=share|advisory|none
  local label=$1 script=$2 c=$3 t=$4; shift 4
  local j=$(( c < 16 ? c : 16 )) guard=${GUARD:-share}
  echo "-- $label: $script, $c clients x $t transactions, period guard $guard"
  docker exec "$NAME" bash -c "cd /tmp && PGOPTIONS='-c spike.period_guard=$guard' pgbench -U postgres -n -c $c -j $j -t $t -l --log-prefix=lg_$label $* -f /spike/bench/$script postgres" \
    | grep -E 'actually processed|failed transactions|latency average|^tps'
  docker exec "$NAME" bash -c "cat /tmp/lg_$label* | awk '{print \$3}' | sort -n | awk '{a[NR]=\$1} END {printf \"latency p50 %.2f ms, p95 %.2f ms, max %.2f ms\n\", a[int(NR*0.5)]/1000, a[int(NR*0.95)]/1000, a[NR]/1000}'"
}

echo "== Numbering =="
bench alloc1000 alloc.sql 1000 1 -D dt=A1000
bench alloc50 alloc.sql 50 20 -D dt=A50
bench allocrb alloc_rollback.sql 50 20 -D dt=AR
bench seqrb seq_rollback.sql 50 20
bench maxp1 maxplus1.sql 50 20
echo "== Posting =="
bench post1 post.sql 1 1000 -D dt=P1 -D le=$LE1 -D sync=false
bench post1000 post.sql 1000 1 -D dt=P1000 -D le=$LE1 -D sync=false
bench post50 post.sql 50 20 -D dt=P50 -D le=$LE1 -D sync=false
bench posthold post_hold.sql 50 20 -D dt=PH -D le=$LE1
bench postsync post.sql 50 20 -D dt=PS -D le=$LE2 -D sync=true
GUARD=advisory bench post1000a post.sql 1000 1 -D dt=P1000A -D le=$LE1 -D sync=false
GUARD=advisory bench post50a post.sql 50 20 -D dt=P50A -D le=$LE1 -D sync=false
GUARD=none bench post1000n post.sql 1000 1 -D dt=P1000N -D le=$LE1 -D sync=false
bench replay replay.sql 50 1
q -f /spike/checks.sql

echo "== Hash chain =="
q <<SQL
\timing on
SELECT count(*) AS pending_le1 FROM spike.chain_pending WHERE legal_entity_id = '$LE1';
SELECT spike.chain_run('$ORG', '$LE1', 1000000) AS chained_le1;
SELECT count(*) AS problems_le1 FROM spike.chain_verify('$ORG', '$LE1');
SELECT count(*) AS links_le2 FROM spike.chain_link WHERE legal_entity_id = '$LE2';
SELECT count(*) AS problems_le2 FROM spike.chain_verify('$ORG', '$LE2');
SQL

echo "== Period close races (LE2) =="
q -q <<SQL
SELECT spike.close_period('$ORG', '$LE2', '2026-01-01'), spike.close_period('$ORG', '$LE2', '2026-02-01');
SQL
post_sql() { # date doc
  echo "SELECT spike.post_entry('$ORG', '$LE2', '$1', 'VND', '$2', 'race', gen_random_uuid(), 1, '[{\"line_no\":1,\"account_code\":\"642\",\"debit\":\"1000\"},{\"line_no\":2,\"account_code\":\"111\",\"credit\":\"1000\"}]');"
}
race() { # label guard month(2 digits) doc: the posting starts first
  local label=$1 guard=$2 m=$3 doc=$4
  echo "-- $label, guard $guard: a posting into 2026-$m holds its transaction for 2 s; closing 2026-$m starts 0.5 s later"
  { printf "SET spike.period_guard = '%s';\nBEGIN;\n%s\nSELECT pg_sleep(2);\nCOMMIT;\n" "$guard" "$(post_sql "2026-$m-10" "$doc")" | q -q >/dev/null; } &
  sleep 0.5
  printf '%s\n' '\timing on' "SELECT spike.close_period('$ORG', '$LE2', '2026-$m-01');" | q -q | grep Time
  wait
  q -tAc "SELECT 'entries dated in 2026-$m, now closed: ' || count(*) FROM spike.journal_entry WHERE legal_entity_id = '$LE2' AND date_trunc('month', entry_date) = '2026-$m-01'"
}
race_close_first() { # label guard month doc: the close starts first
  local label=$1 guard=$2 m=$3 doc=$4
  echo "-- $label, guard $guard: closing 2026-$m holds its transaction for 2 s; a posting into 2026-$m starts 0.5 s later"
  { printf "BEGIN;\nSELECT spike.close_period('%s', '%s', '2026-%s-01');\nSELECT pg_sleep(2);\nCOMMIT;\n" "$ORG" "$LE2" "$m" | q -q >/dev/null; } &
  sleep 0.5
  printf '%s\n' "SET spike.period_guard = '$guard';" '\timing on' "$(post_sql "2026-$m-10" "$doc")" | docker exec -i "$NAME" psql -U postgres -q 2>&1 | grep -E 'ERROR|Time' || true
  wait
}
race A share 03 RA
race_close_first B share 04 RB
race C none 05 RC
race D advisory 06 RD
race_close_first E advisory 07 RE

echo "== Scenarios =="
q -f /spike/scenarios.sql
