/**
 * LicenseService — singleton that manages license activation state.
 *
 * Ported from CortexDev-Agents/src/main/core/license/license-service.ts.
 * Decoupling changes:
 *   - `import { app } from 'electron'`              → `setHostEnvironment()` injection
 *   - `import { log } from '@main/lib/logger'`     → `setLogger()` injection
 *   - `../cortexdev-pro/binary-downloader`         → optional `setBinaryDownloadHooks()`
 *
 * Lifecycle (unchanged):
 *   1. `initialize()` reads the license file, collects the device fingerprint,
 *      validates the license, caches the resulting `LicenseStatus`.
 *   2. `getStatus()` returns the cached status synchronously.
 *   3. `activate()` / `activateFromFile()` handle new license submissions.
 *      Online activation is attempted after local validation; network failure
 *      falls back to offline-grace mode.
 *   4. `doRefreshNow()` checks the server for revocation.
 *   5. `deactivate()` clears the stored license file.
 *   6. `dispose()` must be called on app quit to clean up the refresh timer.
 *
 * SECURITY:
 * - Validation runs only in the host process.
 * - The UI receives `LicenseStatus` via IPC — never raw license data.
 * - `skipCache: true` is used for the license gate so stale fingerprint cache
 *   cannot be exploited.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LEGACY_KEY_SUNSET, setLegacyKeyHitListener } from './crypto.js';
import { collectFingerprint } from './fingerprint.js';
import {
  onlineActivate,
  onlineRefresh,
  type OnlineClientError,
  type RefreshResponse,
} from './online-client.js';
import {
  deleteLicense,
  readActivationMeta,
  readLicense,
  resolveConfigDir,
  writeActivationMeta,
  writeLicense,
} from './store.js';
import type {
  ActivationMeta,
  ActivationResult,
  LicenseErrorReason,
  LicenseFile,
  LicenseStatus,
  RefreshOutcome,
  RefreshRejectionReason,
} from './types.js';
import { validateLicense } from './validator.js';

// ---------------------------------------------------------------------------
// Host environment injection (replaces electron `app` and `@main/lib/logger`)
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface used by LicenseService. Defaults to a no-op so the
 * module is safe to import in any host (including CLI processes that route
 * their own logging differently).
 */
export interface ServiceLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

const noopLogger: ServiceLogger = {
  warn: () => undefined,
  error: () => undefined,
};

let serviceLogger: ServiceLogger = noopLogger;

export function setServiceLogger(impl: ServiceLogger): void {
  serviceLogger = impl;
}

/**
 * Host-process environment information. The Electron host wires this with
 * `app.isPackaged` and `app.getPath('userData')`; a CLI host can pass static
 * values (e.g. always packaged, custom user-data path).
 */
export interface HostEnvironment {
  /** True when running from a packaged build (gates online refresh). */
  isPackaged: () => boolean;
  /** The directory where binary downloads / stale tmp files live (CLI binaries dir). */
  getUserDataDir?: () => string;
}

let hostEnv: HostEnvironment = {
  isPackaged: () => false,
};

export function setHostEnvironment(env: HostEnvironment): void {
  hostEnv = env;
}

/**
 * Optional hooks for auto-downloading the Pro binary after activation. Hosts
 * that bundle the binary themselves (CLI distributions, DevEye/DevEyeProd)
 * can leave these undefined; the GUI wires them to its binary-downloader.
 */
export interface BinaryDownloadHooks<TDownloadProgressEvent = unknown> {
  /** Clean up stale `*.tmp` partial downloads in the user-data binaries dir. */
  cleanupStaleTmp?: (userDataDir: string) => void;
  /** Trigger a Pro-binary download. Receives an onProgress callback. */
  downloadPro?: (args: {
    onProgress: (event: TDownloadProgressEvent) => void;
  }) => Promise<{ success: true } | { success: false; error: unknown }>;
}

let binaryDownloadHooks: BinaryDownloadHooks = {};

export function setBinaryDownloadHooks<T>(hooks: BinaryDownloadHooks<T>): void {
  binaryDownloadHooks = hooks as BinaryDownloadHooks;
}

