/**
 * Tests for license file persistence (store.ts).
 * Ported byte-equivalent from CortexDev-Agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TempDir } from './__test-fixtures__/temp-dir.js';
import {
  deleteLicense,
  getLicenseDir,
  readActivationMeta,
  readLicense,
  resolveConfigDir,
  writeActivationMeta,
  writeLicense,
} from './store.js';
import type { ActivationMeta, LicenseFile } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_LICENSE: LicenseFile = {
  payload: {
    version: 1,
    type: 'pro',
    license_id: '4f56ab7d-7d0b-44fd-9ea5-0834b78b628f',
    user: 'test-user',
    email: 'test@example.com',
    fingerprint: '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3',
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2027-01-01T00:00:00.000Z',
    features: [],
  },
  signature: 'base64sighere==',
};

const FIXTURE_META: ActivationMeta = {
  last_verified_at: '2026-05-10T00:00:00.000Z',
  fingerprint_at_activation: '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3',
  activated_at: '2026-05-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// resolveConfigDir()
// ---------------------------------------------------------------------------

describe('resolveConfigDir()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns CORTEXDEV_CONFIG_DIR when set', () => {
    vi.stubEnv('CORTEXDEV_CONFIG_DIR', '/custom/config');
    expect(resolveConfigDir()).toBe('/custom/config');
  });

  it('returns CORTEXDEV_PRO_CONFIG_DIR when CORTEXDEV_CONFIG_DIR is not set', () => {
    delete process.env.CORTEXDEV_CONFIG_DIR;
    vi.stubEnv('CORTEXDEV_PRO_CONFIG_DIR', '/pro/config');
    expect(resolveConfigDir()).toBe('/pro/config');
  });

  it('falls back to ~/.cortexdev-pro', () => {
    delete process.env.CORTEXDEV_CONFIG_DIR;
    delete process.env.CORTEXDEV_PRO_CONFIG_DIR;
    const result = resolveConfigDir();
    expect(result).toMatch(/\.cortexdev-pro$/);
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLicenseDir()
// ---------------------------------------------------------------------------

describe('getLicenseDir()', () => {
  let tmp: TempDir;

  beforeEach(() => {
    tmp = createTempDir('store-test-');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('creates the license subdirectory if it does not exist', () => {
    const licenseDir = getLicenseDir(tmp.path);
    expect(fs.existsSync(licenseDir)).toBe(true);
    expect(licenseDir).toBe(path.join(tmp.path, 'license'));
  });

  it('returns the existing license dir without error', () => {
    const firstCall = getLicenseDir(tmp.path);
    const secondCall = getLicenseDir(tmp.path);
    expect(firstCall).toBe(secondCall);
  });

  it('throws for empty string configDir', () => {
    expect(() => getLicenseDir('')).toThrow(/must be a non-empty string/i);
  });

  it('throws for relative path (non-absolute)', () => {
    expect(() => getLicenseDir('relative/path')).toThrow(/absolute/i);
  });
});

// ---------------------------------------------------------------------------
// readLicense() / writeLicense()
// ---------------------------------------------------------------------------

describe('readLicense() / writeLicense()', () => {
  let tmp: TempDir;

  beforeEach(() => {
    tmp = createTempDir('license-rw-test-');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('returns null when license.json does not exist', () => {
    expect(readLicense(tmp.path)).toBeNull();
  });

  it('writes and reads back a license file', () => {
    writeLicense(tmp.path, FIXTURE_LICENSE);
    const result = readLicense(tmp.path);
    expect(result).toEqual(FIXTURE_LICENSE);
  });

  it('creates the license directory automatically on write', () => {
    const licenseDir = path.join(tmp.path, 'license');
    expect(fs.existsSync(licenseDir)).toBe(false);

    writeLicense(tmp.path, FIXTURE_LICENSE);

    expect(fs.existsSync(licenseDir)).toBe(true);
    expect(fs.existsSync(path.join(licenseDir, 'license.json'))).toBe(true);
  });

  it('returns null for corrupt JSON', () => {
    const licenseDir = path.join(tmp.path, 'license');
    fs.mkdirSync(licenseDir, { recursive: true });
    fs.writeFileSync(path.join(licenseDir, 'license.json'), 'NOT JSON {{{');
    expect(readLicense(tmp.path)).toBeNull();
  });

  it('uses atomic write (tmp file then rename)', () => {
    writeLicense(tmp.path, FIXTURE_LICENSE);
    const licenseDir = path.join(tmp.path, 'license');
    const files = fs.readdirSync(licenseDir);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
    expect(files).toContain('license.json');
  });

  it('overwrites an existing license file', () => {
    writeLicense(tmp.path, FIXTURE_LICENSE);
    const updated = {
      ...FIXTURE_LICENSE,
      payload: { ...FIXTURE_LICENSE.payload, user: 'updated-user' },
    };
    writeLicense(tmp.path, updated);
    const result = readLicense(tmp.path);
    expect(result?.payload.user).toBe('updated-user');
  });
});

// ---------------------------------------------------------------------------
// deleteLicense()
// ---------------------------------------------------------------------------

describe('deleteLicense()', () => {
  let tmp: TempDir;

  beforeEach(() => {
    tmp = createTempDir('license-delete-test-');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('removes the license.json file', () => {
    writeLicense(tmp.path, FIXTURE_LICENSE);
    expect(readLicense(tmp.path)).not.toBeNull();

    deleteLicense(tmp.path);
    expect(readLicense(tmp.path)).toBeNull();
  });

  it('does nothing when license.json does not exist', () => {
    expect(() => deleteLicense(tmp.path)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readActivationMeta() / writeActivationMeta()
// ---------------------------------------------------------------------------

describe('readActivationMeta() / writeActivationMeta()', () => {
  let tmp: TempDir;

  beforeEach(() => {
    tmp = createTempDir('activation-meta-test-');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('returns null when activation.json does not exist', () => {
    expect(readActivationMeta(tmp.path)).toBeNull();
  });

  it('writes and reads back activation metadata', () => {
    writeActivationMeta(tmp.path, FIXTURE_META);
    const result = readActivationMeta(tmp.path);
    expect(result).toEqual(FIXTURE_META);
  });

  it('returns null for corrupt activation.json', () => {
    const licenseDir = path.join(tmp.path, 'license');
    fs.mkdirSync(licenseDir, { recursive: true });
    fs.writeFileSync(path.join(licenseDir, 'activation.json'), '{{invalid}}');
    expect(readActivationMeta(tmp.path)).toBeNull();
  });

  it('overwrites existing metadata', () => {
    writeActivationMeta(tmp.path, FIXTURE_META);
    const updated: ActivationMeta = {
      ...FIXTURE_META,
      last_verified_at: '2026-06-01T00:00:00.000Z',
    };
    writeActivationMeta(tmp.path, updated);
    expect(readActivationMeta(tmp.path)?.last_verified_at).toBe('2026-06-01T00:00:00.000Z');
  });
});
