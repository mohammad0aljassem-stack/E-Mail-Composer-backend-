#!/usr/bin/env bash
# =============================================================================
# TEST-ONLY local Postgres bring-up for the transport worker's integration tests.
#
# NON-DEPLOYABLE. This does NOT own or ship migrations. The canonical migrations
# live in the sibling UI repo (single owner). Here we merely load, into a
# throwaway PG16 cluster, the exact baseline + FULL Phase 2/3 migration chain at
# the merged UI SHA recorded in config/canonical-transport-contract.lock.json so
# the worker's repositories/queues can be tested against the real schema, and we
# create a LOCAL, least-privileged `transport_worker` login role. Production
# provisioning of that role is a SEPARATE, manual, audited op.
#
# The FULL canonical chain (baseline + all SEVEN migrations; the five Phase 3
# migrations are checksum-pinned) is loaded. This FAILS CLOSED if the UI checkout
# SHA differs, any expected migration file is missing, any checksum differs, or
# the schema would otherwise be loaded without the Phase 3 contract hardening,
# the worker-transition grant, the confirmed-send-snapshot accessors, or the
# send-MIME-artifact migrations.
#
# Usage:
#   bash scripts/test-db.sh            # start (reuse if running), load schema
#   bash scripts/test-db.sh --print    # also print the connection URLs
#   bash scripts/test-db.sh --stop     # stop + remove the throwaway cluster
# =============================================================================
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UI_REPO="${UI_REPO:-/home/user/E-Mail-Composer-UI}"
DATA_DIR="${TEST_DB_DATA_DIR:-/tmp/pg-transport-worker}"
PORT="${TEST_DB_PORT:-54330}"
DB_NAME="${TEST_DB_NAME:-transport_test}"
WORKER_ROLE="transport_worker"
WORKER_PASS="${TEST_WORKER_PASSWORD:-worker_test_pw}"

# --- Canonical pin: SINGLE SOURCE = the backend lock + the UI manifest -------
# The expected UI SHA comes from config/canonical-transport-contract.lock.json;
# the per-migration checksums come from the checked-out UI manifest. NOTHING is
# hand-copied here (no duplicated SHA/checksum literals to drift).
LOCK_FILE="$SCRIPT_DIR/../config/canonical-transport-contract.lock.json"
lock_get() {
  node -e 'const fs=require("fs");const l=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=l[process.argv[2]];if(v===undefined){process.exit(3)}process.stdout.write(String(v))' "$LOCK_FILE" "$1"
}
manifest_sha() {
  # $1 = migration filename; prints its sha256 from the UI manifest (empty if absent).
  node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const e=(m.migrations||[]).find(x=>x&&x.file===process.argv[2]);process.stdout.write(e&&e.sha256?e.sha256:"")' "$MANIFEST_FILE" "$1"
}

EXPECTED_UI_SHA="$(lock_get uiCommitSha)"
MANIFEST_REL="$(lock_get manifestPath)"
MANIFEST_FILE="$UI_REPO/$MANIFEST_REL"

MODE="${1:-}"
PSQL_ARGS=(-U postgres -p "$PORT" -h localhost)

BASELINE="$UI_REPO/supabase/baseline/production_schema_2026_07_11.sql"
MIG_DRAFT="$UI_REPO/supabase/migrations/20260711130000_draft_lifecycle.sql"
MIG_PHASE2="$UI_REPO/supabase/migrations/20260712100000_enforce_phase2_rpc_invariants.sql"
MIG_FOUNDATION="$UI_REPO/supabase/migrations/20260713100000_transport_foundation.sql"
MIG_HARDENING="$UI_REPO/supabase/migrations/20260714100000_transport_contract_hardening.sql"
MIG_GRANT="$UI_REPO/supabase/migrations/20260715100000_worker_transition_grant.sql"
MIG_SNAPSHOTS="$UI_REPO/supabase/migrations/20260716100000_confirmed_send_snapshots.sql"
MIG_MIME="$UI_REPO/supabase/migrations/20260717100000_send_mime_artifacts.sql"

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

# --- FAIL CLOSED: verify the sibling repo, its SHA, and every checksum -------
# 0. The backend lock must have yielded a pin, and the UI manifest must exist.
if [ -z "$EXPECTED_UI_SHA" ] || [ -z "$MANIFEST_REL" ]; then
  echo "ERROR: could not read the pin from $LOCK_FILE." >&2
  exit 1
