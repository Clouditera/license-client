#!/usr/bin/env bash
# ============================================================
# Rotate Worker TOKEN_SIGNING_PRIVATE_KEY to match the keypair whose
# public half is embedded as PROD_TOKEN_KEY in @clouditera/license-mgr.
#
# Originally written for issue devagent-cli#228 (Path A). Designed to be
# re-usable for future rotations — the EXPECTED fingerprint is derived
# from license-mgr's src/token-key.ts at runtime, so bumping the
# embedded key does NOT require editing this script.
#
# Resolution order for the EXPECTED fingerprint:
#   1. CLI flag      --expected-fp=<hex>
#   2. Env var       EXPECTED_FP=<hex>
#   3. Auto-derived  scripts/derive-prod-token-fp.mjs reads
#                    license-mgr/src/token-key.ts and computes the
#                    SHA-256 DER fingerprint of PROD_TOKEN_KEY.
#
# What it does:
#   0. Pre-flight: verify PEM is PKCS#8, derive its public-key
#      fingerprint, and abort if it doesn't match the resolved EXPECTED.
#   1. wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production
#   2. wrangler deploy --env production
#
# Usage:
#   bash scripts/swap-prod-token-key.sh /path/to/prod-token-signing-priv.pem
#   bash scripts/swap-prod-token-key.sh --expected-fp=<hex> /path/to/key.pem
#   EXPECTED_FP=<hex> bash scripts/swap-prod-token-key.sh /path/to/key.pem
#
# Where to run:
#   Anywhere — the script cd's into SERVER_DIR before wrangler calls.
#   Must be a terminal where `wrangler whoami` succeeds.
#
# Aborts on first error. Re-runnable.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DERIVE_SCRIPT="$SCRIPT_DIR/derive-prod-token-fp.mjs"
SERVER_DIR_DEFAULT="/Users/lijunchao/cortexdev-pro/license-tools/server"

# ---------- 0. Parse args ----------
CLI_EXPECTED_FP=""
PEM_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected-fp=*)
      CLI_EXPECTED_FP="${1#*=}"
      shift
      ;;
    --expected-fp)
      CLI_EXPECTED_FP="${2:-}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      if [[ -z "$PEM_PATH" ]]; then
        PEM_PATH="$1"
        shift
      else
        echo "ERROR: unexpected argument: $1" >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$PEM_PATH" ]]; then
  echo "usage: $0 [--expected-fp=<hex>] /path/to/prod-token-signing-priv.pem" >&2
  exit 2
fi

# ---------- 1. Resolve EXPECTED_FP ----------
if [[ -n "$CLI_EXPECTED_FP" ]]; then
  EXPECTED_FP="$CLI_EXPECTED_FP"
  EXPECTED_SOURCE="--expected-fp CLI flag"
elif [[ -n "${EXPECTED_FP:-}" ]]; then
  EXPECTED_SOURCE="EXPECTED_FP env var"
else
  if [[ ! -f "$DERIVE_SCRIPT" ]]; then
    echo "ERROR: cannot resolve EXPECTED_FP — derive script missing: $DERIVE_SCRIPT" >&2
    echo "Pass --expected-fp=<hex> explicitly, or restore the derive script." >&2
    exit 1
  fi
  EXPECTED_FP="$(node "$DERIVE_SCRIPT" 2>&1)" || {
    echo "ERROR: derive script failed: $EXPECTED_FP" >&2
    echo "Pass --expected-fp=<hex> explicitly to bypass derivation." >&2
    exit 1
  }
  EXPECTED_SOURCE="derived from $REPO_ROOT/src/token-key.ts"
fi

if [[ ! "$EXPECTED_FP" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: EXPECTED_FP must be 64 hex chars, got: $EXPECTED_FP" >&2
  exit 1
fi

# ---------- 2. Validate PEM ----------
if [[ ! -f "$PEM_PATH" ]]; then
  echo "ERROR: file not found: $PEM_PATH" >&2
  exit 1
fi

if ! grep -q "BEGIN PRIVATE KEY" "$PEM_PATH"; then
  echo "ERROR: $PEM_PATH is not PKCS#8 PEM (expected -----BEGIN PRIVATE KEY-----)." >&2
  echo "If it's SEC1 (-----BEGIN EC PRIVATE KEY-----), convert first:" >&2
  echo "  openssl pkey -in $PEM_PATH -out ${PEM_PATH%.pem}-pkcs8.pem" >&2
  exit 1
fi

# ---------- 3. Derive fingerprint from supplied PEM ----------
echo "=== Pre-flight: derive public key SHA-256 DER fingerprint from $PEM_PATH ==="
LOCAL_FP=$(openssl pkey -in "$PEM_PATH" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 \
  | awk '{print $NF}')

echo "  computed fingerprint : $LOCAL_FP"
echo "  expected fingerprint : $EXPECTED_FP"
echo "  expected source      : $EXPECTED_SOURCE"

if [[ "$LOCAL_FP" != "$EXPECTED_FP" ]]; then
  echo ""
  echo "ABORT: the PEM you provided does NOT match the expected fingerprint." >&2
  echo "Uploading it would NOT match what the client trusts."                 >&2
  echo "Double-check you have the correct private key, or update the"         >&2
  echo "client's PROD_TOKEN_KEY first if this rotation is intentional."       >&2
  exit 1
fi
echo "  ✓ fingerprint match"

# ---------- 4. Confirm before touching production ----------
echo ""
echo "About to:"
echo "  1. wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production"
echo "  2. wrangler deploy --env production"
echo ""
read -rp "Proceed? (yes/N): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted by user."
  exit 1
fi

# ---------- 5. Locate server dir ----------
SERVER_DIR="${SERVER_DIR:-$SERVER_DIR_DEFAULT}"
if [[ ! -f "$SERVER_DIR/wrangler.toml" ]]; then
  echo "ERROR: wrangler.toml not found at $SERVER_DIR" >&2
  echo "Set SERVER_DIR env var or edit SERVER_DIR_DEFAULT in this script." >&2
  exit 1
fi
cd "$SERVER_DIR"

# ---------- 6. Upload secret ----------
echo ""
echo "=== Step 1: wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production ==="
wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production < "$PEM_PATH"

# ---------- 7. Deploy ----------
echo ""
echo "=== Step 2: wrangler deploy --env production ==="
wrangler deploy --env production

# ---------- 8. Done ----------
echo ""
echo "============================================================"
echo "DONE. Production Worker now signs D4 tokens with the keypair"
echo "matching fingerprint $EXPECTED_FP."
echo ""
echo "VERIFY (recommended):"
echo "  1. From a real client, trigger one /refresh:"
echo "       devagent license refresh    # or equivalent"
echo "  2. Re-run the client-side diagnostic:"
echo "       cd $REPO_ROOT"
echo "       pnpm diagnose:token-key"
echo "     Expect the live verification to flip from FAIL → OK."
echo "============================================================"
