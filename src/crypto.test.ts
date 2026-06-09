/**
 * Tests for ECDSA license cryptography (crypto.ts).
 *
 * Ported byte-equivalent from CortexDev-Agents/src/main/core/license/crypto.test.ts.
 * The only structural change is the host-injection shim:
 *   - `vi.mock('electron', ...)` + `Object.defineProperty(app, 'isPackaged', ...)`
 *     → `setProductionBuildResolver(() => false | true)`.
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _internal,
  canonicalize,
  getPublicKey,
  setLegacyKeyHitListener,
  setLogger,
  setProductionBuildResolver,
  verifySignature,
} from './crypto.js';
import type { LicensePayload } from './types.js';

// ---------------------------------------------------------------------------
// Test-wide setup: default to dev mode (matches the original electron stub)
// ---------------------------------------------------------------------------

let packaged = false;
setProductionBuildResolver(() => packaged);

function setPackaged(value: boolean): void {
  packaged = value;
}

// ---------------------------------------------------------------------------
// Helpers: generate an in-test ECDSA P-256 key pair and sign a payload
// ---------------------------------------------------------------------------

function generateTestKeyPair() {
  return generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function signPayload(payload: LicensePayload, privateKeyPEM: string): string {
  const data = Buffer.from(JSON.stringify(canonicalize(payload)), 'utf8');
  const sig = createSign('SHA256').update(data).sign(privateKeyPEM);
  return sig.toString('base64');
}

// ---------------------------------------------------------------------------
// Fixture payload (matches the structure of a real CortexDev Pro license)
// ---------------------------------------------------------------------------

const FIXTURE_PAYLOAD: LicensePayload = {
  version: 1,
  type: 'pro',
  license_id: '4f56ab7d-7d0b-44fd-9ea5-0834b78b628f',
  user: 'moxiaoxi@dev.local',
  email: 'moxiaoxi@dev.local',
  fingerprint: '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3',
  issued_at: '2026-04-22T15:42:05.346Z',
  expires_at: '2026-05-22T15:42:05.346Z',
  features: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('canonicalize()', () => {
  it('returns primitives unchanged', () => {
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize('hello')).toBe('hello');
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(true)).toBe(true);
  });

  it('preserves array order', () => {
    const arr = [3, 1, 2];
    expect(canonicalize(arr)).toEqual([3, 1, 2]);
  });

  it('sorts object keys alphabetically', () => {
    const obj = { z: 1, a: 2, m: 3 };
    const result = canonicalize(obj) as Record<string, number>;
    expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
  });

  it('sorts nested object keys recursively', () => {
    const obj = { z: { b: 1, a: 2 }, a: { d: 3, c: 4 } };
    const result = canonicalize(obj) as Record<string, Record<string, number>>;
    expect(Object.keys(result)).toEqual(['a', 'z']);
    expect(Object.keys(result['a']!)).toEqual(['c', 'd']);
    expect(Object.keys(result['z']!)).toEqual(['a', 'b']);
  });

  it('produces stable JSON for signing determinism', () => {
    const a = {
      expires_at: '2026-05-22',
      features: [],
      fingerprint: 'abc',
      issued_at: '2026-04-22',
      version: 1,
    };
    const b = {
      version: 1,
      features: [],
      fingerprint: 'abc',
      issued_at: '2026-04-22',
      expires_at: '2026-05-22',
    };
    expect(JSON.stringify(canonicalize(a))).toBe(JSON.stringify(canonicalize(b)));
  });

  it('handles arrays of objects (preserves array order, sorts inner keys)', () => {
    const arr = [
      { b: 2, a: 1 },
      { d: 4, c: 3 },
    ];
    const result = canonicalize(arr) as Array<Record<string, number>>;
    expect(Object.keys(result[0]!)).toEqual(['a', 'b']);
    expect(Object.keys(result[1]!)).toEqual(['c', 'd']);
  });
});

describe('verifySignature()', () => {
  let publicKey: string;
  let privateKey: string;

  beforeEach(() => {
    ({ publicKey, privateKey } = generateTestKeyPair());
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', publicKey);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setPackaged(false);
  });

  it('returns true for a valid signature', () => {
    const signature = signPayload(FIXTURE_PAYLOAD, privateKey);
    expect(verifySignature(FIXTURE_PAYLOAD, signature, publicKey)).toBe(true);
  });

  it('returns false when payload has been tampered (user field changed)', () => {
    const signature = signPayload(FIXTURE_PAYLOAD, privateKey);
    const tamperedPayload = { ...FIXTURE_PAYLOAD, user: 'hacker' };
    expect(verifySignature(tamperedPayload, signature, publicKey)).toBe(false);
  });

  it('returns false when payload has been tampered (expires_at changed)', () => {
    const signature = signPayload(FIXTURE_PAYLOAD, privateKey);
    const tamperedPayload = { ...FIXTURE_PAYLOAD, expires_at: '2099-12-31T23:59:59.999Z' };
    expect(verifySignature(tamperedPayload, signature, publicKey)).toBe(false);
  });

  it('returns false when payload has been tampered (fingerprint changed)', () => {
    const signature = signPayload(FIXTURE_PAYLOAD, privateKey);
    const tamperedPayload = { ...FIXTURE_PAYLOAD, fingerprint: 'a'.repeat(64) };
    expect(verifySignature(tamperedPayload, signature, publicKey)).toBe(false);
  });

  it('returns false for invalid base64 signature', () => {
    expect(verifySignature(FIXTURE_PAYLOAD, 'not-valid-base64!!!', publicKey)).toBe(false);
  });

  it('returns false for empty signature string', () => {
    expect(verifySignature(FIXTURE_PAYLOAD, '', publicKey)).toBe(false);
  });

  it('returns false when public key is wrong (different key pair)', () => {
    const signature = signPayload(FIXTURE_PAYLOAD, privateKey);
    const { publicKey: otherPub } = generateTestKeyPair();
    expect(verifySignature(FIXTURE_PAYLOAD, signature, otherPub)).toBe(false);
  });

  it('returns false for invalid PEM public key', () => {
    const signature = signPayload(FIXTURE_PAYLOAD, privateKey);
    expect(verifySignature(FIXTURE_PAYLOAD, signature, 'NOT A PEM KEY')).toBe(false);
  });

  it('uses getPublicKey() as default when no key argument is provided', () => {
    const signature = signPayload(FIXTURE_PAYLOAD, privateKey);
    expect(verifySignature(FIXTURE_PAYLOAD, signature)).toBe(true);
  });

  it('is stable: same payload + signature always produces same result', () => {
    const signature = signPayload(FIXTURE_PAYLOAD, privateKey);
    for (let i = 0; i < 5; i++) {
      expect(verifySignature(FIXTURE_PAYLOAD, signature, publicKey)).toBe(true);
    }
  });

  it('verifies a license signed with the bundled dev keypair against the embedded public key', () => {
    vi.unstubAllEnvs();
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', '');

    const realSignature =
      'MEYCIQCyoiHRyiaXj517aEWv1jEKYVyRq9d0Ghy7QBLBxagS4wIhAI1ePIM5JqU3t9VJ+ge7/UofTpR5b8VIMbYnnEEuAn/f';
    const realPayload: LicensePayload = {
      version: 1,
      type: 'pro',
      license_id: 'dev-fixture-0001',
      user: 'dev@example.com',
      email: 'dev@example.com',
      fingerprint: '0'.repeat(64),
      issued_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
      features: [],
    };

    const embeddedKey = getPublicKey();
    expect(verifySignature(realPayload, realSignature, embeddedKey)).toBe(true);
  });
});

describe('getPublicKey()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setPackaged(false);
  });

  it('returns CORTEXDEV_PUBLIC_KEY when NODE_ENV=test and not packaged', () => {
    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', 'custom-key');
    expect(getPublicKey()).toBe('custom-key');
  });

  it('returns CORTEXDEV_PUBLIC_KEY when NODE_ENV=development and not packaged', () => {
    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', 'dev-key');
    expect(getPublicKey()).toBe('dev-key');
  });

  it('returns CORTEXDEV_PUBLIC_KEY when NODE_ENV is unset and not packaged', () => {
    setPackaged(false);
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', 'unset-env-key');
    delete process.env.NODE_ENV;

    expect(getPublicKey()).toBe('unset-env-key');
  });

  it('auto-discovers and normalizes the local CLI public key in development', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortexdev-crypto-key-'));
    const localKeyDir = path.join(tmpDir, 'license-keys');
    const localKeyPath = path.join(localKeyDir, 'public.pem');
    const pemWithCrLf = [
      '-----BEGIN PUBLIC KEY-----',
      'LOCAL-DEV-KEY',
      '-----END PUBLIC KEY-----',
      '',
    ].join('\r\n');
    fs.mkdirSync(localKeyDir, { recursive: true });
    fs.writeFileSync(localKeyPath, pemWithCrLf);

    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORTEXDEV_CONFIG_DIR', tmpDir);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    try {
      expect(getPublicKey()).toBe(pemWithCrLf.replace(/\r\n/g, '\n'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to the dev key when the local CLI public key has no PEM header', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortexdev-crypto-bad-key-'));
    const localKeyDir = path.join(tmpDir, 'license-keys');
    fs.mkdirSync(localKeyDir, { recursive: true });
    fs.writeFileSync(path.join(localKeyDir, 'public.pem'), 'not a pem file');

    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORTEXDEV_CONFIG_DIR', tmpDir);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    try {
      expect(getPublicKey()).toBe(_internal.DEV_KEY);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to the dev key when the local CLI public key cannot be read', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortexdev-crypto-dir-key-'));
    const localKeyPath = path.join(tmpDir, 'license-keys', 'public.pem');
    fs.mkdirSync(localKeyPath, { recursive: true });

    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORTEXDEV_CONFIG_DIR', tmpDir);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    try {
      expect(getPublicKey()).toBe(_internal.DEV_KEY);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('ignores CORTEXDEV_PUBLIC_KEY when NODE_ENV=production', () => {
    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', 'should-be-ignored');
    const key = getPublicKey();
    expect(key).toContain('BEGIN PUBLIC KEY');
    expect(key).not.toBe('should-be-ignored');
  });

  it('ignores CORTEXDEV_PUBLIC_KEY when packaged even if NODE_ENV=development', () => {
    setPackaged(true);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', 'attacker-key');
    const key = getPublicKey();
    expect(key).toContain('BEGIN PUBLIC KEY');
    expect(key).not.toBe('attacker-key');
  });

  it('ignores CORTEXDEV_PUBLIC_KEY when packaged even if NODE_ENV=test', () => {
    setPackaged(true);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', 'attacker-key');
    const key = getPublicKey();
    expect(key).toContain('BEGIN PUBLIC KEY');
    expect(key).not.toBe('attacker-key');
  });

  it('returns the bundled key when CORTEXDEV_PUBLIC_KEY is not set', () => {
    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.CORTEXDEV_PUBLIC_KEY;
    const key = getPublicKey();
    expect(key).toContain('BEGIN PUBLIC KEY');
    expect(key).toContain('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE');
  });
});

describe('verifySignature() — LEGACY key migration window', () => {
  const ef14LegacyPayload: LicensePayload = {
    version: 1,
    type: 'pro',
    license_id: '4f56ab7d-7d0b-44fd-9ea5-0834b78b628f',
    user: 'moxiaoxi@dev.local',
    email: 'moxiaoxi@dev.local',
    fingerprint: '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3',
    issued_at: '2026-04-22T15:42:05.346Z',
    expires_at: '2026-05-22T15:42:05.346Z',
    features: [],
  };
  const ef14LegacySignature =
    'MEUCIDOLYVos9Bp6Z6UGskoZrJ1QmZKF2ngneVf/Qp3OBTBeAiEAnO0dLgeRqbMELMSME6QB8gIulN0nA8xm2qQRaldA4GY=';

  afterEach(() => {
    vi.unstubAllEnvs();
    setPackaged(false);
    setLegacyKeyHitListener(null);
    vi.useRealTimers();
  });

  it('verifies a legacy-prod-key license in packaged builds via fallback', () => {
    setPackaged(true);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    expect(verifySignature(ef14LegacyPayload, ef14LegacySignature)).toBe(true);
  });

  it('cli-prepatch7-E40v key in LEGACY_KEYS is present, parseable, and used by the fallback loop', () => {
    const e40vEntry = _internal.LEGACY_KEYS.find((k) => k.label === 'cli-prepatch7-E40v');
    expect(e40vEntry).toBeDefined();

    const { publicKey: standInPublicKey, privateKey: standInPrivateKey } = generateTestKeyPair();
    const sig = signPayload(FIXTURE_PAYLOAD, standInPrivateKey);

    expect(() => verifySignature(FIXTURE_PAYLOAD, sig, e40vEntry!.key)).not.toThrow();
    expect(verifySignature(FIXTURE_PAYLOAD, sig, e40vEntry!.key)).toBe(false);

    expect(verifySignature(FIXTURE_PAYLOAD, sig, standInPublicKey)).toBe(true);
  });

  it('does NOT consult LEGACY_KEYS in dev builds', () => {
    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'test');
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    expect(verifySignature(ef14LegacyPayload, ef14LegacySignature)).toBe(false);
  });

  it('skips LEGACY fallback when caller passes an explicit publicKey', () => {
    setPackaged(true);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    expect(verifySignature(ef14LegacyPayload, ef14LegacySignature, _internal.PROD_KEY)).toBe(false);
  });

  it('fires legacyKeyHitListener with the matched legacy label', () => {
    setPackaged(true);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    const onHit = vi.fn();
    setLegacyKeyHitListener(onHit);

    expect(verifySignature(ef14LegacyPayload, ef14LegacySignature)).toBe(true);
    expect(onHit).toHaveBeenCalledTimes(1);
    expect(onHit).toHaveBeenCalledWith('gui-original-EF14');
  });

  it('does NOT fire legacyKeyHitListener for primary-key matches', () => {
    setPackaged(true);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    const onHit = vi.fn();
    setLegacyKeyHitListener(onHit);
    const { publicKey, privateKey } = generateTestKeyPair();
    const sig = signPayload({ user: 'primary' } as LicensePayload, privateKey);
    expect(verifySignature({ user: 'primary' } as LicensePayload, sig, publicKey)).toBe(true);
    expect(onHit).not.toHaveBeenCalled();
  });

  it('returns false in packaged builds when within sunset window but no LEGACY key matches', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));

    setPackaged(true);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    const { publicKey: foreignPub, privateKey: foreignPriv } = generateTestKeyPair();
    void foreignPub;
    const foreignSig = signPayload(FIXTURE_PAYLOAD, foreignPriv);

    expect(verifySignature(FIXTURE_PAYLOAD, foreignSig)).toBe(false);
  });

  it('stops honouring LEGACY_KEYS after LEGACY_KEY_SUNSET', () => {
    setPackaged(true);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    const sunsetMs = Date.parse('2026-11-15T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(sunsetMs + 24 * 60 * 60 * 1000));

    expect(verifySignature(ef14LegacyPayload, ef14LegacySignature)).toBe(false);
  });
});

describe('getPublicKey() — local PEM auto-discovery (dev mode)', () => {
  let tmpRoot: string;
  let licenseKeysDir: string;
  let localKeyPath: string;

  beforeEach(() => {
    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', '');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-localkey-'));
    licenseKeysDir = path.join(tmpRoot, 'license-keys');
    fs.mkdirSync(licenseKeysDir, { recursive: true });
    localKeyPath = path.join(licenseKeysDir, 'public.pem');
    vi.stubEnv('CORTEXDEV_CONFIG_DIR', tmpRoot);
    vi.stubEnv('CORTEXDEV_PRO_CONFIG_DIR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setPackaged(false);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the local PEM when a valid public.pem is present under CORTEXDEV_CONFIG_DIR', () => {
    const localPem = `-----BEGIN PUBLIC KEY-----
LOCALKEYBYTESFORTESTFIXTUREONLY=
-----END PUBLIC KEY-----`;
    fs.writeFileSync(localKeyPath, localPem, 'utf8');

    expect(getPublicKey()).toBe(localPem);
  });

  it('normalises CRLF / CR line endings in the local PEM', () => {
    const crlfPem = '-----BEGIN PUBLIC KEY-----\r\nLOCALKEYBYTES==\r\n-----END PUBLIC KEY-----';
    fs.writeFileSync(localKeyPath, crlfPem, 'utf8');

    const result = getPublicKey();
    expect(result).not.toContain('\r');
    expect(result.split('\n')[0]).toBe('-----BEGIN PUBLIC KEY-----');
  });

  it('falls back to DEV_KEY when the local file exists but lacks a PEM header', () => {
    fs.writeFileSync(localKeyPath, 'not a pem at all', 'utf8');

    expect(getPublicKey()).toBe(_internal.DEV_KEY);
  });

  it('falls back to DEV_KEY when readFileSync on the local file throws', () => {
    fs.writeFileSync(localKeyPath, 'placeholder', 'utf8');
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, opts) => {
      if (typeof p === 'string' && p === localKeyPath) {
        throw new Error('EACCES: simulated');
      }
      return realRead(p, opts as never);
    });

    expect(getPublicKey()).toBe(_internal.DEV_KEY);
  });

  it('honours CORTEXDEV_PUBLIC_KEY env override ahead of the local file', () => {
    fs.writeFileSync(
      localKeyPath,
      '-----BEGIN PUBLIC KEY-----\nLOCAL==\n-----END PUBLIC KEY-----',
      'utf8'
    );
    vi.stubEnv('CORTEXDEV_PUBLIC_KEY', 'inline-override-key');

    expect(getPublicKey()).toBe('inline-override-key');
  });

  it('falls back to CORTEXDEV_PRO_CONFIG_DIR when CORTEXDEV_CONFIG_DIR is not set', () => {
    delete process.env.CORTEXDEV_CONFIG_DIR;
    vi.stubEnv('CORTEXDEV_PRO_CONFIG_DIR', tmpRoot);
    const localPem = '-----BEGIN PUBLIC KEY-----\nPROCONFIG==\n-----END PUBLIC KEY-----';
    fs.writeFileSync(localKeyPath, localPem, 'utf8');

    expect(getPublicKey()).toBe(localPem);
  });

  it('returns DEV_KEY when neither env var nor local file is present', () => {
    fs.rmSync(licenseKeysDir, { recursive: true, force: true });

    expect(getPublicKey()).toBe(_internal.DEV_KEY);
  });
});

describe('setLogger() / setProductionBuildResolver()', () => {
  // Lightweight smoke tests so the injection seams stay covered as the
  // module evolves. They also document the wiring story for new consumers.

  afterEach(() => {
    setPackaged(false);
  });

  it('debug logger is invoked on missing PEM header and readFileSync failure', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-logger-'));
    const licenseKeysDir = path.join(tmpRoot, 'license-keys');
    const localKeyPath = path.join(licenseKeysDir, 'public.pem');
    fs.mkdirSync(licenseKeysDir, { recursive: true });
    fs.writeFileSync(localKeyPath, 'no header at all', 'utf8');

    const debug = vi.fn();
    setLogger({ debug });

    setPackaged(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORTEXDEV_CONFIG_DIR', tmpRoot);
    delete process.env.CORTEXDEV_PUBLIC_KEY;

    try {
      expect(getPublicKey()).toBe(_internal.DEV_KEY);
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('local key file found but contains no PEM header'),
        expect.objectContaining({ localKeyPath })
      );
    } finally {
      vi.unstubAllEnvs();
      setLogger({ debug: () => undefined });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('production resolver flip switches verifySignature() into legacy-fallback mode', () => {
    delete process.env.CORTEXDEV_PUBLIC_KEY;
    setPackaged(false);
    // EF14-signed fixture from the LEGACY_KEYS test suite.
    const payload: LicensePayload = {
      version: 1,
      type: 'pro',
      license_id: '4f56ab7d-7d0b-44fd-9ea5-0834b78b628f',
      user: 'moxiaoxi@dev.local',
      email: 'moxiaoxi@dev.local',
      fingerprint: '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3',
      issued_at: '2026-04-22T15:42:05.346Z',
      expires_at: '2026-05-22T15:42:05.346Z',
      features: [],
    };
    const sig =
      'MEUCIDOLYVos9Bp6Z6UGskoZrJ1QmZKF2ngneVf/Qp3OBTBeAiEAnO0dLgeRqbMELMSME6QB8gIulN0nA8xm2qQRaldA4GY=';

    // Dev mode: no legacy fallback, must fail.
    vi.stubEnv('NODE_ENV', 'test');
    expect(verifySignature(payload, sig)).toBe(false);

    // Packaged mode: legacy fallback succeeds.
    setPackaged(true);
    expect(verifySignature(payload, sig)).toBe(true);

    vi.unstubAllEnvs();
  });
});
