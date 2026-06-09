/**
 * License payload schema validation and expiry checks.
 *
 * Ported from CortexDev-Agents/src/main/core/license/schema.ts and aligned
 * with vendor/cortexdev-pro/packages/core/src/license/schema.js so a license
 * file that passes the legacy CLI validation will also pass here.
 */

import type { LicensePayload } from './types.js';

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate the structure and field types of a license payload.
 *
 * Does NOT check the ECDSA signature or device fingerprint — those are
 * handled by `validator.ts` after schema validation passes.
 *
 * @param payload  The `payload` field from a `LicenseFile` object.
 * @returns `{ valid, errors }` — `errors` is empty when `valid` is true.
 */
export function validatePayload(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload must be an object'] };
  }

  const p = payload as Record<string, unknown>;

  // version
  if (p['version'] !== 1) errors.push('version must be 1');

  // type
  if (!['pro', 'free'].includes(p['type'] as string)) {
    errors.push("type must be 'pro' or 'free'");
  }

  // license_id
  if (typeof p['license_id'] !== 'string' || p['license_id'].length === 0) {
    errors.push('license_id is required');
  }

  // user
  if (typeof p['user'] !== 'string' || p['user'].length === 0) {
    errors.push('user is required');
  }

  // email
  if (typeof p['email'] !== 'string' || !p['email'].includes('@')) {
    errors.push('email must contain @');
  }

  // fingerprint: 64-char hex for pro; null/undefined for free
  if (p['type'] === 'pro') {
    if (typeof p['fingerprint'] !== 'string' || !/^[0-9a-f]{64}$/i.test(p['fingerprint'])) {
      errors.push('fingerprint must be 64-char hex for pro license');
    }
  } else {
    if (p['fingerprint'] !== null && p['fingerprint'] !== undefined) {
      errors.push('fingerprint must be null for free license');
    }
  }

  // issued_at
  if (typeof p['issued_at'] !== 'string' || isNaN(Date.parse(p['issued_at']))) {
    errors.push('issued_at must be valid ISO-8601');
  }

  // expires_at: required ISO-8601 string for pro; must be null for free
  if (p['type'] === 'pro') {
    if (typeof p['expires_at'] !== 'string' || isNaN(Date.parse(p['expires_at']))) {
      errors.push('expires_at must be valid ISO-8601 for pro license');
    }
  } else if (p['type'] === 'free') {
    // Free licenses must have `expires_at: null` (or omitted).
    // Accepting an arbitrary ISO string here would let a forged free license
    // claim a future expiry — we mirror the CLI which treats free as eternal.
    if (p['expires_at'] !== null && p['expires_at'] !== undefined) {
      errors.push('expires_at must be null for free license');
    }
  }

  // features: must be an array of strings (covered by signature, so a tampered
  // payload can't sneak non-string entries past us at runtime).
  const features = p['features'];
  if (!Array.isArray(features)) {
    errors.push('features must be an array');
  } else if (!features.every((f) => typeof f === 'string')) {
    errors.push('features must be an array of strings');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Expiry checks
// ---------------------------------------------------------------------------

/**
 * Check whether a license has expired using local system time only.
 * Returns `false` if `expires_at` is null (never expires).
 */
export function isExpired(payload: LicensePayload): boolean {
  if (!payload.expires_at) return false;
  return new Date(payload.expires_at).getTime() < Date.now();
}

/**
 * Check whether a license has expired, preferring a server-provided timestamp
 * to prevent local clock manipulation.
 *
 * Mirrors `isExpiredWithServerTime()` from the legacy CLI so all consumers
 * behave identically when an `online-check.json` server timestamp is
 * available.
 *
 * @param payload     License payload with optional `expires_at`.
 * @param serverTime  ISO-8601 timestamp from an online server check (may be
 *                    null / undefined when the device is offline).
 */
export function isExpiredWithServerTime(
  payload: LicensePayload,
  serverTime?: string | null
): boolean {
  if (!payload.expires_at) return false;
  const expiresAt = new Date(payload.expires_at).getTime();

  if (serverTime) {
    const st = new Date(serverTime).getTime();
    if (Number.isFinite(st)) {
      // Use whichever timestamp is later so a stale server_time cannot be
      // reused to extend an already-expired license.
      const now = Math.max(st, Date.now());
      return expiresAt < now;
    }
  }

  return expiresAt < Date.now();
}
