/**
 * Tests for the full license validation pipeline (validator.ts).
 * Ported from CortexDev-Agents.
 *
 * Differences vs the original:
 *   - electron mock → setProductionBuildResolver() injection.
 *   - vi.doMock('electron', ...) → setProductionBuildResolver(() => true)
 *     before re-importing validator for the LEGACY-key fallback tests.
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize, setProductionBuildResolver } from './crypto.js';
import type { LicensePayload } from './types.js';
import { validateLicense } from './validator.js';

// Default: dev mode (mirrors the original `app: { isPackaged: false }` mock).
setProductionBuildResolver(() => false);

// ---------------------------------------------------------------------------
// Test key pair + signing helper
// ---------------------------------------------------------------------------

let testPublicKey: string;
let testPrivateKey: string;

beforeAll(() => {
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  testPublicKey = kp.publicKey;
  testPrivateKey = kp.privateKey;
});

afterEach(() => {
  setProductionBuildResolver(() => false);
});

function signPayload(payload: LicensePayload, privateKey: string): string {
  const data = Buffer.from(JSON.stringify(canonicalize(payload)), 'utf8');
  return createSign('SHA256').update(data).sign(privateKey).toString('base64');
}

function makeLicense(
  overrides: Partial<LicensePayload> = {},
  privateKey?: string
): { payload: LicensePayload; signature: string } {
  const payload: LicensePayload = {
    version: 1,
    type: 'pro',
    license_id: 'test-license-id',
    user: 'Test User',
    email: 'test@example.com',
    fingerprint: 'a'.repeat(64),
    issued_at: new Date(Date.now() - 86400_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    features: [],
    ...overrides,
  };
  const signature = signPayload(payload, privateKey ?? testPrivateKey);
  return { payload, signature };
}

const DEVICE_FP = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateLicense()', () => {
  it('returns valid for a correctly signed, unexpired, fingerprint-matched license', () => {
    const license = makeLicense({ fingerprint: DEVICE_FP });
    const result = validateLicense(license, DEVICE_FP, { publicKey: testPublicKey });
    expect(result.valid).toBe(true);
    expect(result.license).toBeDefined();
    expect(result.reason).toBeUndefined();
  });

  it('returns valid for a free license (no fingerprint check)', () => {
    const freeLicense = makeLicense({ type: 'free', fingerprint: null, expires_at: null });
    const result = validateLicense(freeLicense, null, { publicKey: testPublicKey });
    expect(result.valid).toBe(true);
  });

  it('returns invalid_structure for null input', () => {
    const result = validateLicense(null, DEVICE_FP, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_structure');
  });

  it('returns invalid_structure for missing payload', () => {
    const result = validateLicense({ signature: 'abc' }, DEVICE_FP, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_structure');
  });

  it('returns invalid_structure for missing signature', () => {
    const result = validateLicense({ payload: {} }, DEVICE_FP, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_structure');
  });

  it('returns invalid_schema for wrong version', () => {
    const license = makeLicense({ version: 2 as unknown as 1 });
    const result = validateLicense(license, DEVICE_FP, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_schema');
    expect(result.errors).toBeDefined();
  });

  it('returns invalid_signature for tampered payload', () => {
    const license = makeLicense({ fingerprint: DEVICE_FP });
    const tampered = { ...license, payload: { ...license.payload, user: 'hacker' } };
    const result = validateLicense(tampered, DEVICE_FP, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('returns invalid_signature for wrong public key', () => {
    const license = makeLicense({ fingerprint: DEVICE_FP });
    const { publicKey: otherKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const result = validateLicense(license, DEVICE_FP, { publicKey: otherKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('returns fingerprint_mismatch when device fingerprint differs', () => {
    const license = makeLicense({ fingerprint: DEVICE_FP });
    const differentFp = 'b'.repeat(64);
    const result = validateLicense(license, differentFp, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('fingerprint_mismatch');
  });

  it('returns fingerprint_unavailable when fingerprint is null for pro license', () => {
    const license = makeLicense({ fingerprint: DEVICE_FP });
    const result = validateLicense(license, null, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('fingerprint_unavailable');
  });

  it('skips fingerprint check for pro license with null fingerprint in payload', () => {
    const license = makeLicense({ fingerprint: 'a'.repeat(64) });
    const noFpPayload = { ...license.payload, fingerprint: null };
    const sig = signPayload(noFpPayload as unknown as LicensePayload, testPrivateKey);
    const result = validateLicense({ payload: noFpPayload, signature: sig }, 'any-fingerprint', {
      publicKey: testPublicKey,
    });
    expect(result.reason).not.toBe('fingerprint_mismatch');
    expect(result.reason).not.toBe('fingerprint_unavailable');
  });

  it('returns expired for a license past its expires_at', () => {
    const license = makeLicense({
      fingerprint: DEVICE_FP,
      expires_at: new Date(Date.now() - 86400_000).toISOString(),
    });
    const result = validateLicense(license, DEVICE_FP, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
    expect(result.license).toBeDefined();
  });

  it('skips expiry check when skipExpiryCheck=true', () => {
    const license = makeLicense({
      fingerprint: DEVICE_FP,
      expires_at: new Date(Date.now() - 86400_000).toISOString(),
    });
    const result = validateLicense(license, DEVICE_FP, {
      publicKey: testPublicKey,
      skipExpiryCheck: true,
    });
    expect(result.valid).toBe(true);
  });

  it('returns clock_tamper when current time is before issued_at', () => {
    const futureIssuedAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    const license = makeLicense({ fingerprint: DEVICE_FP, issued_at: futureIssuedAt });
    const result = validateLicense(license, DEVICE_FP, { publicKey: testPublicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('clock_tamper');
  });

  it('returns clock_tamper when current time is before last_verified_at (minus tolerance)', () => {
    const license = makeLicense({ fingerprint: DEVICE_FP });
    const futureLastVerified = new Date(Date.now() + 120_000).toISOString();
    const result = validateLicense(license, DEVICE_FP, {
      publicKey: testPublicKey,
      lastVerifiedAt: futureLastVerified,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('clock_tamper');
  });

  it('does not flag clock_tamper within tolerance (60s)', () => {
    const license = makeLicense({ fingerprint: DEVICE_FP });
    const slightlyFuture = new Date(Date.now() + 30_000).toISOString();
    const result = validateLicense(license, DEVICE_FP, {
      publicKey: testPublicKey,
      lastVerifiedAt: slightlyFuture,
    });
    expect(result.reason).not.toBe('clock_tamper');
  });

  describe('LEGACY-key fallback path', () => {
    const ef14LegacyFP = '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3';
    const ef14LegacyLicenseOriginal = {
      payload: {
        version: 1 as const,
        type: 'pro' as const,
        license_id: '4f56ab7d-7d0b-44fd-9ea5-0834b78b628f',
        user: 'moxiaoxi@dev.local',
        email: 'moxiaoxi@dev.local',
        fingerprint: ef14LegacyFP,
        issued_at: '2026-04-22T15:42:05.346Z',
        expires_at: '2026-05-22T15:42:05.346Z',
        features: [],
      },
      signature:
        'MEUCIDOLYVos9Bp6Z6UGskoZrJ1QmZKF2ngneVf/Qp3OBTBeAiEAnO0dLgeRqbMELMSME6QB8gIulN0nA8xm2qQRaldA4GY=',
    };

    it('falls back to LEGACY_KEYS when no explicit publicKey is provided (packaged build)', () => {
      setProductionBuildResolver(() => true);
      delete process.env.CORTEXDEV_PUBLIC_KEY;

      const result = validateLicense(ef14LegacyLicenseOriginal, ef14LegacyFP);
      // Signature must verify via the legacy fallback. Expiry / fingerprint
      // checks may still fail (this fixture has long-past expires_at) — the
      // contract here is purely that we never return `invalid_signature`.
      expect(result.reason).not.toBe('invalid_signature');
    });

    it('still rejects EF14-signed license when an explicit non-matching publicKey is passed', () => {
      setProductionBuildResolver(() => true);
      delete process.env.CORTEXDEV_PUBLIC_KEY;

      const result = validateLicense(ef14LegacyLicenseOriginal, ef14LegacyFP, {
        publicKey: testPublicKey,
      });
      expect(result.reason).toBe('invalid_signature');
    });
  });
});
