/**
 * Full license validation pipeline with anti-tamper clock protection.
 *
 * Ported byte-equivalent from CortexDev-Agents/src/main/core/license/validator.ts.
 * Only change: import paths updated to local `.js` siblings.
 *
 * Validation steps (in order):
 *   1. Structure check: { payload, signature } shape
 *   2. Schema check: field types and format (validatePayload)
 *   3. Clock tamper — issued_at lower bound
 *   4. Clock tamper — last_verified_at rollback
 *   5. Signature check: ECDSA P-256 (verifySignature)
 *   6. Fingerprint check: device binding (matchFingerprint)
 *   7. Expiry check: expires_at with optional server time
 *
 * SECURITY: This module is intended to run only in the host process.
 */

import { verifySignature } from './crypto.js';
import { matchFingerprint } from './fingerprint.js';
import { validatePayload } from './schema.js';
import type { LicenseErrorReason, LicenseFile, LicensePayload } from './types.js';

// ---------------------------------------------------------------------------
// Clock-tamper threshold
// ---------------------------------------------------------------------------

/** Allow up to 60 seconds of clock drift before flagging rollback. */
const CLOCK_TAMPER_TOLERANCE_MS = 60_000;

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidateResult {
  valid: boolean;
  reason?: LicenseErrorReason;
  license?: LicensePayload;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Core validation pipeline
// ---------------------------------------------------------------------------

export interface ValidateLicenseOptions {
  /** When true, skip the `expires_at` check (caller handles expiry separately). */
  skipExpiryCheck?: boolean;
  /** Override the public key (used in tests). */
  publicKey?: string;
  /**
   * Anti-tamper: ISO-8601 timestamp of the last known-good validation.
   * If set and the current system time is earlier (minus tolerance), the
   * validation fails with `clock_tamper`.
   */
  lastVerifiedAt?: string | null;
  /**
   * Anti-tamper: optional server-provided current time used in expiry check.
   * When present, `Math.max(serverTime, localTime)` is used to prevent the
   * user from reusing a stale server timestamp to bypass expiry.
   */
  serverTime?: string | null;
}

/**
 * Full license validation pipeline.
 */
export function validateLicense(
  licenseFile: unknown,
  currentFingerprint: string | null,
  opts: ValidateLicenseOptions = {}
): ValidateResult {
  // Step 1: Structure check
  if (
    !licenseFile ||
    typeof licenseFile !== 'object' ||
    !(licenseFile as Record<string, unknown>)['payload'] ||
    !(licenseFile as Record<string, unknown>)['signature']
  ) {
    return { valid: false, reason: 'invalid_structure' };
  }

  const { payload, signature } = licenseFile as LicenseFile;

  // Step 2: Schema validation
  const schemaResult = validatePayload(payload);
  if (!schemaResult.valid) {
    return { valid: false, reason: 'invalid_schema', errors: schemaResult.errors };
  }

  const typedPayload = payload;

  // Step 3: Clock tamper — issued_at lower bound
  const now = Date.now();
  if (typedPayload.issued_at) {
    const issuedAt = new Date(typedPayload.issued_at).getTime();
    if (Number.isFinite(issuedAt) && now < issuedAt - CLOCK_TAMPER_TOLERANCE_MS) {
      return { valid: false, reason: 'clock_tamper' };
    }
  }

  // Step 4: Clock tamper — last_verified_at rollback
  if (opts.lastVerifiedAt) {
    const lastVerified = new Date(opts.lastVerifiedAt).getTime();
    if (Number.isFinite(lastVerified) && now < lastVerified - CLOCK_TAMPER_TOLERANCE_MS) {
      return { valid: false, reason: 'clock_tamper' };
    }
  }

  // Step 5: Signature verification
  const sigValid = opts.publicKey
    ? verifySignature(typedPayload, signature, opts.publicKey)
    : verifySignature(typedPayload, signature);
  if (!sigValid) {
    return { valid: false, reason: 'invalid_signature' };
  }

  // Step 6: Fingerprint check (pro licenses only, when fingerprint is set)
  if (typedPayload.type === 'pro' && typedPayload.fingerprint) {
    if (!currentFingerprint) {
      return { valid: false, reason: 'fingerprint_unavailable' };
    }
    if (!matchFingerprint(typedPayload.fingerprint, currentFingerprint)) {
      return { valid: false, reason: 'fingerprint_mismatch' };
    }
  }

  // Step 7: Expiry check
  if (!opts.skipExpiryCheck && typedPayload.expires_at) {
    const expiresAt = new Date(typedPayload.expires_at).getTime();
    const effectiveNow = opts.serverTime
      ? Math.max(new Date(opts.serverTime).getTime() || now, now)
      : now;
    if (expiresAt < effectiveNow) {
      return { valid: false, reason: 'expired', license: typedPayload };
    }
  }

  return { valid: true, license: typedPayload };
}
