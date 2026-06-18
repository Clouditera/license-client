#!/usr/bin/env node
/**
 * Diagnose `online_check_token` (D4) signature mismatch.
 *
 * Use this when `checkOfflineGrace()` reports `tokenFailure: 'invalid_signature'`
 * even though `/refresh` itself succeeded. The most common cause is the
 * server's token signing private key drifting from the client's embedded
 * PROD_TOKEN_KEY public half — without independent evidence it's easy to
 * blame the client.
 *
 * What this script does:
 *   1. Loads the locally embedded PROD_TOKEN_KEY (the public half) and
 *      prints its SHA-256 DER fingerprint. The server team can compute the
 *      same fingerprint from their private key half and compare — if the
 *      fingerprints differ, the keypair is mismatched.
 *   2. If given an `online-check.json` path (or finds one at the default
 *      CortexDev Pro / DevAgent Pro config dir), runs the actual
 *      verifyOnlineCheckToken call and reports the verdict.
 *   3. On 'invalid_signature' verdicts, attempts the same verification
 *      against DEV_TOKEN_KEY as a sanity check — if THAT passes, the
 *      server is signing with the dev key in production.
 *
 * No network calls. Strictly local cryptography + JSON inspection.
 *
 * Usage:
 *   node scripts/diagnose-token-key.mjs                  # auto-find online-check.json
 *   node scripts/diagnose-token-key.mjs /path/to/online-check.json
 *
 * Exit codes:
 *   0 — Path A would authorize (signed_token verifies OK).
 *   1 — Verdict failed; details printed above.
 *   2 — Could not find an online-check.json to test against.
 *   3 — Local key fingerprints malformed (build/install corruption).
 */

import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Pull the PEM blocks straight out of src/token-key.ts (text grep — keeps
// this script free of a tsc dependency and runnable on a fresh checkout).
// ---------------------------------------------------------------------------

function extractPemBlock(source, constName) {
  const re = new RegExp(
    String.raw`const ${constName} = \`(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)\``,
  );
  const m = source.match(re);
  if (!m) throw new Error(`Could not extract ${constName} from src/token-key.ts`);
  return m[1];
}

function pemFingerprint(pem) {
  // SHA-256 of the DER bytes. createPublicKey then export({ type: 'spki',
  // format: 'der' }) gives a canonical, padding-free DER encoding so
  // re-wrapped identical PEMs hash identically.
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

// ---------------------------------------------------------------------------
// Canonicalize + verify — duplicates license-mgr's verifier inline so this
// script never needs the built dist.
// ---------------------------------------------------------------------------

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, k) => {
        out[k] = canonicalize(value[k]);
        return out;
      }, {});
  }
  return value;
}

async function verifyWithKey(signedToken, publicKeyPem) {
  const { verify } = await import('node:crypto');
  const payloadBytes = Buffer.from(JSON.stringify(canonicalize(signedToken.payload)), 'utf8');
  const sigBytes = Buffer.from(signedToken.signature, 'base64');
  try {
    return verify('SHA256', payloadBytes, publicKeyPem, sigBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auto-detect online-check.json
// ---------------------------------------------------------------------------

function findOnlineCheck(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`online-check.json not found at: ${explicit}`);
    }
    return resolve(explicit);
  }
  const candidates = [
    process.env.CORTEXDEV_CONFIG_DIR,
    process.env.CORTEXDEV_PRO_CONFIG_DIR,
    process.env.DEVAGENT_CONFIG_DIR,
    join(homedir(), '.devagent-pro'),
    join(homedir(), '.cortexdev-pro'),
  ].filter(Boolean);
  for (const dir of candidates) {
    const p = join(dir, 'license', 'online-check.json');
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const tokenKeySrc = readFileSync(join(REPO_ROOT, 'src', 'token-key.ts'), 'utf8');
  const PROD_TOKEN_KEY = extractPemBlock(tokenKeySrc, 'PROD_TOKEN_KEY');
  const DEV_TOKEN_KEY = extractPemBlock(tokenKeySrc, 'DEV_TOKEN_KEY');

  let prodFp, devFp;
  try {
    prodFp = pemFingerprint(PROD_TOKEN_KEY);
    devFp = pemFingerprint(DEV_TOKEN_KEY);
  } catch (e) {
    console.error('FATAL: local key fingerprints malformed —', e.message);
    process.exit(3);
  }

  console.log('=== Embedded token keys (client side) ===');
  console.log(`PROD_TOKEN_KEY SHA-256 (DER): ${prodFp}`);
  console.log(`DEV_TOKEN_KEY  SHA-256 (DER): ${devFp}`);
  console.log('');
  console.log('Server team: compute the SHA-256 of `openssl pkey -pubout -in <signing-priv-key>`');
  console.log('             converted to DER. If it differs from PROD_TOKEN_KEY above, the');
  console.log('             keypair is the source of the drift — rotate or re-deploy.');
  console.log('');

  const onlineCheckPath = findOnlineCheck(process.argv[2]);
  if (!onlineCheckPath) {
    console.error('No online-check.json found. Skipping live verification.');
    console.error('Pass an explicit path:');
    console.error('  node scripts/diagnose-token-key.mjs /path/to/online-check.json');
    process.exit(2);
  }

  console.log(`=== Live verification against ${onlineCheckPath} ===`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(onlineCheckPath, 'utf8'));
  } catch (e) {
    console.error('Failed to parse online-check.json —', e.message);
    process.exit(1);
  }

  if (!parsed.signed_token) {
    console.error('online-check.json has no `signed_token` field.');
    console.error('Server has not (yet) shipped the D4 patch, OR the most recent /refresh');
    console.error('returned `revoked: true` (deliberate omission). Path A is dormant.');
    process.exit(1);
  }

  const token = parsed.signed_token;
  console.log(`signed_token.payload.license_id : ${token.payload?.license_id}`);
  console.log(`signed_token.payload.server_time: ${token.payload?.server_time}`);
  console.log(`signed_token.payload.expires_at : ${token.payload?.expires_at}`);
  console.log('');

  const prodOk = await verifyWithKey(token, PROD_TOKEN_KEY);
  console.log(`Verify against PROD_TOKEN_KEY: ${prodOk ? 'OK' : 'FAIL'}`);

  if (prodOk) {
    console.log('');
    console.log('=> Path A is healthy. checkOfflineGrace() would authorize offline.');
    process.exit(0);
  }

  // PROD failed — try DEV as a sanity check.
  const devOk = await verifyWithKey(token, DEV_TOKEN_KEY);
  console.log(`Verify against DEV_TOKEN_KEY : ${devOk ? 'OK' : 'FAIL'}`);
  console.log('');

  if (devOk) {
    console.log('=> Server is signing with the DEV token key in production.');
    console.log('   Rotate the server signing key to match PROD_TOKEN_KEY.');
  } else {
    console.log('=> Neither PROD nor DEV verifies. Either:');
    console.log('   • Server uses a third (unknown) keypair — compare DER fingerprints above.');
    console.log('   • Server canonicalisation differs (canonicalize → JSON.stringify → verify).');
    console.log('   • Token was tampered with on disk.');
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('UNEXPECTED:', e?.stack || e);
  process.exit(1);
});
