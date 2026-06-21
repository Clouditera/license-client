#!/usr/bin/env bash
# ============================================================
# Issue #228 — Path A: rotate Worker TOKEN_SIGNING_PRIVATE_KEY
# back to the keypair whose public half matches PROD_TOKEN_KEY
# embedded in @clouditera/license-mgr.
#
# Use this when the production Worker is signing D4 tokens with a key
# whose SPKI DER SHA-256 fingerprint does NOT match the client-embedded
# PROD_TOKEN_KEY (b316b81c977b61ccf344207f07861b1e1e555c08e26f99ba96dcf1e34f79132d).
#
# What it does:
#   0. Pre-flight: verify the PEM is PKCS#8 and its DERIVED public-key
#      fingerprint actually matches PROD_TOKEN_KEY (so we don't ship the
#      wrong key into prod).
#   1. wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production
#   2. wrangler deploy --env production
#   3. Optional smoke test: ask the user to /refresh from a real client
#      and re-run scripts/diagnose-token-key.mjs to confirm the local
#      verdict flips from FAIL to OK.
#
# Usage:
#   bash scripts/swap-prod-token-key.sh /path/to/prod-token-signing-priv.pem
#
# Where to run:
#   /Users/lijunchao/cortexdev-pro/license-tools/server (or wherever
#   the server wrangler.toml lives). Must be run from a terminal with
#   working `wrangler whoami`.
#
# Aborts on first error. Re-runnable.
# ============================================================

set -euo pipefail

EXPECTED_FP="b316b81c977b61ccf344207f07861b1e1e555c08e26f99ba96dcf1e34f79132d"
SERVER_DIR_DEFAULT="/Users/lijunchao/cortexdev-pro/license-tools/server"

# ---------- 0. Arg + pre-flight ----------
if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/prod-token-signing-priv.pem" >&2
  exit 2
fi
PEM_PATH="$1"

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

echo "=== Pre-flight: derive public key SHA-256 DER fingerprint from $PEM_PATH ==="
LOCAL_FP=$(openssl pkey -in "$PEM_PATH" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 \
  | awk '{print $NF}')

echo "  computed fingerprint : $LOCAL_FP"
echo "  expected (PROD_TOKEN): $EXPECTED_FP"

if [[ "$LOCAL_FP" != "$EXPECTED_FP" ]]; then
  echo ""
  echo "ABORT: the PEM you provided does NOT match the client-embedded PROD_TOKEN_KEY." >&2
  echo "Uploading it would NOT fix issue #228 — and might make things worse."  >&2
  echo "Double-check you have the correct private key from the vault."          >&2
  exit 1
fi
echo "  ✓ fingerprint matches PROD_TOKEN_KEY"

# ---------- 1. Confirm before touching production ----------
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

# ---------- 2. Locate server dir ----------
SERVER_DIR="${SERVER_DIR:-$SERVER_DIR_DEFAULT}"
if [[ ! -f "$SERVER_DIR/wrangler.toml" ]]; then
  echo "ERROR: wrangler.toml not found at $SERVER_DIR" >&2
  echo "Set SERVER_DIR env var or edit SERVER_DIR_DEFAULT in this script." >&2
  exit 1
fi
cd "$SERVER_DIR"

# ---------- 3. Upload secret ----------
echo ""
echo "=== Step 1: wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production ==="
wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production < "$PEM_PATH"

# ---------- 4. Deploy ----------
echo ""
echo "=== Step 2: wrangler deploy --env production ==="
wrangler deploy --env production

# ---------- 5. Done ----------
echo ""
echo "============================================================"
echo "DONE. Production Worker now signs D4 tokens with the keypair"
echo "matching PROD_TOKEN_KEY ($EXPECTED_FP)."
echo ""
echo "VERIFY (recommended):"
echo "  1. From a real client, trigger one /refresh:"
echo "       devagent license refresh    # or equivalent"
echo "  2. Re-run the client-side diagnostic:"
echo "       cd /Users/lijunchao/cortexdev-pro/license-mgr"
echo "       pnpm diagnose:token-key"
echo "     Expect the live verification to flip from FAIL → OK."
echo "============================================================"
