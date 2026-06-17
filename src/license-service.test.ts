/**
 * LicenseService unit tests.
 * Ported from CortexDev-Agents.
 *
 * Differences vs the original:
 *   - `vi.mock('electron', ...)`                  → `setHostEnvironment()`
 *   - `vi.mock('@main/lib/logger', ...)`         → `setServiceLogger()`
 *   - `vi.mock('../cortexdev-pro/binary-downloader', ...)` → `setBinaryDownloadHooks()`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivationMeta, LicenseFile, LicensePayload } from './types.js';

vi.mock('./store.js', () => ({
  resolveConfigDir: vi.fn(() => '/fake/configDir'),
  readLicense: vi.fn(),
  writeLicense: vi.fn(),
  deleteLicense: vi.fn(),
  readActivationMeta: vi.fn(),
  writeActivationMeta: vi.fn(),
}));

vi.mock('./fingerprint.js', () => ({
  collectFingerprint: vi.fn(),
}));

vi.mock('./online-client.js', () => ({
  onlineActivate: vi.fn(),
  onlineRefresh: vi.fn(),
}));

vi.mock('./validator.js', () => ({
  validateLicense: vi.fn(),
}));

vi.mock('./crypto.js', () => ({
  LEGACY_KEY_SUNSET: '2030-01-01',
  setLegacyKeyHitListener: vi.fn(),
  // token-key.ts (transitively imported through license-service → token-key)
  // calls isProductionBuild() at module load. The crypto mock must surface
  // the same symbol; default to false (dev mode) so token-key's load path
  // returns DEV_TOKEN_KEY without hitting any prod-only collision guards.
  isProductionBuild: vi.fn(() => false),
  // verifySignature is reached when checkOfflineGrace's Path A verifies a
  // signed token. Tests that exercise Path A wire their own assertions on
  // top of this mock.
  verifySignature: vi.fn(() => true),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('./online-check-store.js', () => ({
  readOnlineCheck: vi.fn(),
  writeOnlineCheck: vi.fn(),
}));

vi.mock('./online-check.js', () => ({
  verifyOnlineCheckToken: vi.fn(),
}));

vi.mock('./token-key.js', () => ({
  EMBEDDED_TOKEN_PUBLIC_KEY: 'TEST-EMBEDDED-TOKEN-KEY',
  DEV_TOKEN_KEY: 'TEST-DEV-TOKEN-KEY',
  PROD_TOKEN_KEY: 'TEST-PROD-TOKEN-KEY',
  publicKeysEqual: vi.fn(() => false),
}));

const storeMock = await import('./store.js');
const fingerprintMock = await import('./fingerprint.js');
const onlineMock = await import('./online-client.js');
const validatorMock = await import('./validator.js');
const fsMock = await import('node:fs');
const onlineCheckStoreMock = await import('./online-check-store.js');
const onlineCheckMock = await import('./online-check.js');
const { LicenseService, setHostEnvironment, setServiceLogger, setBinaryDownloadHooks } =
  await import('./license-service.js');

// ---------------------------------------------------------------------------
// Host-environment / logger / downloader hooks (host-side injection)
// ---------------------------------------------------------------------------

const downloadProMock = vi.fn();
const cleanupStaleTmpMock = vi.fn();
const logMock = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Module-level setter so tests can flip isPackaged before constructing the service.
let isPackagedValue = false;
function setPackaged(v: boolean): void {
  isPackagedValue = v;
}
setHostEnvironment({
  isPackaged: () => isPackagedValue,
  getUserDataDir: () => '/fake/userData',
});
setServiceLogger(logMock);
setBinaryDownloadHooks({
  downloadPro: downloadProMock as unknown as (args: {
    onProgress: (event: unknown) => void;
  }) => Promise<{ success: true } | { success: false; error: unknown }>,
  cleanupStaleTmp: cleanupStaleTmpMock,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    version: 1,
    type: 'pro',
    license_id: 'lic-123',
    user: 'Alice',
    email: 'alice@example.com',
    fingerprint: 'fp-aaaa',
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2030-01-01T00:00:00Z',
    features: ['pro'],
    ...over,
  };
}

function makeLicenseFile(over: Partial<LicensePayload> = {}): LicenseFile {
  return { payload: makePayload(over), signature: 'sig-base64' };
}

function makeActivationMeta(over: Partial<ActivationMeta> = {}): ActivationMeta {
  return {
    last_verified_at: new Date().toISOString(),
    activated_at: new Date().toISOString(),
    activation_id: 'act-uuid-1',
    ...over,
  };
}

function setValidatorOk(payload = makePayload()): void {
  vi.mocked(validatorMock.validateLicense).mockReturnValue({ valid: true, license: payload });
}

function setValidatorErr(reason: string, errors: string[] = ['bad']): void {
  vi.mocked(validatorMock.validateLicense).mockReturnValue({
    valid: false,
    reason: reason as 'expired',
    errors,
  });
}

function setValidatorExpired(payload = makePayload()): void {
  vi.mocked(validatorMock.validateLicense).mockReturnValue({
    valid: false,
    reason: 'expired',
    license: payload,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LicenseService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setPackaged(false);
    // Re-wire host injection because vi.resetAllMocks() did NOT clear those —
    // they are persistent module-level slots, not vi.fn() mocks. The
    // downloadProMock / cleanupStaleTmpMock / logMock are still installed.
    vi.mocked(storeMock.resolveConfigDir).mockReturnValue('/fake/configDir');
    vi.mocked(storeMock.readLicense).mockReturnValue(null);
    vi.mocked(storeMock.readActivationMeta).mockReturnValue(null);
    vi.mocked(fingerprintMock.collectFingerprint).mockResolvedValue('fp-aaaa');
    vi.mocked(onlineMock.onlineActivate).mockResolvedValue({
      success: true,
      data: {
        status: 'activated',
        server_time: '2026-05-21T00:00:00Z',
        activation_id: 'act-uuid-1',
      },
    });
    vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
      success: true,
      data: { revoked: false, server_time: '2026-05-21T00:00:00Z', license: null },
    });
    downloadProMock.mockResolvedValue({ success: true });
    setValidatorOk();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // initialize()
  // -------------------------------------------------------------------------

  describe('initialize()', () => {
    it('reports unlicensed when no license file on disk', async () => {
      const svc = new LicenseService();
      await svc.initialize();
      expect(svc.getStatus()).toEqual({ state: 'unlicensed' });
    });

    it('reports revoked when activation_meta already flagged server revocation', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(
        makeActivationMeta({
          server_status: {
            revoked: true,
            server_time: '2026-05-01T00:00:00Z',
            checked_at: '2026-05-01T00:00:00Z',
          },
        })
      );

      const svc = new LicenseService();
      await svc.initialize();
      expect(svc.getStatus()).toMatchObject({ state: 'revoked' });
    });

    it('continues with null fingerprint when collectFingerprint throws', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(fingerprintMock.collectFingerprint).mockRejectedValue(new Error('hw read failed'));

      const svc = new LicenseService();
      svc.dispose();
      await svc.initialize();

      expect(svc.getStatus().state).toBe('active');
      expect(validatorMock.validateLicense).toHaveBeenCalledWith(expect.anything(), null, {
        lastVerifiedAt: undefined,
      });
      svc.dispose();
    });

    it('maps validator expired result to expired status', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      setValidatorExpired(makePayload());

      const svc = new LicenseService();
      await svc.initialize();

      expect(svc.getStatus()).toMatchObject({ state: 'expired', reason: 'license_expired' });
    });

    it('maps validator generic failure to error status with reason', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      setValidatorErr('invalid_signature', ['sig mismatch']);

      const svc = new LicenseService();
      await svc.initialize();

      expect(svc.getStatus()).toMatchObject({
        state: 'error',
        reason: 'invalid_signature',
        details: 'sig mismatch',
      });
    });

    it('falls back to error/file_corrupt when an unexpected throw happens', async () => {
      vi.mocked(storeMock.readLicense).mockImplementation(() => {
        throw new Error('disk on fire');
      });

      const svc = new LicenseService();
      await svc.initialize();

      expect(svc.getStatus()).toMatchObject({ state: 'error', reason: 'file_corrupt' });
    });

    it('applies offline grace: warning when within last 3 days of 14-day window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-21T00:00:00Z'));

      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      const oldVerifiedAt = new Date('2026-05-09T00:00:00Z').toISOString();
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(
        makeActivationMeta({ last_verified_at: oldVerifiedAt })
      );
      vi.mocked(onlineMock.onlineRefresh).mockReturnValue(new Promise(() => undefined));

      const svc = new LicenseService();
      await svc.initialize();
      svc.dispose();

      const status = svc.getStatus();
      expect(status.state).toBe('active');
      if (status.state === 'active') {
        expect(status.offlineWarningDaysLeft).toBe(2);
      }
    });

    it('applies offline grace: expired when last_verified_at older than 14 days', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      const tooOld = new Date(Date.now() - 20 * 86_400_000).toISOString();
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(
        makeActivationMeta({ last_verified_at: tooOld })
      );

      const svc = new LicenseService();
      await svc.initialize();

      expect(svc.getStatus()).toMatchObject({
        state: 'expired',
        reason: 'offline_grace_exceeded',
      });
    });
  });

  // -------------------------------------------------------------------------
  // activate()
  // -------------------------------------------------------------------------

  describe('activate()', () => {
    it('returns invalid_structure when JSON parse fails', async () => {
      const svc = new LicenseService();
      const result = await svc.activate('{ not json');

      expect(result).toMatchObject({
        success: false,
        error: 'invalid_structure',
        details: 'JSON parse failed',
      });
      expect(svc.getStatus()).toMatchObject({ state: 'error', reason: 'invalid_structure' });
    });

    it('returns device_limit_exceeded when server rejects with that error', async () => {
      vi.mocked(onlineMock.onlineActivate).mockResolvedValue({
        success: false,
        error: { type: 'device_limit_exceeded' },
      });

      const svc = new LicenseService();
      const result = await svc.activate(JSON.stringify(makeLicenseFile()));

      expect(result).toMatchObject({ success: false, error: 'device_limit_exceeded' });
      expect(storeMock.writeLicense).not.toHaveBeenCalled();
    });

    it('returns server_revoked when server rejects with license_revoked', async () => {
      vi.mocked(onlineMock.onlineActivate).mockResolvedValue({
        success: false,
        error: { type: 'license_revoked' },
      });

      const svc = new LicenseService();
      const result = await svc.activate(JSON.stringify(makeLicenseFile()));

      expect(result).toMatchObject({ success: false, error: 'server_revoked' });
      expect(storeMock.writeLicense).not.toHaveBeenCalled();
    });

    it('proceeds offline (writes license) on transient online network failure', async () => {
      vi.mocked(onlineMock.onlineActivate).mockResolvedValue({
        success: false,
        error: { type: 'network_error', message: 'ETIMEDOUT' },
      });

      const svc = new LicenseService();
      const result = await svc.activate(JSON.stringify(makeLicenseFile()));
      svc.dispose();

      expect(result).toMatchObject({ success: true, serverSynced: false });
      expect(storeMock.writeLicense).toHaveBeenCalledOnce();
      expect(storeMock.writeActivationMeta).toHaveBeenCalledOnce();
    });

    it('serverSynced=true and persists license when online activate succeeds', async () => {
      const svc = new LicenseService();
      const result = await svc.activate(JSON.stringify(makeLicenseFile()));
      svc.dispose();

      expect(result).toMatchObject({ success: true, serverSynced: true });
      expect(svc.getStatus().state).toBe('active');
      expect(storeMock.writeLicense).toHaveBeenCalledOnce();
    });

    it('persists license but reports failure when validator says expired', async () => {
      setValidatorExpired(makePayload());

      const svc = new LicenseService();
      const result = await svc.activate(JSON.stringify(makeLicenseFile()));

      expect(result).toMatchObject({ success: false, error: 'expired' });
      expect(svc.getStatus().state).toBe('expired');
      expect(storeMock.writeLicense).toHaveBeenCalledOnce();
    });

    it('reuses existing activation_id from meta instead of generating a new one', async () => {
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(
        makeActivationMeta({ activation_id: 'preexisting-uuid' })
      );

      const svc = new LicenseService();
      await svc.activate(JSON.stringify(makeLicenseFile()));
      svc.dispose();

      expect(onlineMock.onlineActivate).toHaveBeenCalledWith(
        expect.objectContaining({ activation_id: 'preexisting-uuid' })
      );
    });

    it('skips online activate entirely when fingerprint is null', async () => {
      vi.mocked(fingerprintMock.collectFingerprint).mockRejectedValue(new Error('no hw'));

      const svc = new LicenseService();
      await svc.activate(JSON.stringify(makeLicenseFile()));
      svc.dispose();

      expect(onlineMock.onlineActivate).not.toHaveBeenCalled();
      expect(storeMock.writeLicense).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // activateFromFile()
  // -------------------------------------------------------------------------

  describe('activateFromFile()', () => {
    it('returns file_corrupt when readFileSync throws', async () => {
      vi.mocked(fsMock.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const svc = new LicenseService();
      const result = await svc.activateFromFile('/path/to/missing.json');

      expect(result).toMatchObject({ success: false, error: 'file_corrupt' });
      expect(String(result.details)).toContain('ENOENT');
    });

    it('delegates to activate() when readFileSync succeeds', async () => {
      vi.mocked(fsMock.readFileSync).mockReturnValue(JSON.stringify(makeLicenseFile()) as never);

      const svc = new LicenseService();
      const result = await svc.activateFromFile('/path/to/license.json');
      svc.dispose();

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // deactivate()
  // -------------------------------------------------------------------------

  describe('deactivate()', () => {
    it('removes the file, resets to unlicensed, and emits change', async () => {
      const cb = vi.fn();
      const svc = new LicenseService();
      svc.setStatusChangeListener(cb);

      await svc.deactivate();

      expect(storeMock.deleteLicense).toHaveBeenCalledOnce();
      expect(svc.getStatus()).toEqual({ state: 'unlicensed' });
      expect(cb).toHaveBeenCalledWith({ state: 'unlicensed' });
    });

    it('swallows deleteLicense errors and still resets status', async () => {
      vi.mocked(storeMock.deleteLicense).mockImplementation(() => {
        throw new Error('locked');
      });

      const svc = new LicenseService();
      await svc.deactivate();
      expect(svc.getStatus()).toEqual({ state: 'unlicensed' });
    });
  });

  // -------------------------------------------------------------------------
  // doRefreshNow / _doRefresh
  // -------------------------------------------------------------------------

  describe('doRefreshNow()', () => {
    it('keeps the refresh loop alive (no online call) when activation_id is missing', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
        vi.mocked(storeMock.readActivationMeta).mockReturnValue({
          last_verified_at: '2026-01-01T00:00:00Z',
        });

        const svc = new LicenseService();
        const status = await svc.doRefreshNow();

        expect(onlineMock.onlineRefresh).not.toHaveBeenCalled();
        expect(status.status.state).toBe('unlicensed');
        expect(status.reachedServer).toBe(false);
        expect(status.outcome).toEqual({ kind: 'network_error' });
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        svc.dispose();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('marks status as serverRevoked when refresh reports revocation', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(makeActivationMeta());
      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: true,
        data: {
          revoked: true,
          server_time: '2026-05-21T00:00:00Z',
          reason: 'admin_revocation',
          license: null,
        },
      });

      const cb = vi.fn();
      const svc = new LicenseService();
      await svc.activate(JSON.stringify(makeLicenseFile()));
      svc.setStatusChangeListener(cb);

      await svc.doRefreshNow();
      svc.dispose();

      const finalStatus = svc.getStatus();
      expect(finalStatus.state).toBe('active');
      if (finalStatus.state === 'active') {
        expect(finalStatus.serverRevoked).toBe(true);
      }
      expect(storeMock.writeActivationMeta).toHaveBeenCalledWith(
        '/fake/configDir',
        expect.objectContaining({
          server_status: expect.objectContaining({
            revoked: true,
            reason: 'admin_revocation',
          }) as unknown,
        })
      );
    });

    it('reports server_rejected (not network) when the server returns not_found', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(makeActivationMeta());
      vi.mocked(onlineMock.onlineRefresh).mockReturnValue(new Promise(() => undefined));

      const svc = new LicenseService();
      await svc.initialize();
      expect(svc.getStatus().state).toBe('active');

      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: false,
        error: { type: 'not_found' },
      });

      const refreshed = await svc.doRefreshNow();
      svc.dispose();

      expect(refreshed.reachedServer).toBe(true);
      expect(refreshed.outcome).toEqual({ kind: 'server_rejected', reason: 'not_found' });
    });

    it('treats api_error as an availability failure (offline grace), not a rejection', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(makeActivationMeta());
      vi.mocked(onlineMock.onlineRefresh).mockReturnValue(new Promise(() => undefined));

      const svc = new LicenseService();
      await svc.initialize();
      expect(svc.getStatus().state).toBe('active');

      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: false,
        error: { type: 'api_error', status: 503, code: 'SERVER_ERROR', message: 'down' },
      });

      const refreshed = await svc.doRefreshNow();
      svc.dispose();

      expect(refreshed.reachedServer).toBe(false);
      expect(refreshed.outcome).toEqual({ kind: 'network_error' });
      expect(svc.getStatus().state).toBe('active');
    });

    it('persists revoked server_status on HTTP 403 license_revoked so the next launch blocks', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(makeActivationMeta());
      vi.mocked(onlineMock.onlineRefresh).mockReturnValue(new Promise(() => undefined));

      const svc = new LicenseService();
      await svc.initialize();
      expect(svc.getStatus().state).toBe('active');
      vi.mocked(storeMock.writeActivationMeta).mockClear();

      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: false,
        error: { type: 'license_revoked' },
      });

      const refreshed = await svc.doRefreshNow();
      svc.dispose();

      expect(refreshed.reachedServer).toBe(true);
      expect(refreshed.outcome).toEqual({ kind: 'server_rejected', reason: 'revoked' });
      expect(storeMock.writeActivationMeta).toHaveBeenCalledWith(
        '/fake/configDir',
        expect.objectContaining({
          server_status: expect.objectContaining({
            revoked: true,
            reason: 'license_revoked',
          }) as unknown,
        })
      );
    });

    it('reports server_rejected with reason "revoked" when refresh returns revoked', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(makeActivationMeta());
      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: true,
        data: {
          revoked: true,
          server_time: '2026-05-21T00:00:00Z',
          reason: 'admin_revocation',
          license: null,
        },
      });

      const svc = new LicenseService();
      await svc.activate(JSON.stringify(makeLicenseFile()));

      const refreshed = await svc.doRefreshNow();
      svc.dispose();

      expect(refreshed.reachedServer).toBe(true);
      expect(refreshed.outcome).toEqual({ kind: 'server_rejected', reason: 'revoked' });
    });

    it('returns the fully restored active status when reconnecting after grace exceeded', async () => {
      const tooOld = new Date(Date.now() - 20 * 86_400_000).toISOString();
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(
        makeActivationMeta({ last_verified_at: tooOld })
      );
      vi.mocked(onlineMock.onlineRefresh).mockReturnValue(new Promise(() => undefined));

      const svc = new LicenseService();
      await svc.initialize();
      expect(svc.getStatus()).toMatchObject({ state: 'expired', reason: 'offline_grace_exceeded' });

      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: true,
        data: {
          revoked: false,
          server_time: '2026-06-07T00:00:00Z',
          reason: null,
          license: null,
        },
      });

      const refreshed = await svc.doRefreshNow();
      svc.dispose();

      expect(refreshed.outcome).toEqual({ kind: 'ok' });
      expect(refreshed.reachedServer).toBe(true);
      expect(refreshed.status.state).toBe('active');
      expect(svc.getStatus().state).toBe('active');
    });
  });

  // -------------------------------------------------------------------------
  // _handleOfflineGrace (via _doRefresh network failure)
  // -------------------------------------------------------------------------

  describe('_handleOfflineGrace via network failure', () => {
    it('keeps active status within grace period when refresh returns network error', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(makeActivationMeta());
      vi.mocked(onlineMock.onlineRefresh).mockReturnValue(new Promise(() => undefined));

      const svc = new LicenseService();
      await svc.initialize();
      expect(svc.getStatus().state).toBe('active');

      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: false,
        error: { type: 'network_error', message: 'ETIMEDOUT' },
      });

      const refreshed = await svc.doRefreshNow();
      svc.dispose();

      expect(svc.getStatus().state).toBe('active');
      expect(refreshed.reachedServer).toBe(false);
      expect(refreshed.outcome).toEqual({ kind: 'network_error' });
    });

    it('transitions to expired when refresh fails and offline grace is exceeded', async () => {
      const tooOld = new Date(Date.now() - 20 * 86_400_000).toISOString();
      vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(
        makeActivationMeta({ last_verified_at: tooOld })
      );
      vi.mocked(onlineMock.onlineRefresh).mockReturnValue(new Promise(() => undefined));

      const svc = new LicenseService();
      await svc.initialize();
      expect(svc.getStatus()).toMatchObject({ state: 'expired', reason: 'offline_grace_exceeded' });

      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: false,
        error: { type: 'network_error', message: 'connection refused' },
      });

      await svc.doRefreshNow();
      svc.dispose();

      expect(svc.getStatus()).toMatchObject({ state: 'expired', reason: 'offline_grace_exceeded' });
    });
  });

  // -------------------------------------------------------------------------
  // Miscellaneous
  // -------------------------------------------------------------------------

  describe('miscellaneous', () => {
    it('dispose() is idempotent and safe to call without a pending timer', () => {
      const svc = new LicenseService();
      expect(() => svc.dispose()).not.toThrow();
      expect(() => svc.dispose()).not.toThrow();
    });

    it('does not propagate listener throws to deactivate()', async () => {
      const svc = new LicenseService();
      svc.setStatusChangeListener(() => {
        throw new Error('listener crashed');
      });
      await expect(svc.deactivate()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // initialize() — cleanupStaleTmp via binary-download hook
  // -------------------------------------------------------------------------

  describe('initialize() — cleanupStaleTmp', () => {
    it('calls cleanupStaleTmp with the userData path on startup', async () => {
      const svc = new LicenseService();
      await svc.initialize();

      expect(cleanupStaleTmpMock).toHaveBeenCalledWith('/fake/userData');
    });

    it('calls cleanupStaleTmp even when license file is absent', async () => {
      vi.mocked(storeMock.readLicense).mockReturnValue(null);

      const svc = new LicenseService();
      await svc.initialize();

      expect(cleanupStaleTmpMock).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // activate() — auto-download on pro activation
  // -------------------------------------------------------------------------

  describe('activate() — auto-download', () => {
    it('triggers downloadPro when activation type is pro', async () => {
      downloadProMock.mockResolvedValue({ success: true });

      const svc = new LicenseService();
      await svc.activate(JSON.stringify(makeLicenseFile({ type: 'pro' })));
      svc.dispose();

      await Promise.resolve();
      expect(downloadProMock).toHaveBeenCalledOnce();
    });

    it('does not trigger downloadPro when activation type is free', async () => {
      const svc = new LicenseService();
      await svc.activate(
        JSON.stringify(makeLicenseFile({ type: 'free', fingerprint: null, expires_at: null }))
      );
      svc.dispose();

      await Promise.resolve();
      expect(downloadProMock).not.toHaveBeenCalled();
    });

    it('logs a warning but does not throw when auto-download fails', async () => {
      downloadProMock.mockResolvedValue({
        success: false,
        error: { type: 'platform_unsupported' },
      });

      const svc = new LicenseService();
      await svc.activate(JSON.stringify(makeLicenseFile({ type: 'pro' })));
      svc.dispose();

      await Promise.resolve();
      await Promise.resolve();
      expect(logMock.warn).toHaveBeenCalledWith(
        '[license] Pro auto-download failed',
        expect.objectContaining({ error: expect.any(String) as unknown })
      );
    });
  });

  // -------------------------------------------------------------------------
  // setDownloadProgressListener() / emitDownloadProgress()
  // -------------------------------------------------------------------------

  describe('setDownloadProgressListener() / emitDownloadProgress()', () => {
    it('forwards progress events to the registered listener', () => {
      const svc = new LicenseService();
      const cb = vi.fn();
      svc.setDownloadProgressListener(cb);

      const event = { state: 'downloading' as const, bytes: 100, total: 1000, percent: 10 };
      svc.emitDownloadProgress(event);
      svc.dispose();

      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(event);
    });

    it('does not throw when no listener is registered', () => {
      const svc = new LicenseService();
      expect(() => svc.emitDownloadProgress({ state: 'verifying' })).not.toThrow();
      svc.dispose();
    });

    it('catches and logs if the listener throws', () => {
      const svc = new LicenseService();
      svc.setDownloadProgressListener(() => {
        throw new Error('listener boom');
      });

      svc.emitDownloadProgress({ state: 'done', path: '/bin/cortexdev-pro' });
      svc.dispose();

      expect(logMock.warn).toHaveBeenCalledWith(
        'LicenseService: download progress listener threw',
        expect.objectContaining({ error: 'Error: listener boom' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Packaged build guard
  // -------------------------------------------------------------------------

  describe('packaged build: _scheduleRefresh is triggered on activate() success', () => {
    it('runs through activate() successfully under isPackaged=true', async () => {
      setPackaged(true);

      vi.mocked(fingerprintMock.collectFingerprint).mockResolvedValue('fp-packaged');
      vi.mocked(onlineMock.onlineActivate).mockResolvedValue({
        success: true,
        data: { status: 'activated', server_time: '2026-01-01T00:00:00Z', activation_id: 'act-1' },
      });
      vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
        success: true,
        data: { revoked: false, server_time: '2026-01-01T00:00:00Z', license: null },
      });
      vi.mocked(storeMock.readActivationMeta).mockReturnValue(null);
      vi.mocked(storeMock.readLicense).mockReturnValue(null);
      vi.mocked(validatorMock.validateLicense).mockReturnValue({
        valid: true,
        license: makeLicenseFile().payload,
      });
      downloadProMock.mockResolvedValue({ success: true });

      const svc = new LicenseService();
      const result = await svc.activate(JSON.stringify(makeLicenseFile()));
      svc.dispose();

      setPackaged(false);

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // checkOfflineGrace() — D4 / Path A + Path B decision tree
  // -------------------------------------------------------------------------
  describe('checkOfflineGrace', () => {
    const SIGNED_TOKEN_FIXTURE = {
      payload: {
        license_id: 'lic-123',
        server_time: '2026-06-15T00:00:00.000Z',
        expires_at: '2026-06-22T00:00:00.000Z',
      },
      signature: 'base64-sig',
    };

    beforeEach(() => {
      // Default: no online-check.json on disk, no license file, no D4 token.
      // Individual tests opt into more interesting scenarios.
      vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue(null);
      vi.mocked(storeMock.readLicense).mockReturnValue(null);
      vi.mocked(onlineCheckMock.verifyOnlineCheckToken).mockReturnValue({ valid: true });
      // Reset the requireSignedToken/offlineGraceDays host-env overrides.
      setHostEnvironment({
        isPackaged: () => isPackagedValue,
        getUserDataDir: () => '/fake/userData',
      });
    });

    it('returns offline_expired when online-check.json is missing', () => {
      const svc = new LicenseService();
      expect(svc.checkOfflineGrace()).toEqual({ authorized: false, reason: 'offline_expired' });
    });

    // ─── Path A — signed_token ────────────────────────────────────────────
    describe('Path A (signed_token)', () => {
      it('authorizes when token is valid, surfaces daysLeft from token.expires_at', () => {
        const futureMs = Date.now() + 6 * 24 * 60 * 60 * 1000;
        const token = {
          payload: {
            license_id: 'lic-123',
            server_time: new Date().toISOString(),
            expires_at: new Date(futureMs).toISOString(),
          },
          signature: 'base64-sig',
        };
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: new Date().toISOString(),
          signed_token: token,
        });
        vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
        vi.mocked(onlineCheckMock.verifyOnlineCheckToken).mockReturnValue({ valid: true });

        const result = new LicenseService().checkOfflineGrace();
        expect(result.authorized).toBe(true);
        expect(result.source).toBe('signed_token');
        expect(result.daysLeft).toBeGreaterThan(0);
        expect(result.daysLeft).toBeLessThanOrEqual(7);
      });

      it('hard-fails with tokenFailure on id_mismatch (does NOT fall through to Path B)', () => {
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: new Date().toISOString(), // would have made Path B authorize
          signed_token: SIGNED_TOKEN_FIXTURE,
        });
        vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
        vi.mocked(onlineCheckMock.verifyOnlineCheckToken).mockReturnValue({
          valid: false,
          reason: 'id_mismatch',
        });

        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'offline_expired',
          tokenFailure: 'id_mismatch',
        });
      });

      it('hard-fails with tokenFailure on expired token', () => {
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: new Date().toISOString(),
          signed_token: SIGNED_TOKEN_FIXTURE,
        });
        vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
        vi.mocked(onlineCheckMock.verifyOnlineCheckToken).mockReturnValue({
          valid: false,
          reason: 'expired',
        });

        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'offline_expired',
          tokenFailure: 'expired',
        });
      });

      it('hard-fails with tokenFailure on invalid_signature', () => {
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: new Date().toISOString(),
          signed_token: SIGNED_TOKEN_FIXTURE,
        });
        vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
        vi.mocked(onlineCheckMock.verifyOnlineCheckToken).mockReturnValue({
          valid: false,
          reason: 'invalid_signature',
        });

        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'offline_expired',
          tokenFailure: 'invalid_signature',
        });
      });

      it('falls through to Path B on `malformed` verdict (legacy file tolerance)', () => {
        const past = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: past,
          server_time: past,
          signed_token: { payload: undefined, signature: undefined } as never,
        });
        vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
        vi.mocked(onlineCheckMock.verifyOnlineCheckToken).mockReturnValue({
          valid: false,
          reason: 'malformed',
        });

        const result = new LicenseService().checkOfflineGrace();
        expect(result.authorized).toBe(true);
        expect(result.source).toBe('last_online_check');
      });

      it('skips Path A when local license file is missing (degrades to Path B)', () => {
        const recent = new Date().toISOString();
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: recent,
          server_time: recent,
          signed_token: SIGNED_TOKEN_FIXTURE,
        });
        vi.mocked(storeMock.readLicense).mockReturnValue(null); // no license_id available

        const result = new LicenseService().checkOfflineGrace();
        expect(result.authorized).toBe(true);
        expect(result.source).toBe('last_online_check');
        expect(onlineCheckMock.verifyOnlineCheckToken).not.toHaveBeenCalled();
      });
    });

    // ─── Path B — legacy unsigned window ───────────────────────────────────
    describe('Path B (legacy unsigned grace)', () => {
      it('authorizes within the window, daysLeft based on (graceDays - daysSince)', () => {
        const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: oneDayAgo,
          server_time: oneDayAgo,
        });

        const result = new LicenseService().checkOfflineGrace();
        expect(result.authorized).toBe(true);
        expect(result.source).toBe('last_online_check');
        expect(result.daysLeft).toBe(13); // default 14d - 1d
      });

      it('returns offline_expired when daysSince exceeds the default 14-day window', () => {
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: fifteenDaysAgo,
          server_time: fifteenDaysAgo,
        });

        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'offline_expired',
          lastCheck: fifteenDaysAgo,
        });
      });

      it('honours hostEnv.offlineGraceDays override (CLI maps this to 60)', () => {
        setHostEnvironment({
          isPackaged: () => false,
          getUserDataDir: () => '/fake/userData',
          offlineGraceDays: 60,
        });
        const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: twentyDaysAgo,
          server_time: twentyDaysAgo,
        });

        const result = new LicenseService().checkOfflineGrace();
        expect(result.authorized).toBe(true);
        expect(result.daysLeft).toBe(40); // 60 - 20
      });

      it('detects clock rollback when daysSince < 0', () => {
        const oneHourFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: oneHourFuture,
          server_time: oneHourFuture,
        });

        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'clock_anomaly',
        });
      });

      it('returns offline_expired when last_online_check is missing entirely', () => {
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: '',
        });
        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'offline_expired',
        });
      });

      it('returns offline_expired when server_time/last_online_check is unparseable', () => {
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: 'not-a-date',
        });
        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'offline_expired',
        });
      });

      it('prefers server_time over last_online_check when both present', () => {
        // last_online_check is 1 day ago (would authorise), but server_time is
        // 20 days ago — the legacy gate uses server_time as authoritative.
        const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: oneDayAgo,
          server_time: twentyDaysAgo,
        });

        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'offline_expired',
          lastCheck: oneDayAgo,
        });
      });
    });

    // ─── requireSignedToken — Path B bypass ────────────────────────────────
    describe('requireSignedToken (compliance hardening)', () => {
      it('refuses Path B entirely when hostEnv.requireSignedToken === true', () => {
        setHostEnvironment({
          isPackaged: () => false,
          getUserDataDir: () => '/fake/userData',
          requireSignedToken: true,
        });
        const recent = new Date().toISOString();
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: recent,
          server_time: recent,
        });

        // Path B would have authorised, but requireSignedToken blocks it.
        expect(new LicenseService().checkOfflineGrace()).toEqual({
          authorized: false,
          reason: 'offline_expired',
        });
      });

      it('Path A still works under requireSignedToken=true', () => {
        setHostEnvironment({
          isPackaged: () => false,
          getUserDataDir: () => '/fake/userData',
          requireSignedToken: true,
        });
        const futureMs = Date.now() + 5 * 24 * 60 * 60 * 1000;
        vi.mocked(onlineCheckStoreMock.readOnlineCheck).mockReturnValue({
          last_online_check: new Date().toISOString(),
          signed_token: {
            payload: {
              license_id: 'lic-123',
              server_time: new Date().toISOString(),
              expires_at: new Date(futureMs).toISOString(),
            },
            signature: 'sig',
          },
        });
        vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
        vi.mocked(onlineCheckMock.verifyOnlineCheckToken).mockReturnValue({ valid: true });

        const result = new LicenseService().checkOfflineGrace();
        expect(result.authorized).toBe(true);
        expect(result.source).toBe('signed_token');
      });
    });
  });

  // -------------------------------------------------------------------------
  // D4 token persistence — activate/refresh write online-check.json
  // -------------------------------------------------------------------------
  describe('D4 token persistence (writeOnlineCheck wiring)', () => {
    const SIGNED_TOKEN = {
      payload: {
        license_id: 'lic-123',
        server_time: '2026-06-16T00:00:00.000Z',
        expires_at: '2026-06-23T00:00:00.000Z',
      },
      signature: 'base64-sig',
    };

    beforeEach(() => {
      vi.mocked(onlineCheckStoreMock.writeOnlineCheck).mockClear();
    });

    // ── activate() side ────────────────────────────────────────────────────
    describe('activate()', () => {
      it('persists online_check_token when server returns one', async () => {
        vi.mocked(onlineMock.onlineActivate).mockResolvedValue({
          success: true,
          data: {
            status: 'activated',
            server_time: '2026-06-16T00:00:00.000Z',
            activation_id: 'act-uuid-1',
            online_check_token: SIGNED_TOKEN,
          },
        });

        const svc = new LicenseService();
        await svc.activate(JSON.stringify(makeLicenseFile()));
        svc.dispose();

        expect(onlineCheckStoreMock.writeOnlineCheck).toHaveBeenCalledOnce();
        expect(onlineCheckStoreMock.writeOnlineCheck).toHaveBeenCalledWith(
          expect.any(String),
          '2026-06-16T00:00:00.000Z',
          SIGNED_TOKEN
        );
      });

      it('persists server_time with undefined token when pre-D4 server omits it', async () => {
        // Default mock already lacks online_check_token — confirm it's
        // forwarded as undefined so online-check-store can omit signed_token
        // while still bumping last_online_check.
        const svc = new LicenseService();
        await svc.activate(JSON.stringify(makeLicenseFile()));
        svc.dispose();

        expect(onlineCheckStoreMock.writeOnlineCheck).toHaveBeenCalledOnce();
        expect(onlineCheckStoreMock.writeOnlineCheck).toHaveBeenCalledWith(
          expect.any(String),
          '2026-05-21T00:00:00Z',
          undefined
        );
      });

      it('does NOT write online-check.json when online activate fails (offline grace path)', async () => {
        vi.mocked(onlineMock.onlineActivate).mockResolvedValue({
          success: false,
          error: { type: 'network_error', message: 'ETIMEDOUT' },
        });

        const svc = new LicenseService();
        await svc.activate(JSON.stringify(makeLicenseFile()));
        svc.dispose();

        expect(onlineCheckStoreMock.writeOnlineCheck).not.toHaveBeenCalled();
      });

      it('does NOT write online-check.json when fingerprint is unavailable (skips online entirely)', async () => {
        vi.mocked(fingerprintMock.collectFingerprint).mockRejectedValue(new Error('no hw'));

        const svc = new LicenseService();
        await svc.activate(JSON.stringify(makeLicenseFile()));
        svc.dispose();

        expect(onlineMock.onlineActivate).not.toHaveBeenCalled();
        expect(onlineCheckStoreMock.writeOnlineCheck).not.toHaveBeenCalled();
      });
    });

    // ── doRefreshNow() side ────────────────────────────────────────────────
    describe('doRefreshNow()', () => {
      beforeEach(() => {
        vi.mocked(storeMock.readActivationMeta).mockReturnValue(makeActivationMeta());
        vi.mocked(storeMock.readLicense).mockReturnValue(makeLicenseFile());
        // Status must be 'active' for refresh to reach the success branch
        // without short-circuiting on bad state — set up via initialize().
      });

      it('persists online_check_token when server returns one on non-revoked refresh', async () => {
        vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
          success: true,
          data: {
            revoked: false,
            server_time: '2026-06-16T01:00:00.000Z',
            license: null,
            online_check_token: SIGNED_TOKEN,
          },
        });

        const svc = new LicenseService();
        await svc.doRefreshNow();
        svc.dispose();

        expect(onlineCheckStoreMock.writeOnlineCheck).toHaveBeenCalledOnce();
        expect(onlineCheckStoreMock.writeOnlineCheck).toHaveBeenCalledWith(
          expect.any(String),
          '2026-06-16T01:00:00.000Z',
          SIGNED_TOKEN
        );
      });

      it('persists server_time with undefined token when pre-D4 server omits it', async () => {
        vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
          success: true,
          data: {
            revoked: false,
            server_time: '2026-06-16T02:00:00.000Z',
            license: null,
          },
        });

        const svc = new LicenseService();
        await svc.doRefreshNow();
        svc.dispose();

        expect(onlineCheckStoreMock.writeOnlineCheck).toHaveBeenCalledOnce();
        expect(onlineCheckStoreMock.writeOnlineCheck).toHaveBeenCalledWith(
          expect.any(String),
          '2026-06-16T02:00:00.000Z',
          undefined
        );
      });

      it('does NOT write online-check.json on revoked refresh (denies continued offline use)', async () => {
        // CLI / server contract: revoked responses intentionally omit
        // online_check_token. Even if a buggy/tampered server attached one,
        // we must not persist a fresh grace token for a revoked license.
        vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
          success: true,
          data: {
            revoked: true,
            server_time: '2026-06-16T03:00:00.000Z',
            revoked_at: '2026-06-15T00:00:00.000Z',
            reason: 'admin_revoke',
            license: null,
          },
        });

        const svc = new LicenseService();
        await svc.doRefreshNow();
        svc.dispose();

        expect(onlineCheckStoreMock.writeOnlineCheck).not.toHaveBeenCalled();
      });

      it('does NOT write online-check.json on network failure', async () => {
        vi.mocked(onlineMock.onlineRefresh).mockResolvedValue({
          success: false,
          error: { type: 'network_error', message: 'ETIMEDOUT' },
        });

        const svc = new LicenseService();
        await svc.doRefreshNow();
        svc.dispose();

        expect(onlineCheckStoreMock.writeOnlineCheck).not.toHaveBeenCalled();
      });
    });
  });
});