// ---------------------------------------------------------------------------
// Wire the legacy-key hit hook so any successful verification against a
// migration-window key surfaces in the host log.
// ---------------------------------------------------------------------------

setLegacyKeyHitListener((label) => {
  serviceLogger.warn('LicenseService: license verified using LEGACY key — re-issue recommended', {
    legacyKeyLabel: label,
    sunset: LEGACY_KEY_SUNSET,
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OFFLINE_GRACE_DAYS = 14;
const OFFLINE_GRACE_WARNING_THRESHOLD_DAYS = 3;
const REFRESH_RETRY_MS = 30 * 60 * 1000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

type OnlineErrorType = OnlineClientError['type'];

// ---------------------------------------------------------------------------
// LicenseService
// ---------------------------------------------------------------------------

export class LicenseService {
  private status: LicenseStatus = { state: 'unlicensed' };
  private configDir: string = resolveConfigDir();
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _onStatusChange: ((status: LicenseStatus) => void) | null = null;
  private _onDownloadProgress: ((event: unknown) => void) | null = null;

  setStatusChangeListener(cb: (status: LicenseStatus) => void): void {
    this._onStatusChange = cb;
  }

  setDownloadProgressListener(cb: (event: unknown) => void): void {
    this._onDownloadProgress = cb;
  }

  emitDownloadProgress(event: unknown): void {
    if (this._onDownloadProgress) {
      try {
        this._onDownloadProgress(event);
      } catch (e) {
        serviceLogger.warn('LicenseService: download progress listener threw', {
          error: String(e),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.status = { state: 'validating' };

    try {
      const licenseFile = readLicense(this.configDir);
      if (!licenseFile) {
        this.status = { state: 'unlicensed' };
        return;
      }

      let fingerprint: string | null = null;
      try {
        fingerprint = await collectFingerprint(this.configDir, { skipCache: true });
      } catch (e) {
        serviceLogger.warn('LicenseService.initialize: fingerprint collection failed', {
          error: String(e),
        });
      }

      const activationMeta = readActivationMeta(this.configDir);

      if (activationMeta?.server_status?.revoked) {
        this.status = { state: 'revoked', license: licenseFile.payload };
        return;
      }

      this.status = this._validate(licenseFile, fingerprint, activationMeta);

      if (this.status.state === 'active' && activationMeta?.last_verified_at) {
        this.status = this._applyOfflineGrace(this.status, activationMeta.last_verified_at);
      }

      if (this.status.state === 'active') {
        if (hostEnv.isPackaged()) {
          this._scheduleRefresh(true);
        }
      }
    } catch (e) {
      serviceLogger.error('LicenseService.initialize: unexpected error', { error: String(e) });
      this.status = { state: 'error', reason: 'file_corrupt', details: String(e) };
    } finally {
      // Clean up stale .tmp files only when both a hook AND a user-data dir
      // resolver are provided. Hosts that do not bundle a binary downloader
      // (CLI distributions) leave both undefined and skip this branch entirely.
      try {
        const userDataDir = hostEnv.getUserDataDir?.();
        if (userDataDir && binaryDownloadHooks.cleanupStaleTmp) {
          binaryDownloadHooks.cleanupStaleTmp(userDataDir);
        }
      } catch (e) {
        serviceLogger.warn('LicenseService.initialize: cleanupStaleTmp failed', {
          error: String(e),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status / Activation / Refresh / Deactivation / Cleanup (public API)
  // ---------------------------------------------------------------------------

  getStatus(): LicenseStatus {
    return this.status;
  }

  async activate(licenseJson: string): Promise<ActivationResult> {
    let licenseFile: unknown;
    try {
      licenseFile = JSON.parse(licenseJson);
    } catch {
      return this._activationError('invalid_structure', 'JSON parse failed');
    }
    return this._processActivation(licenseFile);
  }

  async activateFromFile(filePath: string): Promise<ActivationResult> {
    let licenseJson: string;
    try {
      licenseJson = readFileSync(filePath, 'utf8');
    } catch (e) {
      return this._activationError('file_corrupt', `Cannot read file: ${String(e)}`);
    }
    return this.activate(licenseJson);
  }

  async doRefreshNow(): Promise<{
    status: LicenseStatus;
    reachedServer: boolean;
    outcome: RefreshOutcome;
  }> {
    this._clearRefreshTimer();
    const outcome = await this._doRefresh();
    return { status: this.status, reachedServer: outcome.kind !== 'network_error', outcome };
  }

  deactivate(): Promise<void> {
    this._clearRefreshTimer();
    try {
      deleteLicense(this.configDir);
    } catch (e) {
      serviceLogger.warn('LicenseService.deactivate: error deleting license file', {
        error: String(e),
      });
    }
    this.status = { state: 'unlicensed' };
    this._emitStatusChange();
    return Promise.resolve();
  }

  dispose(): void {
    this._clearRefreshTimer();
  }

  // ---------------------------------------------------------------------------
  // Private helpers — activation
  // ---------------------------------------------------------------------------

  private async _processActivation(licenseFile: unknown): Promise<ActivationResult> {
    let fingerprint: string | null = null;
    try {
      fingerprint = await collectFingerprint(this.configDir);
    } catch (e) {
      serviceLogger.warn('LicenseService.activate: fingerprint collection failed', {
        error: String(e),
      });
    }

    const activationMeta = readActivationMeta(this.configDir);
    const result = this._validate(licenseFile, fingerprint, activationMeta);

    if (result.state === 'active') {
      const now = new Date().toISOString();
      const activation_id = activationMeta?.activation_id ?? randomUUID();

      let serverSynced = false;
      const typedLicenseFile = licenseFile as LicenseFile;

      if (fingerprint) {
        const onlineResult = await onlineActivate({
          license_id: typedLicenseFile.payload.license_id,
          fingerprint,
          activation_id,
        });

        if (!onlineResult.success) {
          const errType = onlineResult.error.type;

          if (errType === 'device_limit_exceeded') {
            return this._activationError('device_limit_exceeded');
          }

          if (errType === 'license_revoked') {
            return this._activationError('server_revoked');
          }

          serviceLogger.warn(
            'LicenseService.activate: online registration failed, proceeding offline',
            { error: onlineResult.error }
          );
        } else {
          serverSynced = true;
        }
      }

      writeLicense(this.configDir, typedLicenseFile);

      writeActivationMeta(this.configDir, {
        last_verified_at: now,
        activated_at: activationMeta?.activated_at ?? now,
        fingerprint_at_activation: fingerprint ?? undefined,
        activation_id,
      });

      this.status = result;
      if (hostEnv.isPackaged()) {
        this._scheduleRefresh(true);
      }

      // Auto-download the Pro binary when activating a pro license, if a
      // host has registered a download hook. Hosts that bundle the binary
      // themselves leave the hook undefined.
      if (typedLicenseFile.payload.type === 'pro' && binaryDownloadHooks.downloadPro) {
        void binaryDownloadHooks
          .downloadPro({
            onProgress: (event) => this.emitDownloadProgress(event),
          })
          .then((r) => {
            if (!r.success) {
              serviceLogger.warn('[license] Pro auto-download failed', {
                error: String(r.error),
              });
            }
          })
          .catch((e: unknown) => {
            serviceLogger.warn('[license] Pro auto-download threw unexpectedly', {
              error: String(e),
            });
          });
      }

      return { success: true, status: result, serverSynced };
    }

    if (result.state === 'expired') {
      writeLicense(this.configDir, licenseFile as LicenseFile);
      this.status = result;
      return {
        success: false,
        status: result,
        error: 'expired',
      };
    }

    const errorResult = result as Extract<LicenseStatus, { state: 'error' }>;
    return this._activationError(errorResult.reason, errorResult.details);
  }

  // ---------------------------------------------------------------------------
  // Private helpers — refresh scheduling
  // ---------------------------------------------------------------------------

  private _scheduleRefresh(immediate: boolean): void {
    if (immediate) {
      this._clearRefreshTimer();
      void this._doRefresh();
    } else {
      this._scheduleNextRefresh(REFRESH_INTERVAL_MS);
    }
  }

  private _scheduleNextRefresh(delayMs: number): void {
    this._clearRefreshTimer();
    this._refreshTimer = setTimeout(() => void this._doRefresh(), delayMs);
  }

  private async _doRefresh(): Promise<RefreshOutcome> {
    this._clearRefreshTimer();
    let meta: ActivationMeta | null = null;
    let licenseFile: LicenseFile | null = null;
    try {
      meta = readActivationMeta(this.configDir);
      licenseFile = readLicense(this.configDir);

      if (!meta?.activation_id || !licenseFile) {
        if (meta && licenseFile) {
          this._handleOfflineGrace(meta, licenseFile);
        }
        this._scheduleNextRefresh(REFRESH_RETRY_MS);
        return { kind: 'network_error' };
      }

      const result = await onlineRefresh({
        license_id: licenseFile.payload.license_id,
        activation_id: meta.activation_id,
      });

      return result.success
        ? await this._handleRefreshSuccess(result.data, meta, licenseFile)
        : this._handleRefreshFailure(result.error.type, meta, licenseFile);
    } catch (e) {
      serviceLogger.warn('LicenseService.refresh: unexpected failure', {
        errorName: e instanceof Error ? e.name : 'UnknownError',
      });
      if (meta && licenseFile) {
        this._handleOfflineGrace(meta, licenseFile);
      }
      this._scheduleNextRefresh(REFRESH_RETRY_MS);
      return { kind: 'network_error' };
    }
  }

  private _handleRefreshFailure(
    errorType: OnlineErrorType,
    meta: ActivationMeta,
    licenseFile: LicenseFile
  ): RefreshOutcome {
    const rejection = classifyRefreshRejection(errorType);

    if (rejection === null) {
      serviceLogger.warn('LicenseService.refresh: availability failure, applying offline grace', {
        error: errorType,
      });
      this._handleOfflineGrace(meta, licenseFile);
      this._scheduleNextRefresh(REFRESH_RETRY_MS);
      return { kind: 'network_error' };
    }

    serviceLogger.warn('LicenseService.refresh: server rejected license', { reason: rejection });
    this._applyServerRejection(rejection, meta, licenseFile);
    this._scheduleNextRefresh(REFRESH_RETRY_MS);
    return { kind: 'server_rejected', reason: rejection };
  }

  private async _handleRefreshSuccess(
    refreshData: RefreshResponse,
    meta: ActivationMeta,
    licenseFile: LicenseFile
  ): Promise<RefreshOutcome> {
    const now = new Date().toISOString();

    writeActivationMeta(this.configDir, {
      ...meta,
      last_verified_at: now,
      server_status: {
        revoked: refreshData.revoked,
        server_time: refreshData.server_time,
        revoked_at: refreshData.revoked_at ?? null,
        reason: refreshData.reason ?? null,
        checked_at: now,
      },
    });

    if (refreshData.revoked) {
      serviceLogger.warn('LicenseService.refresh: license revoked by server');
      if (this.status.state === 'active') {
        this.status = { ...this.status, serverRevoked: true };
        this._emitStatusChange();
      }
      return { kind: 'server_rejected', reason: 'revoked' };
    }

    await this._applyRefreshNotRevoked(licenseFile, meta, now);
    this._scheduleNextRefresh(REFRESH_INTERVAL_MS);
    return { kind: 'ok' };
  }

  private async _applyRefreshNotRevoked(
    licenseFile: LicenseFile,
    meta: ActivationMeta,
    now: string
  ): Promise<void> {
    if (this.status.state === 'active') {
      this.status = {
        ...this.status,
        serverRevoked: undefined,
        offlineWarningDaysLeft: undefined,
      };
      this._emitStatusChange();
      return;
    }

    if (this.status.state === 'expired' && this.status.reason === 'offline_grace_exceeded') {
      const fp = await collectFingerprint(this.configDir).catch(() => null);
      this.status = this._validate(licenseFile, fp, { ...meta, last_verified_at: now });
      this._emitStatusChange();
    }
  }

  private _applyServerRejection(
    reason: RefreshRejectionReason,
    meta: ActivationMeta,
    _licenseFile: LicenseFile
  ): void {
    if (reason !== 'revoked') {
      return;
    }

    const now = new Date().toISOString();
    try {
      writeActivationMeta(this.configDir, {
        ...meta,
        server_status: {
          revoked: true,
          server_time: now,
          revoked_at: now,
          reason: 'license_revoked',
          checked_at: now,
        },
      });
    } catch (e) {
      serviceLogger.warn('LicenseService.refresh: failed to persist revoked server_status', {
        error: String(e),
      });
    }

    if (this.status.state === 'active') {
      this.status = { ...this.status, serverRevoked: true };
      this._emitStatusChange();
    }
  }

  private _handleOfflineGrace(meta: ActivationMeta, licenseFile: LicenseFile): void {
    const anchor = meta.last_verified_at ?? meta.activated_at;
    if (!anchor) {
      if (this.status.state === 'active') {
        this.status = {
          state: 'expired',
          license: licenseFile.payload,
          reason: 'offline_grace_exceeded',
        };
        this._emitStatusChange();
      }
      return;
    }
    const lastVerified = new Date(anchor).getTime();
    const graceDays = (Date.now() - lastVerified) / 86_400_000;

    if (graceDays > OFFLINE_GRACE_DAYS) {
      if (this.status.state === 'active') {
        this.status = {
          state: 'expired',
          license: licenseFile.payload,
          reason: 'offline_grace_exceeded',
        };
        this._emitStatusChange();
      }
    } else if (graceDays > OFFLINE_GRACE_DAYS - OFFLINE_GRACE_WARNING_THRESHOLD_DAYS) {
      const daysLeft = Math.ceil(OFFLINE_GRACE_DAYS - graceDays);
      if (this.status.state === 'active') {
        this.status = { ...this.status, offlineWarningDaysLeft: daysLeft };
        this._emitStatusChange();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers — validation
  // ---------------------------------------------------------------------------

  private _validate(
    licenseFile: unknown,
    fingerprint: string | null,
    activationMeta: ActivationMeta | null
  ): LicenseStatus {
    const result = validateLicense(licenseFile, fingerprint, {
      lastVerifiedAt: activationMeta?.last_verified_at,
    });

    if (result.valid && result.license) {
      return { state: 'active', license: result.license };
    }

    if (result.reason === 'expired' && result.license) {
      return { state: 'expired', license: result.license, reason: 'license_expired' };
    }

    return {
      state: 'error',
      reason: result.reason ?? 'invalid_structure',
      details: result.errors?.join('; '),
    };
  }

  private _applyOfflineGrace(
    status: Extract<LicenseStatus, { state: 'active' }>,
    lastVerifiedAt: string
  ): LicenseStatus {
    const graceDays = (Date.now() - new Date(lastVerifiedAt).getTime()) / 86_400_000;

    if (graceDays > OFFLINE_GRACE_DAYS) {
      return { state: 'expired', license: status.license, reason: 'offline_grace_exceeded' };
    }

    if (graceDays > OFFLINE_GRACE_DAYS - OFFLINE_GRACE_WARNING_THRESHOLD_DAYS) {
      const daysLeft = Math.ceil(OFFLINE_GRACE_DAYS - graceDays);
      return { ...status, offlineWarningDaysLeft: daysLeft };
    }

    return status;
  }

  private _activationError(reason: LicenseErrorReason, details?: string): ActivationResult {
    const status: LicenseStatus = { state: 'error', reason, details };
    this.status = status;
    return { success: false, status, error: reason, details };
  }

  private _emitStatusChange(): void {
    if (this._onStatusChange) {
      try {
        this._onStatusChange(this.status);
      } catch (e) {
        serviceLogger.warn('LicenseService: status change listener threw', { error: String(e) });
      }
    }
  }

  private _clearRefreshTimer(): void {
    if (this._refreshTimer !== null) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}

/**
 * Map an `OnlineClientError.type` to a `RefreshRejectionReason`, or `null` when
 * the failure is an AVAILABILITY problem (the server's verdict is unknown).
 */
function classifyRefreshRejection(errorType: OnlineErrorType): RefreshRejectionReason | null {
  switch (errorType) {
    case 'network_error':
    case 'api_error':
      return null;
    case 'not_found':
      return 'not_found';
    case 'license_revoked':
      return 'revoked';
    case 'device_limit_exceeded':
      return 'device_limit_exceeded';
  }
}

/** Module-level singleton exported for use by host controllers. */
export const licenseService = new LicenseService();
