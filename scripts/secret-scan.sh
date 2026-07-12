#!/usr/bin/env bash
# =============================================================================
# Lightweight secret scan. Greps tracked source for obvious secret patterns and
# fails if any are found. Fast CI tripwire, NOT a full scanner. Synthetic
# test/example/placeholder values (localhost, *.test.local, <placeholders>,
# $SHELL_VARS, example URLs) are filtered out so only real-looking secrets fail.
# =============================================================================
set -eu
cd "$(dirname "$0")/.."

SCAN_DIRS=(src test scripts docs)
EXISTING=()
for d in "${SCAN_DIRS[@]}"; do [ -e "$d" ] && EXISTING+=("$d"); done

# Lines matching any of these markers are treated as synthetic and ignored.
SYNTHETIC='example|localhost|test\.local|mail\.local|<[A-Za-z0-9_-]+>|\$[A-Za-z_]|u:p@|hunter2|deadbeef|placeholder|REDACTED|redacted'

declare -a PATTERNS=(
  'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
  'AKIA[0-9A-Z]{16}'
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  'sk-[A-Za-z0-9]{32,}'
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  'postgres(ql)?://[^ "'"'"']*:[^ @"'"'"'$]{6,}@'
  '(SMTP_PASS|IMAP_PASS|CREDENTIAL_KEYRING)[[:space:]]*=[[:space:]]*["'"'"'][^"'"'"'<$]{6,}'
)

fail=0
for pat in "${PATTERNS[@]}"; do
  matches="$(grep -rInE "$pat" "${EXISTING[@]}" \
      --exclude='secret-scan.sh' --exclude='*.lock' 2>/dev/null || true)"
  # Drop synthetic/example/placeholder lines.
  matches="$(printf '%s\n' "$matches" | grep -vEi "$SYNTHETIC" || true)"
  matches="$(printf '%s\n' "$matches" | grep -vE '^\s*$' || true)"
  if [ -n "$matches" ]; then
    echo "secret-scan: POTENTIAL SECRET — /$pat/" >&2
    printf '%s\n' "$matches" | sed 's/^/    /' >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "secret-scan: FAILED" >&2
  exit 1
fi
echo "secret-scan: OK — no obvious secrets found."
