/**
 * License payload schema validation and expiry checks.
 *
 * Ported from CortexDev-Agents/src/main/core/license/schema.ts and aligned
 * with vendor/cortexdev-pro/packages/core/src/license/schema.js so a license
 * file that passes the legacy CLI validation will also pass here.
 *
 * RFC-002 (v2 schema) adds `product` + `product_version` fields for SKU-level
 * enforcement. v1 licenses continue to validate under the pre-RFC-002 rules
 * (legacy tolerance per RFC-002 §2.6).
 */

import { getHostProductIdentity } from './host-identity.js';
import { satisfies as semverSatisfies } from './semver-satisfies.js';
import type { HostProductIdentity } from './host-identity.js';
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
 * handled by `validator.ts` after schema validation passes. Product-binding
 * (v2 `product` / `product_version`) is validated STRUCTURALLY here only;
 * the runtime match against the host identity is a separate step, see
 * `checkProductCompatibility`.
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

  // version — v1 (legacy) and v2 (RFC-002) both accepted.
  const version = p['version'];
  if (version !== 1 && version !== 2) {
    errors.push('version must be 1 or 2');
  }

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

  // === v2 additions (RFC-002) — only checked when version === 2 ===
  if (version === 2) {
    if (typeof p['product'] !== 'string' || p['product'].length === 0) {
      errors.push('product must be a non-empty string');
    }
    if (typeof p['product_version'] !== 'string' || p['product_version'].length === 0) {
      errors.push('product_version must be a non-empty string');
    }
    // We deliberately do NOT call `isValidRange` here — that would tie schema
    // validity to the range-parser's grammar. A structurally-well-formed but
    // semantically-invalid range surfaces at `checkProductCompatibility` time
    // as a compatibility error, giving clearer diagnostics.
  }

  // v1 payloads should not carry v2-only fields (soft guard — real defense
  // is the signature, but we reject early for clearer error messages).
  if (version === 1) {
    if (p['product'] !== undefined || p['product_version'] !== undefined) {
      errors.push('product / product_version fields require version: 2');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Product compatibility (RFC-002)
// ---------------------------------------------------------------------------

/**
 * Reason codes emitted by `checkProductCompatibility`. Consumers (license-
 * service) map these to `LicenseErrorReason` for user-facing state.
 */
export type ProductCompatibilityReason =
  | 'product_mismatch'
  | 'product_version_mismatch'
  | 'product_version_range_invalid';

export interface ProductCompatibilityResult {
  ok: boolean;
  /**
   * Populated when `ok === false`. See `ProductCompatibilityReason`.
   */
  reason?: ProductCompatibilityReason;
  /**
   * Human-readable detail describing the mismatch, safe for logs.
   */
  detail?: string;
  /**
   * True when the check was SKIPPED because no host identity was registered.
   * Consumers should treat this as `ok` but surface the warning to help
   * catch missing `setHostProductIdentity()` calls in host bootstrap.
   *
   * Rationale: RFC-002 §7 OQ-2 / OQ-8 — allow-with-warning fail-mode.
   */
  skipped?: boolean;
  /**
   * Warning message to relay via `serviceLogger.warn` when `skipped === true`.
   */
  warn?: string;
}

/**
 * Verify that a v2 license payload's `product` + `product_version` are
 * compatible with the running host.
 *
 * v1 payloads pass through unconditionally (legacy tolerance).
 *
 * @param payload  License payload (any version). v1 is accepted as-is.
 * @param identity Host identity, or null. Defaults to the current registered
 *                 identity (via `getHostProductIdentity`), but can be
 *                 injected for testing.
 */
export function checkProductCompatibility(
  payload: LicensePayload,
  identity: HostProductIdentity | null = getHostProductIdentity()
): ProductCompatibilityResult {
  // v1 payloads have no product binding — RFC-002 §2.6 legacy tolerance.
  if (payload.version === 1) {
    return { ok: true };
  }

  // v2 payloads: if no host identity is registered, we cannot enforce.
  // Allow with a warning — this catches missing setHostProductIdentity()
  // calls in host bootstrap without breaking dev / test environments.
  // (RFC-002 §7 OQ-2 / OQ-8)
  if (identity === null) {
    return {
      ok: true,
      skipped: true,
      warn:
        '[license-client] product identity not set; skipping v2 checks — ' +
        'this is a bug in the host bootstrap',
    };
  }

  // Product code: case-sensitive exact equality.
  if (payload.product !== identity.product) {
    return {
      ok: false,
      reason: 'product_mismatch',
      detail: `license is for ${JSON.stringify(payload.product)}, host is ${JSON.stringify(identity.product)}`,
    };
  }

  // Product version: strict-SemVer satisfies. Range parse errors surface as
  // `product_version_range_invalid` so admins signing bad ranges get a
  // distinct signal from "range OK but host does not fall in it".
  try {
    const rangeOk = semverSatisfies(identity.version, payload.product_version);
    if (!rangeOk) {
      return {
        ok: false,
        reason: 'product_version_mismatch',
        detail: `host version ${JSON.stringify(identity.version)} does not satisfy license range ${JSON.stringify(payload.product_version)}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'product_version_range_invalid',
      detail: `license product_version ${JSON.stringify(payload.product_version)} is not a valid range: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true };
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
