#!/usr/bin/env node
/**
 * Print the SHA-256 DER fingerprint of the PROD_TOKEN_KEY embedded in
 * license-mgr's src/token-key.ts.
 *
 * This is the "single source of truth" — whatever the client currently
 * trusts. swap-prod-token-key.sh uses this as the EXPECTED fingerprint
 * by default, so rotations don't require editing the swap script.
 *
 * Usage:
 *   node scripts/derive-prod-token-fp.mjs               # default: ../src/token-key.ts
 *   node scripts/derive-prod-token-fp.mjs /path/to/token-key.ts
 *
 * Exit codes:
 *   0 — printed hex fingerprint to stdout
 *   1 — could not read or parse the source file
 */

import { readFileSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultSource = join(here, '..', 'src', 'token-key.ts');
const sourcePath = process.argv[2] || defaultSource;

let text;
try {
  text = readFileSync(sourcePath, 'utf8');
} catch (err) {
  console.error(`Could not read ${sourcePath}: ${err.message}`);
  process.exit(1);
}

const m = text.match(
  /const PROD_TOKEN_KEY = `(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)`/,
);
if (!m) {
  console.error(`Could not extract PROD_TOKEN_KEY PEM block from ${sourcePath}`);
  process.exit(1);
}

const der = createPublicKey(m[1]).export({ type: 'spki', format: 'der' });
console.log(createHash('sha256').update(der).digest('hex'));
