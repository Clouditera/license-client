/**
 * Verify a server-signed `online_check_token` against the locally-bound
 * license_id (D4).
 *
 * Ported byte-equivalent from CLI legacy
 * `packages/devagent-pro/src/license/online-check.js`.
 *
 * The function is intentionally a pure verifier:
 *   - it does NOT read disk (caller fetches the token from online-check.json)
 *   - it does NOT call the network (the whole point of D4 is offline grace)
 *   - it does NOT throw (failures are returned as discriminated verdicts so
 *     callers can distinguish "malformed → fall through to legacy Path B"
 *     from "tamper / wrong id / expired → hard fail")
 *
 * The `embeddedTokenPublicKey` is injected (rather than imported from
 * `./token-key.js`) so the caller can wire in a test key, and so this module
 * stays free of module-load-time side effects of `token-key.ts`.
 */

import { verifySignature } from './crypto.js';
import type { OnlineCheckVerdict } from './types.js';

/**
 * Token payload shape after structural validation. Kept loose because the
 * payload may have arrived from disk in any state.
 */
interface MaybeSignedToken {
  payload?: unknown;
  signature?: unknown;
}

interface TokenPayload {
  license_id: string;
  expires_at: string;
  // Other server-controlled fields (server_time) ride along and are part of
  // the signed canonical form, but verification itself only consumes
  // license_id + expires_at.
  [key: string]: unknown;
}

function isTokenPayload(value: unknown): value is TokenPayload {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['license_id'] === 'string' && typeof obj['expires_at'] === 'string';
}

/**
 * Verify a token. Never throws.
 *
 *   { valid: true }
 *   { valid: false, reason: 'malformed' | 'id_mismatch' | 'expired' | 'invalid_signature' }
 *
 * Caller semantics (mirrors CLI `gate.js: checkOfflineGrace` Path A):
 *   - `malformed` → tolerated; fall through to legacy Path B (60-day window)
 *   - any other failure → HARD FAIL; do NOT slip past into Path B
 *
 * Conflating the two would let an attacker break a signature and slide into
 * the more permissive Path B window.
 */
export function verifyOnlineCheckToken(
  token: unknown,
  licenseId: string,
  embeddedTokenPublicKey: string
): OnlineCheckVerdict {
  // Structural validation — both halves of { payload, signature } must exist.
  if (token === null || typeof token !== 'object') {
    return { valid: false, reason: 'malformed' };
  }
  const maybe = token as MaybeSignedToken;
  const { payload, signature } = maybe;
  if (!isTokenPayload(payload) || typeof signature !== 'string' || signature.length === 0) {
    return { valid: false, reason: 'malformed' };
  }

  // license_id binding — token must belong to the locally-installed license.
  if (payload.license_id !== licenseId) {
    return { valid: false, reason: 'id_mismatch' };
  }

  // Expiry — server-controlled `expires_at`. Unparseable values are treated as
  // expired so a corrupted timestamp cannot trick us into "never expires".
  const expiresMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) {
    return { valid: false, reason: 'expired' };
  }

  // Cryptographic signature over canonicalize(payload). Reuses crypto.ts so
  // the canonical form is byte-identical with license payload signing.
  if (!verifySignature(payload, signature, embeddedTokenPublicKey)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true };
}
