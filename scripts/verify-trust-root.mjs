#!/usr/bin/env node
/**
 * Verify token + license trust-root isolation.
 *
 * Mirrors devagent-cli `.github/workflows/ci.yml` "Verify token trust-root
 * isolation" + `.github/actions/verify-key/action.yml` PLACEHOLDER detection.
 * Runs in two layers:
 *
 *   Layer 1: text PLACEHOLDER detection
 *     - Greps the PROD_KEY block in src/crypto.ts
 *     - Greps the PROD_TOKEN_KEY block in src/token-key.ts
 *     Either still containing "PLACEHOLDER" fails the build loud.
 *
 *   Layer 2: DER-byte collision detection
 *     - publicKeysEqual(PROD_TOKEN_KEY, DEV_TOKEN_KEY) === false
 *       Otherwise prod builds would trust forged tokens (revocation bypass)
 *     - publicKeysEqual(PROD_TOKEN_KEY, PROD_KEY) === false
 *       Otherwise the two trust roots collapse, defeating the §N4 design
 *
 * Invoked by:
 *   - .github/workflows/ci.yml (every push / PR)
 *   - .github/workflows/release.yml (every v* tag, before publish)
 *   - `pnpm run verify:trust-root` (local sanity)
 *
 * Exits 0 on success, 1 on any failure.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const errors = [];

// ---------------------------------------------------------------------------
// Layer 1: text PLACEHOLDER detection
// ---------------------------------------------------------------------------

function extractBlock(file, constName) {
  const src = readFileSync(join(repoRoot, file), 'utf8');
  // Match: const NAME = `-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----`
  const regex = new RegExp(
    `const ${constName}\\s*=\\s*\`([\\s\\S]*?-----END PUBLIC KEY-----)\``,
    'm',
  );
  const m = src.match(regex);
  return m ? m[1] : null;
}

function checkPlaceholder(file, constName) {
  const block = extractBlock(file, constName);
  if (!block) {
    errors.push(`Could not locate ${constName} block in ${file}`);
    return;
  }
  if (block.includes('PLACEHOLDER')) {
    errors.push(`FATAL: ${constName} in ${file} is PLACEHOLDER — cannot release`);
    return;
  }
  console.log(`✓ ${constName} in ${file} is not a PLACEHOLDER`);
}

checkPlaceholder('src/crypto.ts', 'PROD_KEY');
checkPlaceholder('src/token-key.ts', 'PROD_TOKEN_KEY');

// ---------------------------------------------------------------------------
// Layer 2: DER-byte collision detection (build dist first, then load)
// ---------------------------------------------------------------------------
//
// We load the BUILT artifact (dist/) rather than the source so we exercise
// the actual shipped bytes. The CI ordering guarantees `pnpm run build` ran
// before this script.
//
// In local dev where dist/ may be stale, fall back to source via tsx — but
// the CI invocation always runs after build, so this is just a convenience.

let tokenMod;
let cryptoInternal;
try {
  const distPath = join(repoRoot, 'dist', 'index.js');
  // pathToFileURL is required on Windows: the default ESM loader rejects
  // absolute paths with a drive-letter scheme (`d:\...`) and demands a
  // proper `file:///d:/...` URL. Unix hosts accept both, so this normalises.
  const mod = await import(pathToFileURL(distPath).href);
  tokenMod = {
    PROD_TOKEN_KEY: mod.PROD_TOKEN_KEY,
    DEV_TOKEN_KEY: mod.DEV_TOKEN_KEY,
    publicKeysEqual: mod.publicKeysEqual,
  };
  cryptoInternal = mod._cryptoInternal;
} catch (e) {
  errors.push(
    `Could not load dist/ — run \`pnpm run build\` first. (${e instanceof Error ? e.message : String(e)})`,
  );
}

if (tokenMod && cryptoInternal) {
  if (tokenMod.publicKeysEqual(tokenMod.PROD_TOKEN_KEY, tokenMod.DEV_TOKEN_KEY)) {
    errors.push(
      'FATAL: PROD_TOKEN_KEY equals DEV_TOKEN_KEY — token trust root not isolated. ' +
        'Generate a dedicated prod token keypair (scripts/gen-prod-token-key.mjs).',
    );
  } else {
    console.log('✓ PROD_TOKEN_KEY is isolated from DEV_TOKEN_KEY');
  }

  if (tokenMod.publicKeysEqual(tokenMod.PROD_TOKEN_KEY, cryptoInternal.PROD_KEY)) {
    errors.push(
      'FATAL: PROD_TOKEN_KEY equals license PROD_KEY — trust roots must be separate ' +
        '(see docs/d4-design.md §N4 separation of trust roots).',
    );
  } else {
    console.log('✓ PROD_TOKEN_KEY is isolated from license PROD_KEY');
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

if (errors.length > 0) {
  for (const err of errors) {
    console.error(`::error::${err}`);
  }
  process.exit(1);
}

console.log('\n✓ Trust-root isolation verified');
