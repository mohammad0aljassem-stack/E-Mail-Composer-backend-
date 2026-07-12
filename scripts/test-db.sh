#!/usr/bin/env bash
# =============================================================================
# TEST-ONLY local Postgres bring-up for the transport worker's integration tests.
#
# NON-DEPLOYABLE. This does NOT own or ship migrations. The canonical migrations
# live in the sibling UI repo (single owner). Here we merely load, into a
# throwaway PG16 cluster, the exact baseline + three migrations at the merged
# UI SHA 67daad9 so the worker's repositories/queues can be tested against the
# real schema, and we create a LOCAL, least-privileged `transport_worker` login
# role. Production provisioning of that role is a SEPARATE, manual, audited op.
#
# Usage:
#   bash scripts/test-db.sh            # start (reuse if running), load schema
#   bash scripts/test-db.sh --print    # also print the connection URLs
#   bash scripts/test-db.sh --stop     # stop + remove the throwaway cluster
# =============================================================================
set -eu

UI_REPO="${UI_REPO:-/home/user/E-Mail-Composer-UI}"
DATA_DIR="${TEST_DB_DATA_DIR:-/tmp/pg-transport-worker}"
PORT="${TEST_DB_PORT:-54330}"
DB_NAME="${TEST_DB_NAME:-transport_test}"
WORKER_ROLE="transport_worker"
WORKER_PASS="${TEST_WORKER_PASSWORD:-worker_test_pw}"
EXPECTED_TRANSPORT_SHA="a2319ada8d471d09063b8e2bfbdb8c814e4ba49cecdee08c9bbd9b800aa8c72a"

MODE="${1:-}"
PSQL_ARGS=(-U postgres -p "$PORT" -h localhost)

BASELINE="$UI_REPO/supabase/baseline/production_schema_2026_07_11.sql"
MIG_DRAFT="$UI_REPO/supabase/migrations/20260711130000_draft_lifecycle.sql"
MIG_HARDEN="$UI_REPO/supabase/migrations/20260712100000_enforce_phase2_rpc_invariants.sql"
MIG_TRANSPORT="$UI_REPO/supabase/migrations/20260713100000_transport_foundation.sql"

if ! command -v initdb >/dev/null 2>&1; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$PG_BIN" ] && export PATH="$PG_BIN:$PATH"
fi

CLUSTER_USER=""
if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
  CLUSTER_USER="postgres"
fi
run_cluster_cmd() {
  if [ -n "$CLUSTER_USER" ]; then
    su -s /bin/bash "$CLUSTER_USER" -c "PATH='$PATH' $1"
  else
    bash -c "$1"
  fi
}

check_running() { pg_isready -U postgres -p "$PORT" -h localhost >/dev/null 2>&1; }

stop_cluster() {
  run_cluster_cmd "pg_ctl -D '$DATA_DIR' stop -m fast" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR" "$DATA_DIR".*.log 2>/dev/null || true
  echo "Stopped and removed throwaway cluster."
}

if [ "$MODE" = "--stop" ]; then
  stop_cluster
  exit 0
fi

# --- verify the sibling repo + migration checksum before doing anything ------
for f in "$BASELINE" "$MIG_DRAFT" "$MIG_HARDEN" "$MIG_TRANSPORT"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: required schema file missing: $f" >&2
    echo "Set UI_REPO to the sibling UI checkout at merged SHA 67daad9." >&2
    exit 1
  fi
done
ACTUAL_SHA="$(sha256sum "$MIG_TRANSPORT" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$EXPECTED_TRANSPORT_SHA" ]; then
  echo "ERROR: transport migration checksum mismatch." >&2
  echo "  expected $EXPECTED_TRANSPORT_SHA" >&2
  echo "  actual   $ACTUAL_SHA" >&2
  exit 1
fi

if check_running; then
  echo "Reusing PostgreSQL already running on port $PORT."
else
  echo "Initializing throwaway PG16 cluster ($DATA_DIR, port $PORT)..."
  rm -rf "$DATA_DIR"
  mkdir -p "$DATA_DIR"
  [ -n "$CLUSTER_USER" ] && chown "$CLUSTER_USER" "$DATA_DIR"
  run_cluster_cmd "initdb -D '$DATA_DIR' -A trust -U postgres" > "$DATA_DIR.initdb.log" 2>&1
  [ -n "$CLUSTER_USER" ] && { touch "$DATA_DIR.pg.log"; chown "$CLUSTER_USER" "$DATA_DIR.pg.log"; }
  run_cluster_cmd "pg_ctl -D '$DATA_DIR' start -w -t 60 -l '$DATA_DIR.pg.log' -o '-p $PORT -k /tmp -c listen_addresses=localhost'" >/dev/null 2>&1
fi

echo "Recreating database $DB_NAME..."
psql "${PSQL_ARGS[@]}" -d postgres -q \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" \
  -c "CREATE DATABASE $DB_NAME;"

apply() {
  echo "  applying $(basename "$2")"
  psql "${PSQL_ARGS[@]}" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$2" >/dev/null
}
echo "Loading canonical schema (baseline + 3 migrations @ UI 67daad9)..."
apply baseline "$BASELINE"
apply draft "$MIG_DRAFT"
apply harden "$MIG_HARDEN"
apply transport "$MIG_TRANSPORT"

# --- TEST-ONLY: give the worker role a local login + a scratch pg-boss owner --
echo "Configuring TEST-ONLY worker login role (non-production)..."
# NOTE (production provisioning requirement, surfaced by integration testing):
# the send_attempts BEFORE UPDATE trigger is SECURITY INVOKER and calls
# public.phase3_send_attempt_transition_ok(text,text). The canonical migration
# grants EXECUTE on that function to service_role only, so a bare transport_worker
# CANNOT advance the send state machine without this grant. Production
# provisioning of the worker role MUST include it (documented in the runbook).
psql "${PSQL_ARGS[@]}" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q \
  -c "ALTER ROLE $WORKER_ROLE LOGIN PASSWORD '$WORKER_PASS';" \
  -c "GRANT CONNECT ON DATABASE $DB_NAME TO $WORKER_ROLE;" \
  -c "GRANT EXECUTE ON FUNCTION public.phase3_send_attempt_transition_ok(text, text) TO $WORKER_ROLE;"

echo "Schema loaded."
if [ "$MODE" = "--print" ]; then
  echo ""
  echo "TEST_DATABASE_URL=postgresql://postgres@localhost:$PORT/$DB_NAME"
  echo "TEST_WORKER_DATABASE_URL=postgresql://$WORKER_ROLE:$WORKER_PASS@localhost:$PORT/$DB_NAME"
  echo ""
  echo "Stop later with: bash scripts/test-db.sh --stop"
fi
