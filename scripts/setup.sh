#!/usr/bin/env bash
#
# Check that everything the viewer needs is in place before it is started.
#
# Exactly two credentials are required, a GCS HMAC key pair, which DuckDB uses over the
# S3-compatible endpoint. The same pair covers both reading the bucket directly and
# mirroring it locally with `make sync`.

set -euo pipefail

DATA_LOCATION="${LABEL_DIFFS_DATA:-gs://monaco-dev-bucket/drug-safety-signaling-demo}"

failures=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mmiss\033[0m  %s\n' "$1"; failures=$((failures + 1)); }

# Report on the first environment variable of a pair that is set, masking the value.
check_credential() {
  local label="$1" primary="$2" fallback="$3" value name

  if [[ -n "${!primary:-}" ]]; then
    value="${!primary}"; name="$primary"
  elif [[ -n "${!fallback:-}" ]]; then
    value="${!fallback}"; name="$fallback"
  else
    bad "$label: set \$$primary (or \$$fallback)"
    return
  fi

  ok "$label: \$$name is set (${#value} chars, ends ...${value: -4})"
}

echo "Data location"
echo "  $DATA_LOCATION"
echo

echo "HMAC credentials (the only credentials needed)"
check_credential "key id" LABEL_DIFFS_HMAC_KEY_ID AWS_ACCESS_KEY_ID
check_credential "secret" LABEL_DIFFS_HMAC_SECRET AWS_SECRET_ACCESS_KEY
echo

echo "Toolchain"
if command -v bun >/dev/null 2>&1; then
  ok "bun $(bun --version)"
else
  bad "bun not found: https://bun.sh"
fi

if [[ -d node_modules ]]; then
  ok "dependencies installed"
else
  warn "dependencies not installed: run 'make install'"
fi
echo

echo "Local data"
if [[ -d data ]]; then
  ok "local ./data present, the viewer will prefer it"
else
  warn "no local ./data, the viewer will read the bucket directly"
fi
echo

if (( failures > 0 )); then
  echo "$failures required item(s) missing."
  echo
  echo "To mint HMAC keys for a service account that can read the bucket:"
  echo "  gcloud storage hmac create SERVICE_ACCOUNT_EMAIL"
  echo "then export the access id and secret as:"
  echo "  export LABEL_DIFFS_HMAC_KEY_ID=..."
  echo "  export LABEL_DIFFS_HMAC_SECRET=..."
  exit 1
fi

echo "Ready. Start with 'make serve'."
