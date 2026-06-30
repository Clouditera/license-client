#!/usr/bin/env node
/**
 * Generate a dedicated production online_check_token signing keypair.
 *
 * The token trust root is intentionally SEPARATE from both the dev token key
 * (src/token-key.ts DEV_TOKEN_KEY) and the license PROD_KEY (src/crypto.ts).
 * See docs/d4-design.md §3.2.1 / §7 Q-1 for the rotation SOP.
 *
 * Outputs (git-ignored — token-keys/ is in .gitignore, NEVER committed):
 *   token-keys/prod-token-private.pem  (PKCS8, mode 0600) → Workers Secret + GitHub Secret
 *   token-keys/prod-token-public.pem   (SPKI)             → embed into src/token-key.ts
 *
 * Usage:
 *   node scripts/gen-prod-token-key.mjs
 *
 * Then:
 *   1. Copy the printed public block into src/token-key.ts (replace the
 *      PROD_TOKEN_KEY value).
 *   2. Push the private half:
 *        wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production \
 *          < token-keys/prod-token-private.pem
 *      and store it as the GitHub Actions secret used by the release pipeline.
 *   3. Run `pnpm run verify:trust-root` to confirm the new key isolates from
 *      DEV_TOKEN_KEY and license PROD_KEY.
 *   4. Delete the local private PEM once both stores hold it:
 *        shred -u token-keys/prod-token-private.pem  (Linux)
 *        rm -P token-keys/prod-token-private.pem     (macOS)
 *
 * Implementation note: this script is intentionally self-contained (uses only
 * node:crypto and node:fs) so it can run standalone without needing the
 * compiled @clouditera/license-client build artifact.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outDir = join(repoRoot, 'token-keys');

mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const privPath = join(outDir, 'prod-token-private.pem');
const pubPath = join(outDir, 'prod-token-public.pem');

// The `mode` option of writeFileSync only applies when the file is CREATED;
// overwriting an existing file leaves its old permissions intact. A previous
// run (or a stray file) could therefore leave the private key world-readable.
// Remove any existing file first, then chmod explicitly as belt-and-braces.
rmSync(privPath, { force: true });
writeFileSync(privPath, privateKey, { mode: 0o600 });
chmodSync(privPath, 0o600);
writeFileSync(pubPath, publicKey, { mode: 0o644 });

console.log('✅ Generated prod token keypair (P-256):');
console.log(`   private → ${privPath}  (mode 0600, git-ignored)`);
console.log(`   public  → ${pubPath}`);
console.log('');
console.log('Embed this public block as PROD_TOKEN_KEY in src/token-key.ts:');
console.log('');
console.log(publicKey.trim());
console.log('');
console.log('Next steps:');
console.log('  1. Paste the public block above into src/token-key.ts PROD_TOKEN_KEY');
console.log('  2. wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production \\');
console.log(`       < ${privPath}`);
console.log('  3. Store the same private key as a GitHub Actions secret');
console.log('  4. pnpm run verify:trust-root  (confirms isolation)');
console.log('  5. shred -u or rm -P the local private PEM');