fi
if [ ! -f "$MANIFEST_FILE" ]; then
  echo "ERROR: canonical UI manifest missing: $MANIFEST_FILE" >&2
  echo "Set UI_REPO to the sibling UI checkout at merged SHA $EXPECTED_UI_SHA." >&2
  exit 1
fi

# 1. Every file in the FULL chain must be present (a missing hardening/grant
#    migration means the schema could only be loaded through PR#4 — reject it).
for f in "$BASELINE" "$MIG_DRAFT" "$MIG_PHASE2" "$MIG_FOUNDATION" "$MIG_HARDENING" "$MIG_GRANT" "$MIG_SNAPSHOTS" "$MIG_MIME"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: required schema file missing: $f" >&2
    echo "Set UI_REPO to the sibling UI checkout at merged SHA $EXPECTED_UI_SHA (full chain)." >&2
    exit 1
  fi
done

# 2. If UI_REPO is a git checkout, its HEAD MUST be the pinned canonical SHA.
if git -C "$UI_REPO" rev-parse --git-dir >/dev/null 2>&1; then
  ACTUAL_UI_SHA="$(git -C "$UI_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [ "$ACTUAL_UI_SHA" != "$EXPECTED_UI_SHA" ]; then
    echo "ERROR: UI schema checkout SHA mismatch." >&2
    echo "  expected $EXPECTED_UI_SHA" >&2
    echo "  actual   $ACTUAL_UI_SHA" >&2
    exit 1
  fi
fi

# 3. All FIVE Phase 3 checksums must match the UI manifest exactly. The expected
#    values are read FROM the manifest (single source), never hand-copied here.
verify_sha() {
  local label="$1" file="$2" expected actual
  expected="$(manifest_sha "$(basename "$file")")"
  if [ -z "$expected" ]; then
    echo "ERROR: $label migration not listed in the UI manifest." >&2
    exit 1
  fi
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: $label migration checksum mismatch (vs UI manifest)." >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
}
verify_sha "foundation (20260713100000)" "$MIG_FOUNDATION"
verify_sha "hardening  (20260714100000)" "$MIG_HARDENING"
verify_sha "grant      (20260715100000)" "$MIG_GRANT"
verify_sha "snapshots  (20260716100000)" "$MIG_SNAPSHOTS"
verify_sha "mime       (20260717100000)" "$MIG_MIME"
echo "Canonical pin verified: UI $EXPECTED_UI_SHA, 5 Phase 3 checksums OK (from manifest)."

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
echo "Loading canonical schema (baseline + FULL 7-migration chain @ UI $EXPECTED_UI_SHA)..."
apply baseline "$BASELINE"
apply draft "$MIG_DRAFT"
apply phase2 "$MIG_PHASE2"
apply foundation "$MIG_FOUNDATION"
apply hardening "$MIG_HARDENING"
apply grant "$MIG_GRANT"
apply snapshots "$MIG_SNAPSHOTS"
apply mime "$MIG_MIME"

# --- TEST-ONLY: give the worker role a local login only ----------------------
# NO privilege injection here. The canonical chain already grants transport_worker
# every privilege the worker needs from the migrations themselves: EXECUTE on
# public.phase3_send_attempt_transition_ok(text,text) (20260715100000) so the
# SECURITY INVOKER BEFORE UPDATE trigger on send_attempts can advance the state
# machine; EXECUTE on the private transport.get_send_snapshot(uuid) /
# transport.get_mirror_snapshot(uuid,uuid,bigint) accessors (20260716100000); and
# EXECUTE on transport.create_or_verify_send_mime_artifact(...) plus SELECT/UPDATE
# on transport.send_mime_artifacts (20260717100000). All under the real
# least-privilege role WITHOUT any test-only GRANT (draft_versions itself is never
# granted). We add ONLY a login + CONNECT so the suite can authenticate.
echo "Configuring TEST-ONLY worker login role (login+connect only, no grants)..."
psql "${PSQL_ARGS[@]}" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q \
  -c "ALTER ROLE $WORKER_ROLE LOGIN PASSWORD '$WORKER_PASS';" \
  -c "GRANT CONNECT ON DATABASE $DB_NAME TO $WORKER_ROLE;"

echo "Schema loaded."
if [ "$MODE" = "--print" ]; then
  echo ""
  echo "TEST_DATABASE_URL=postgresql://postgres@localhost:$PORT/$DB_NAME"
  echo "TEST_WORKER_DATABASE_URL=postgresql://$WORKER_ROLE:$WORKER_PASS@localhost:$PORT/$DB_NAME"
  echo ""
  echo "Stop later with: bash scripts/test-db.sh --stop"
fi
