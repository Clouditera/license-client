/**
 * Token signing public key — separate trust root from the license signing key.
 *
 * The license key (`crypto.ts: PROD_KEY` / `DEV_KEY`) signs license payloads
 * themselves. The TOKEN key signs short-lived `online_check_token` responses
 * returned by `/refresh` and `/activate`, which the client verifies offline to
 * extend the grace window without re-contacting the server (see D4).
 *
 * Separating the two trust roots means a compromise of one does NOT
 * automatically forge the other.
 *
 * Build-mode detection reuses `isProductionBuild()` from crypto.ts so the same
 * production resolver applies uniformly to license keys and token keys.
 *
 *   - DEV_TOKEN_KEY  : committed dev test key, byte-identical to the CLI's
 *                      `packages/core/src/license/token-key.js` DEV_TOKEN_KEY.
 *                      Private half lives in CLI repo `dev-keys/token-private.pem`
 *                      (intentionally checked in for local dev).
 *   - PROD_TOKEN_KEY : production key. Only the public half is embedded;
 *                      private half lives in the Workers Secret store
 *                      (TOKEN_SIGNING_PRIVATE_KEY) and is NEVER committed.
 *                      Byte-identical to CLI PROD_TOKEN_KEY.
 *
 * env override (`DEVAGENT_TOKEN_PUBLIC_KEY`):
 *   - Honoured in dev builds (self-hosted token server testing).
 *   - **Refused in prod builds** — same hardening as crypto.ts CORTEXDEV_PUBLIC_KEY.
 *
 * NAMING NOTE: env var is `DEVAGENT_TOKEN_PUBLIC_KEY` (not CORTEXDEV_*) to
 * remain byte-equivalent with the CLI legacy implementation. The mismatch with
 * other license-client `CORTEXDEV_*` env vars is intentional and tracked in
 * docs/d4-design.md §7 Q-5.
 */

import { createPublicKey } from 'node:crypto';

import { isProductionBuild } from './crypto.js';

/**
 * DEV_TOKEN_KEY — byte-identical to CLI `packages/core/src/license/token-key.js`.
 * Used in dev / test builds. The matching private half is publicly checked in
 * to the CLI repo (`dev-keys/token-private.pem`) for local-development token
 * signing; it must NEVER be trusted in a production build.
 */
const DEV_TOKEN_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEw8qCPevlaKrQ6qhm4HGX8cRMl4z0
SoiMJijUXGlEO71wfrEL8t/SQAnk3H1/eTGk+nEHjz7iMh39HuDcvINK6w==
-----END PUBLIC KEY-----`;

/**
 * PROD_TOKEN_KEY — production online_check_token verification key. A dedicated
 * prod token trust root, SEPARATE from both DEV_TOKEN_KEY and the license
 * PROD_KEY (crypto.ts). The matching private half lives ONLY in the Workers
 * Secret store (TOKEN_SIGNING_PRIVATE_KEY, env=production) and the release
 * pipeline — it is NEVER committed.
 *
 * Byte-identical to CLI PROD_TOKEN_KEY.
 *
 * Rotation: regenerate the pair with `node scripts/gen-prod-token-key.mjs`,
 * replace the public block below, then push the private half to the Workers
 * Secret + GitHub Secret. See docs/d4-design.md §7 Q-1 for SOP.
 */
const PROD_TOKEN_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqAQq6qwUsL6MVjtR9vs7z27Se4fC
ogoFylACH70K9c5YHz9lZbUDLfm5Hx0CokjETppDQaXPUehmIm5Qhhp1SQ==
-----END PUBLIC KEY-----`;

/**
 * Compare two SPKI public keys by their canonical DER bytes rather than by raw
 * PEM string. PEM is whitespace / line-ending insensitive, so a textual
 * `a.trim() === b.trim()` can be defeated by re-wrapping the same key — which
 * would let a re-formatted dev key slip past the collision guard. Decoding to
 * DER first makes the comparison about the KEY, not its text encoding.
 *
 * Returns false (never throws) if either side fails to parse, so the guard
 * degrades to "not a collision" rather than crashing on malformed input.
 */
export function publicKeysEqual(a: string, b: string): boolean {
  try {
    const derA = createPublicKey(a).export({ type: 'spki', format: 'der' });
    const derB = createPublicKey(b).export({ type: 'spki', format: 'der' });
    return derA.equals(derB);
  } catch {
    return false;
  }
}

function loadEmbeddedTokenPublicKey(): string {
  const isProd = isProductionBuild();

  if (!isProd) {
    const raw = process.env['DEVAGENT_TOKEN_PUBLIC_KEY']?.trim();
    if (raw && raw.includes('BEGIN PUBLIC KEY')) {
      return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    return DEV_TOKEN_KEY;
  }

  // Prod build — env override refused, only PROD_TOKEN_KEY accepted.
  if (PROD_TOKEN_KEY.includes('PLACEHOLDER')) {
    throw new Error('[license/token-key] FATAL: PROD_TOKEN_KEY is not configured for production.');
  }
  // Defence-in-depth: a prod build must NOT embed the committed dev token key,
  // whose private half (CLI dev-keys/token-private.pem) is public. Catching the
  // collision here prevents a silent trust-root downgrade if the prod key is
  // ever reverted to the dev value.
  if (publicKeysEqual(PROD_TOKEN_KEY, DEV_TOKEN_KEY)) {
    throw new Error(
      '[license/token-key] FATAL: PROD_TOKEN_KEY equals DEV_TOKEN_KEY — ' +
        'the production token trust root is not isolated. Generate a dedicated ' +
        'prod token keypair (see docs/d4-design.md §7 Q-1).'
    );
  }
  return PROD_TOKEN_KEY;
}

export const EMBEDDED_TOKEN_PUBLIC_KEY = loadEmbeddedTokenPublicKey();
export { DEV_TOKEN_KEY, PROD_TOKEN_KEY };
