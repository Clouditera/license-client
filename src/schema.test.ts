/**
 * Tests for license schema validation and expiry (schema.ts).
 * Ported byte-equivalent from CortexDev-Agents; extended for RFC-002 v2
 * (product / product_version) fields and `checkProductCompatibility`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  checkProductCompatibility,
  isExpired,
  isExpiredWithServerTime,
  validatePayload,
} from './schema.js';
import {
  _resetHostProductIdentityForTest,
  setHostProductIdentity,
} from './host-identity.js';
import type { LicensePayload, LicensePayloadV2 } from './types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function validProPayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    version: 1,
    type: 'pro',
    license_id: '4f56ab7d-7d0b-44fd-9ea5-0834b78b628f',
    user: 'test-user',
    email: 'test@example.com',
    fingerprint: '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3',
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2027-01-01T00:00:00.000Z',
    features: [],
    ...overrides,
  };
}

function validFreePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    version: 1,
    type: 'free',
    license_id: 'free-abcd1234',
    user: 'free-user',
    email: 'free@example.com',
    fingerprint: null,
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    features: [],
    ...overrides,
  };
}

function validV2Payload(overrides: Partial<LicensePayloadV2> = {}): LicensePayloadV2 {
  return {
    version: 2,
    type: 'pro',
    license_id: 'v2-abcd1234',
    user: 'v2-user',
    email: 'v2@example.com',
    fingerprint: '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3',
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2027-01-01T00:00:00.000Z',
    features: [],
    product: 'devagent-cli',
    product_version: '*',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validatePayload()
// ---------------------------------------------------------------------------

describe('validatePayload()', () => {
  it('returns valid for a correct pro payload', () => {
    const result = validatePayload(validProPayload());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid for a correct free payload', () => {
    const result = validatePayload(validFreePayload());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns invalid for null payload', () => {
    const result = validatePayload(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must be an object/i);
  });

  it('returns invalid for non-object payload', () => {
    const result = validatePayload('not an object');
    expect(result.valid).toBe(false);
  });

  it('accepts version 2 (RFC-002 v2 schema) when product + product_version present', () => {
    const result = validatePayload(validV2Payload());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects version != 1 && != 2', () => {
    const result = validatePayload({ ...validProPayload(), version: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('rejects unknown type', () => {
    const result = validatePayload({ ...validProPayload(), type: 'enterprise' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('type'))).toBe(true);
  });

  it('rejects missing license_id', () => {
    const result = validatePayload({ ...validProPayload(), license_id: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('license_id'))).toBe(true);
  });

  it('rejects missing user', () => {
    const result = validatePayload({ ...validProPayload(), user: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('user'))).toBe(true);
  });

  it('rejects email without @', () => {
    const result = validatePayload({ ...validProPayload(), email: 'notanemail' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('email'))).toBe(true);
  });

  it('rejects pro license with null fingerprint', () => {
    const result = validatePayload({ ...validProPayload(), fingerprint: null });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fingerprint'))).toBe(true);
  });

  it('rejects pro license with short fingerprint', () => {
    const result = validatePayload({ ...validProPayload(), fingerprint: 'short' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fingerprint'))).toBe(true);
  });

  it('rejects pro license with non-hex fingerprint', () => {
    const result = validatePayload({
      ...validProPayload(),
      fingerprint: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fingerprint'))).toBe(true);
  });

  it('rejects free license with non-null fingerprint', () => {
    const result = validatePayload({
      ...validFreePayload(),
      fingerprint: '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fingerprint'))).toBe(true);
  });

  it('rejects invalid issued_at', () => {
    const result = validatePayload({ ...validProPayload(), issued_at: 'not-a-date' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('issued_at'))).toBe(true);
  });

  it('rejects pro license with null expires_at', () => {
    const result = validatePayload({ ...validProPayload(), expires_at: null });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('expires_at'))).toBe(true);
  });

  it('rejects pro license with invalid expires_at', () => {
    const result = validatePayload({ ...validProPayload(), expires_at: 'not-a-date' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('expires_at'))).toBe(true);
  });

  it('accepts free license with null expires_at', () => {
    const result = validatePayload({ ...validFreePayload(), expires_at: null });
    expect(result.valid).toBe(true);
  });

  it('rejects free license with non-null expires_at', () => {
    const result = validatePayload({
      ...validFreePayload(),
      expires_at: '2099-01-01T00:00:00.000Z',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('expires_at'))).toBe(true);
  });

  it('rejects missing features array', () => {
    const payload = validProPayload() as unknown as Record<string, unknown>;
    delete payload.features;

    const result = validatePayload(payload);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('features must be an array');
  });

  it('rejects features with non-string entries', () => {
    const result = validatePayload({ ...validProPayload(), features: ['pro', 123] });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('features must be an array of strings');
  });

  it('accumulates multiple errors', () => {
    const result = validatePayload({ version: 2, type: 'bad', license_id: '', user: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// isExpired()
// ---------------------------------------------------------------------------

describe('isExpired()', () => {
  it('returns false for a future expires_at', () => {
    const payload = validProPayload({ expires_at: '2099-01-01T00:00:00.000Z' });
    expect(isExpired(payload)).toBe(false);
  });

  it('returns true for a past expires_at', () => {
    const payload = validProPayload({ expires_at: '2020-01-01T00:00:00.000Z' });
    expect(isExpired(payload)).toBe(true);
  });

  it('returns false when expires_at is null', () => {
    const payload = validFreePayload({ expires_at: null });
    expect(isExpired(payload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExpiredWithServerTime()
// ---------------------------------------------------------------------------

describe('isExpiredWithServerTime()', () => {
  it('returns false with a future expires_at using local time', () => {
    const payload = validProPayload({ expires_at: '2099-01-01T00:00:00.000Z' });
    expect(isExpiredWithServerTime(payload)).toBe(false);
  });

  it('returns true with a past expires_at using local time', () => {
    const payload = validProPayload({ expires_at: '2020-01-01T00:00:00.000Z' });
    expect(isExpiredWithServerTime(payload)).toBe(true);
  });

  it('uses server_time when provided and valid', () => {
    // License expires in the far future, but server says it is already past that date
    const farFuture = '2050-01-01T00:00:00.000Z';
    const payload = validProPayload({ expires_at: '2030-01-01T00:00:00.000Z' });
    expect(isExpiredWithServerTime(payload, farFuture)).toBe(true);
  });

  it('falls back to local time when server_time is invalid', () => {
    const payload = validProPayload({ expires_at: '2099-01-01T00:00:00.000Z' });
    expect(isExpiredWithServerTime(payload, 'not-a-date')).toBe(false);
  });

  it('falls back to local time when server_time is null', () => {
    const payload = validProPayload({ expires_at: '2099-01-01T00:00:00.000Z' });
    expect(isExpiredWithServerTime(payload, null)).toBe(false);
  });

  it('prefers later of local time vs server_time (anti-stale-server-time attack)', () => {
    // Server time is in 2020 (stale), local is current — should use local
    const payload = validProPayload({ expires_at: '2099-01-01T00:00:00.000Z' });
    const staleServerTime = '2020-01-01T00:00:00.000Z';
    expect(isExpiredWithServerTime(payload, staleServerTime)).toBe(false);
  });

  it('returns false when expires_at is null', () => {
    const payload = validFreePayload({ expires_at: null });
    expect(isExpiredWithServerTime(payload, '2026-01-01T00:00:00.000Z')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v2 payload structural validation (RFC-002)
// ---------------------------------------------------------------------------

describe('validatePayload() — v2 (RFC-002)', () => {
  it('rejects v2 missing product', () => {
    const p = validV2Payload();
    delete (p as { product?: unknown }).product;
    const result = validatePayload(p);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('product must be'))).toBe(true);
  });

  it('rejects v2 with empty-string product', () => {
    const result = validatePayload(validV2Payload({ product: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('product must be'))).toBe(true);
  });

  it('rejects v2 missing product_version', () => {
    const p = validV2Payload();
    delete (p as { product_version?: unknown }).product_version;
    const result = validatePayload(p);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('product_version'))).toBe(true);
  });

  it('accepts arbitrary product code (RFC-002 §2.1.1 open string)', () => {
    const result = validatePayload(validV2Payload({ product: 'future-product-xyz' }));
    expect(result.valid).toBe(true);
  });

  it('does not validate the range syntax at schema-level', () => {
    // A malformed range still passes structural validation; range errors
    // surface at checkProductCompatibility() time for clearer diagnostics.
    const result = validatePayload(validV2Payload({ product_version: 'not-a-range' }));
    expect(result.valid).toBe(true);
  });

  it('rejects v1 payload carrying v2-only product field', () => {
    const p = { ...validProPayload(), product: 'devagent-cli' };
    const result = validatePayload(p);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('require version: 2'))).toBe(true);
  });

  it('rejects v1 payload carrying v2-only product_version field', () => {
    const p = { ...validProPayload(), product_version: '*' };
    const result = validatePayload(p);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('require version: 2'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkProductCompatibility (RFC-002 §2.3)
// ---------------------------------------------------------------------------

describe('checkProductCompatibility()', () => {
  afterEach(() => {
    _resetHostProductIdentityForTest();
  });

  it('v1 payload always passes (legacy tolerance)', () => {
    // No host identity registered, v1 payload → skip and pass.
    const result = checkProductCompatibility(validProPayload());
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it('v2 payload with no host identity → allow-with-warning', () => {
    const result = checkProductCompatibility(validV2Payload());
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.warn).toContain('product identity not set');
    expect(result.warn).toContain('bug in the host bootstrap');
  });

  it('v2 product match + wildcard version → ok', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    const result = checkProductCompatibility(validV2Payload({ product_version: '*' }));
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it('v2 product mismatch → product_mismatch', () => {
    setHostProductIdentity({ product: 'devagent-app', version: '1.0.0' });
    const result = checkProductCompatibility(
      validV2Payload({ product: 'devagent-cli' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('product_mismatch');
    expect(result.detail).toContain('devagent-cli');
    expect(result.detail).toContain('devagent-app');
  });

  it('v2 product match + version range OK → ok', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.5.0' });
    const result = checkProductCompatibility(
      validV2Payload({ product_version: '>=1.0.0 <2.0.0' }),
    );
    expect(result.ok).toBe(true);
  });

  it('v2 product match + version range fail → product_version_mismatch', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '2.0.0' });
    const result = checkProductCompatibility(
      validV2Payload({ product_version: '>=1.0.0 <2.0.0' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('product_version_mismatch');
    expect(result.detail).toContain('2.0.0');
    expect(result.detail).toContain('>=1.0.0 <2.0.0');
  });

  it('v2 prerelease host rejected by plain range (strict SemVer)', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0-alpha.6' });
    const result = checkProductCompatibility(
      validV2Payload({ product_version: '>=1.0.0 <2.0.0' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('product_version_mismatch');
  });

  it('v2 prerelease host admitted by prerelease-inclusive range', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0-alpha.6' });
    const result = checkProductCompatibility(
      validV2Payload({ product_version: '>=1.0.0-alpha.6 <1.0.1' }),
    );
    expect(result.ok).toBe(true);
  });

  it('malformed range → product_version_range_invalid', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    const result = checkProductCompatibility(
      validV2Payload({ product_version: 'garbage' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('product_version_range_invalid');
    expect(result.detail).toContain('garbage');
  });

  it('product match is case-sensitive', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    const result = checkProductCompatibility(
      validV2Payload({ product: 'DevAgent-CLI' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('product_mismatch');
  });

  it('accepts explicit identity argument (override default)', () => {
    // Even with no globally-registered identity, an explicit arg should work.
    const result = checkProductCompatibility(validV2Payload(), {
      product: 'devagent-cli',
      version: '1.0.0',
    });
    expect(result.ok).toBe(true);
  });

  it('explicit null identity forces skip regardless of global state', () => {
    setHostProductIdentity({ product: 'devagent-cli', version: '1.0.0' });
    const result = checkProductCompatibility(validV2Payload(), null);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });
});
