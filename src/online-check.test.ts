/**
 * Tests for online-check.ts — D4 token verifier.
 *
 * Coverage map (the four discriminated-union verdicts plus structural inputs):
 *   - valid round-trip: well-formed token signed by the embedded token key
 *   - malformed: null / undefined / wrong type / missing payload / missing signature
 *   - id_mismatch: payload.license_id ≠ licenseId
 *   - expired: expires_at in the past or unparseable
 *   - invalid_signature: signature does not verify under embedded token key
 *
 * In-suite signing matches the server's wire format: ECDSA P-256 / SHA-256 over
 * `canonicalize(payload)` → base64 DER. We sign with `createSign('SHA256')`
 * which produces DER directly, so we can skip the P1363→DER conversion the
 * server uses for its WebCrypto output.
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalize } from './crypto.js';
import { verifyOnlineCheckToken } from './online-check.js';

const LICENSE_ID = '4f56ab7d-7d0b-44fd-9ea5-0834b78b628f';

function generateTestKeyPair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function signTokenPayload(payload: object, privateKeyPEM: string): string {
  const data = Buffer.from(JSON.stringify(canonicalize(payload)), 'utf8');
  const sig = createSign('SHA256').update(data).sign(privateKeyPEM);
  return sig.toString('base64');
}

function freshFuturePayload(): { license_id: string; server_time: string; expires_at: string } {
  const now = Date.now();
  return {
    license_id: LICENSE_ID,
    server_time: new Date(now).toISOString(),
    expires_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(), // +7 days
  };
}

describe('verifyOnlineCheckToken — valid path', () => {
  it('round-trips a fresh, well-signed token bound to the licenseId', () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const payload = freshFuturePayload();
    const signature = signTokenPayload(payload, privateKey);

    const verdict = verifyOnlineCheckToken({ payload, signature }, LICENSE_ID, publicKey);
    expect(verdict).toEqual({ valid: true });
  });
});

describe('verifyOnlineCheckToken — malformed (fall through to Path B)', () => {
  const { publicKey } = generateTestKeyPair();

  it('returns malformed for null', () => {
    expect(verifyOnlineCheckToken(null, LICENSE_ID, publicKey)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('returns malformed for undefined', () => {
    expect(verifyOnlineCheckToken(undefined, LICENSE_ID, publicKey)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('returns malformed for non-object (string)', () => {
    expect(verifyOnlineCheckToken('not-a-token', LICENSE_ID, publicKey)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('returns malformed for empty object', () => {
    expect(verifyOnlineCheckToken({}, LICENSE_ID, publicKey)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('returns malformed when payload is missing', () => {
    expect(verifyOnlineCheckToken({ signature: 'abc' }, LICENSE_ID, publicKey)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('returns malformed when signature is missing', () => {
    expect(
      verifyOnlineCheckToken({ payload: freshFuturePayload() }, LICENSE_ID, publicKey)
    ).toEqual({ valid: false, reason: 'malformed' });
  });

  it('returns malformed when signature is empty string', () => {
    expect(
      verifyOnlineCheckToken(
        { payload: freshFuturePayload(), signature: '' },
        LICENSE_ID,
        publicKey
      )
    ).toEqual({ valid: false, reason: 'malformed' });
  });

  it('returns malformed when payload.license_id is missing', () => {
    const { server_time, expires_at } = freshFuturePayload();
    expect(
      verifyOnlineCheckToken(
        { payload: { server_time, expires_at }, signature: 'abc' },
        LICENSE_ID,
        publicKey
      )
    ).toEqual({ valid: false, reason: 'malformed' });
  });

  it('returns malformed when payload.expires_at is missing', () => {
    expect(
      verifyOnlineCheckToken(
        { payload: { license_id: LICENSE_ID, server_time: 'x' }, signature: 'abc' },
        LICENSE_ID,
        publicKey
      )
    ).toEqual({ valid: false, reason: 'malformed' });
  });

  it('returns malformed when payload.license_id is wrong type (number)', () => {
    const { server_time, expires_at } = freshFuturePayload();
    expect(
      verifyOnlineCheckToken(
        { payload: { license_id: 123, server_time, expires_at }, signature: 'abc' },
        LICENSE_ID,
        publicKey
      )
    ).toEqual({ valid: false, reason: 'malformed' });
  });
});

describe('verifyOnlineCheckToken — id_mismatch (hard fail)', () => {
  it('rejects token whose payload.license_id differs from the caller licenseId', () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const payload = { ...freshFuturePayload(), license_id: 'OTHER-LICENSE-ID' };
    const signature = signTokenPayload(payload, privateKey);

    const verdict = verifyOnlineCheckToken({ payload, signature }, LICENSE_ID, publicKey);
    expect(verdict).toEqual({ valid: false, reason: 'id_mismatch' });
  });
});

describe('verifyOnlineCheckToken — expired (hard fail)', () => {
  it('rejects token whose expires_at is in the past', () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const past = new Date(Date.now() - 1000).toISOString();
    const payload = {
      license_id: LICENSE_ID,
      server_time: new Date(Date.now() - 10_000).toISOString(),
      expires_at: past,
    };
    const signature = signTokenPayload(payload, privateKey);

    const verdict = verifyOnlineCheckToken({ payload, signature }, LICENSE_ID, publicKey);
    expect(verdict).toEqual({ valid: false, reason: 'expired' });
  });

  it('treats unparseable expires_at as expired (defensive)', () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const payload = {
      license_id: LICENSE_ID,
      server_time: new Date().toISOString(),
      expires_at: 'not-a-date',
    };
    const signature = signTokenPayload(payload, privateKey);

    const verdict = verifyOnlineCheckToken({ payload, signature }, LICENSE_ID, publicKey);
    expect(verdict).toEqual({ valid: false, reason: 'expired' });
  });
});

describe('verifyOnlineCheckToken — invalid_signature (hard fail)', () => {
  it('rejects token signed by the wrong key', () => {
    const { publicKey } = generateTestKeyPair();
    const { privateKey: attackerPrivateKey } = generateTestKeyPair();
    const payload = freshFuturePayload();
    const signature = signTokenPayload(payload, attackerPrivateKey);

    const verdict = verifyOnlineCheckToken({ payload, signature }, LICENSE_ID, publicKey);
    expect(verdict).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('rejects token whose signature is garbled base64', () => {
    const { publicKey } = generateTestKeyPair();
    const payload = freshFuturePayload();
    const signature = 'AAAA' + 'BBBB'.repeat(16); // structurally valid base64 but no key matches

    const verdict = verifyOnlineCheckToken({ payload, signature }, LICENSE_ID, publicKey);
    expect(verdict).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('rejects token whose payload was mutated after signing (tamper)', () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const original = freshFuturePayload();
    const signature = signTokenPayload(original, privateKey);

    // Attacker extends expires_at by another 30 days but cannot re-sign without
    // the private key.
    const tampered = {
      ...original,
      expires_at: new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const verdict = verifyOnlineCheckToken({ payload: tampered, signature }, LICENSE_ID, publicKey);
    expect(verdict).toEqual({ valid: false, reason: 'invalid_signature' });
  });
});

describe('verifyOnlineCheckToken — verdict ordering (defence-in-depth)', () => {
  // CLI gate.js relies on the precise reason value to decide whether to fall
  // through to Path B. Reasons must not be conflated — e.g. an expired token
  // with a wrong license_id must surface as id_mismatch (the FIRST hard fail),
  // not "expired", so callers can log the right thing.

  const { publicKey, privateKey } = generateTestKeyPair();

  it('reports id_mismatch before expired', () => {
    const payload = {
      license_id: 'OTHER',
      server_time: new Date().toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    const signature = signTokenPayload(payload, privateKey);
    expect(verifyOnlineCheckToken({ payload, signature }, LICENSE_ID, publicKey)).toEqual({
      valid: false,
      reason: 'id_mismatch',
    });
  });

  it('reports expired before invalid_signature', () => {
    const { privateKey: attackerKey } = generateTestKeyPair();
    const payload = {
      license_id: LICENSE_ID,
      server_time: new Date().toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    const signature = signTokenPayload(payload, attackerKey);
    expect(verifyOnlineCheckToken({ payload, signature }, LICENSE_ID, publicKey)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('reports malformed before any cryptographic check', () => {
    // Structural failure short-circuits — id_mismatch / expired / invalid_signature
    // never have a chance to fire.
    expect(
      verifyOnlineCheckToken({ payload: null, signature: 'x' }, LICENSE_ID, publicKey)
    ).toEqual({ valid: false, reason: 'malformed' });
  });
});
