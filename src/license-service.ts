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
import {
  clearFatal,
  fatalGraceRemainingHours,
  isFatalExpired,
  readFatal,
  writeFatal,
} from './fatal-state.js';
import { _collectFingerprintWithOverride } from './fingerprint.js';
import { getHostProductIdentity } from './host-identity.js';
import { verifyOnlineCheckToken } from './online-check.js';
import { readOnlineCheck, writeOnlineCheck } from './online-check-store.js';
import {
  onlineActivate,
  onlineRefresh,
  getCurrentLicenseServerURL,
  type ActivateResponse,
  type OnlineClientError,
  type RefreshResponse,
} from './online-client.js';
import {
  clearRefreshState,
  isWithinCooldown,
  readRefreshState,
  writeRefreshState,
} from './refresh-state.js';
import {
  deleteLicense,
  readActivationMeta,
  readLicense,
  resolveConfigDir,
  writeActivationMeta,
  writeLicense,
} from './store.js';
import { EMBEDDED_TOKEN_PUBLIC_KEY } from './token-key.js';
import type {
  ActivationMeta,
  ActivationResult,
  FatalRecord,
  LicenseErrorReason,
  LicenseFile,
  LicenseStatus,
  OfflineGraceResult,
  RefreshOutcome,
  RefreshRejectionReason,
} from './types.js';
import { checkProductCompatibility } from './schema.js';
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
  /**
   * Number of days the legacy unsigned `last_online_check` keeps a user
   * authorised when offline. Mirrors CLI gate.js `OFFLINE_GRACE_DAYS`.
   *   - DevAgent-App historical default: 14
   *   - DevAgent-CLI historical default: 60
   * Adapters wire this to whichever value preserves their existing user
   * behaviour. Defaults to 14 to preserve license-client's pre-D4 contract.
   */
  offlineGraceDays?: number;
  /**
   * When true, `checkOfflineGrace()` refuses to fall back to the unsigned
   * Path B (legacy `last_online_check`) — only a server-signed D4 token can
   * authorise an offline session. Mirrors CLI gate.js
   * `LICENSE_REQUIRE_SIGNED_TOKEN=true` env. Compliance-sensitive deployments
   * (where unsigned grace is unacceptable) flip this on.
   */
  requireSignedToken?: boolean;
  /**
   * Override the steady-state refresh interval (ms) between successful
   * `/refresh` calls. Default `REFRESH_INTERVAL_MS` (24h) preserves
   * license-client / DevAgent-App behaviour. CLI adapter passes
   * `3 * 24 * 60 * 60 * 1000` to match its legacy 3-day cadence.
   *
   * Failure-path retries (REFRESH_RETRY_MS = 30min backoff) are NOT
   * controlled by this field — that's a backoff, not a steady cadence.
   */
  refreshIntervalMs?: number;
  /**
   * Wall-clock budget (ms) for the `initialize()` startup refresh path.
   * When set + exceeded, the startup refresh aborts and falls back to
   * offline grace, matching CLI `refresh.js: STARTUP_BUDGET_MS = 5000`.
   * Default `undefined` = unlimited (current license-client behaviour).
   *
   * Only the initial startup refresh consults this budget; subsequent
   * periodic refreshes use the steady-state interval without a budget.
   */
  refreshStartupBudgetMs?: number;
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

      // Two-layer fingerprint collection (mirrors CLI gate.js):
      //   1. Fresh collect (skipCache: true) — preferred, picks up hardware
      //      changes immediately.
      //   2. If fresh collect THROWS (insufficient hardware identifiers
      //      visible to this process), fall back to the on-disk cache so a
      //      previously-good activation survives a transient hardware-probe
      //      failure (cold-start WMI on Windows, missing IOKit permissions
      //      on macOS, etc.). Only used when fresh collection cannot produce
      //      *any* fingerprint at all.
      let fingerprint: string | null = null;
      try {
        fingerprint = await _collectFingerprintWithOverride(this.configDir, { skipCache: true });
      } catch (e) {
        serviceLogger.warn('LicenseService.initialize: fingerprint collection failed', {
          error: String(e),
        });
        try {
          fingerprint = await _collectFingerprintWithOverride(this.configDir, { skipCache: false });
          serviceLogger.warn('LicenseService.initialize: recovered fingerprint from cache', {});
        } catch (cacheErr) {
          serviceLogger.warn('LicenseService.initialize: fingerprint cache also unavailable', {
            error: String(cacheErr),
          });
        }
      }

      const activationMeta = readActivationMeta(this.configDir);

      if (activationMeta?.server_status?.revoked) {
        this.status = { state: 'revoked', license: licenseFile.payload };
        return;
      }

      this.status = this._validate(licenseFile, fingerprint, activationMeta);

      // Fingerprint-mismatch recovery (mirrors CLI gate.js): hardware collectors
      // (e.g. WMI on Windows) can return partial data on cold start, producing
      // a hash that differs from the activation-time value. Retry once with
      // the persisted cache before hard-rejecting.
      if (
        this.status.state === 'error' &&
        this.status.reason === 'fingerprint_mismatch' &&
        fingerprint !== null
      ) {
        try {
          const cached = await _collectFingerprintWithOverride(this.configDir, {
            skipCache: false,
          });
          if (cached && cached !== fingerprint) {
            const retry = this._validate(licenseFile, cached, activationMeta);
            if (retry.state === 'active') {
              serviceLogger.warn('LicenseService.initialize: recovered via cached fingerprint', {});
              this.status = retry;
              fingerprint = cached;
            }
          }
        } catch {
          // cache unavailable — original fingerprint_mismatch verdict stands.
        }
      }

      if (this.status.state === 'active' && activationMeta?.last_verified_at) {
        this.status = this._applyOfflineGrace(this.status, activationMeta.last_verified_at);
      }

      // server_mismatch detection — runs BEFORE refresh scheduling so a wrong
      // env never reaches /refresh. Uses meta.issued_server pinned at activate
      // time; v1 records without the field skip this guard (back-compat).
      if (this.status.state === 'active' && activationMeta?.issued_server) {
        const current = getCurrentLicenseServerURL();
        if (current && activationMeta.issued_server !== current.url) {
          this.status = {
            state: 'error',
            reason: 'server_mismatch',
            license: licenseFile.payload,
            mismatch: { issued: activationMeta.issued_server, current: current.url },
          };
          return;
        }
      }

      // fatal-state grace — a prior /refresh fatal hard-blocks once the 24h
      // window has elapsed. Within grace we keep the user active (with a
      // warning the adapter surfaces) so a transient KV mistake doesn't
      // instantly lock everyone out.
      if (this.status.state === 'active') {
        const fatal = readFatal(this.configDir);
        if (fatal) {
          if (isFatalExpired(fatal)) {
            this.status = {
              state: 'error',
              reason: 'fatal_refresh_failure',
              license: licenseFile.payload,
              fatal,
            };
            return;
          }
          serviceLogger.warn('LicenseService.initialize: prior fatal refresh within grace window', {
            reason: fatal.reason,
            host: fatal.host,
            hoursRemaining: fatalGraceRemainingHours(fatal),
          });
        }
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

  // ---------------------------------------------------------------------------
  // Offline grace decision (D4)
  // ---------------------------------------------------------------------------

  /**
   * Decide whether the local license is allowed to operate offline based on
   * the most recent server contact recorded in `online-check.json`.
   *
   * Mirrors CLI gate.js `checkOfflineGrace()` so adapters can map 1:1:
   *
   *   Path A — server-signed D4 token (`signed_token`):
   *     - valid              → authorized + daysLeft from token.expires_at
   *     - reason: malformed  → fall through to Path B (legacy file format)
   *     - reason: id_mismatch / expired / invalid_signature → HARD FAIL with
   *       `tokenFailure` populated. NEVER fall through to Path B on these;
   *       otherwise an attacker who breaks the signature could slide back
   *       into the more permissive unsigned window.
   *
   *   Path B — legacy unsigned `last_online_check` + `server_time`:
   *     - hostEnv.requireSignedToken === true → refuse Path B entirely
   *     - daysSince < 0 (clock rollback)      → clock_anomaly
   *     - daysSince > offlineGraceDays         → offline_expired + lastCheck
   *     - else                                 → authorized
   *
   * Returns offline_expired when the file is missing or unreadable.
   *
   * Pure read — never writes; never reaches the network.
   */
  checkOfflineGrace(): OfflineGraceResult {
    const data = readOnlineCheck(this.configDir);
    if (!data) {
      return { authorized: false, reason: 'offline_expired' };
    }

    // Path A — D4 signed_token. We need the local license_id to detect cross
    // -account replay. If the license file is missing the outer gate flow has
    // already rejected the session, but we tolerate the read failure here so
    // a partially-installed state degrades to "no Path A, try Path B".
    const license = readLicense(this.configDir);
    const licenseId = license?.payload?.license_id;
    if (data.signed_token && licenseId) {
      const verdict = verifyOnlineCheckToken(
        data.signed_token,
        licenseId,
        EMBEDDED_TOKEN_PUBLIC_KEY
      );
      if (verdict.valid) {
        const expiresMs = Date.parse(data.signed_token.payload.expires_at);
        const daysLeft = Math.max(0, Math.ceil((expiresMs - Date.now()) / (1000 * 60 * 60 * 24)));
        return { authorized: true, daysLeft, source: 'signed_token' };
      }
      // `malformed` = old/corrupt file → fall through. Any other failure mode
      // is a hard fail with the reason surfaced for logging / UI.
      if (verdict.reason !== 'malformed') {
        return {
          authorized: false,
          reason: 'offline_expired',
          tokenFailure: verdict.reason,
        };
      }
    }

    // Path B — legacy unsigned window. Can be disabled by adapter for compliance.
    if (hostEnv.requireSignedToken === true) {
      return { authorized: false, reason: 'offline_expired' };
    }

    if (!data.last_online_check) {
      return { authorized: false, reason: 'offline_expired' };
    }

    // Prefer server_time for staleness; fall back to last_online_check.
    const referenceTimestamp = data.server_time ?? data.last_online_check;
    const referenceMs = new Date(referenceTimestamp).getTime();
    if (!Number.isFinite(referenceMs)) {
      return { authorized: false, reason: 'offline_expired' };
    }

    const daysSince = (Date.now() - referenceMs) / (1000 * 60 * 60 * 24);

    // Clock rollback detection: negative daysSince means local clock is behind
    // server_time, which the user (or an attacker) cannot otherwise reach.
    if (daysSince < 0) {
      return { authorized: false, reason: 'clock_anomaly' };
    }

    const graceDays = hostEnv.offlineGraceDays ?? OFFLINE_GRACE_DAYS;
    if (daysSince > graceDays) {
      return {
        authorized: false,
        reason: 'offline_expired',
        lastCheck: data.last_online_check,
      };
    }

    return {
      authorized: true,
      daysLeft: Math.ceil(graceDays - daysSince),
      source: 'last_online_check',
    };
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
      fingerprint = await _collectFingerprintWithOverride(this.configDir);
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
      let onlineActivateData: ActivateResponse | undefined;
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
          onlineActivateData = onlineResult.data;
        }
      }

      writeLicense(this.configDir, typedLicenseFile);

      // Pin the server URL that issued this activation, so a later
      // initialize() can detect cross-environment misuse (server_mismatch).
      // Resolved at call time, NOT cached at module load, because adapters
      // may flip the env between activations. Best-effort — a null result
      // (invalid env) just leaves `issued_server` unset, preserving v1 meta
      // semantics for environments that already had the misconfiguration.
      const resolvedServer = serverSynced ? getCurrentLicenseServerURL() : null;

      writeActivationMeta(this.configDir, {
        last_verified_at: now,
        activated_at: activationMeta?.activated_at ?? now,
        fingerprint_at_activation: fingerprint ?? undefined,
        activation_id,
        ...(resolvedServer ? { issued_server: resolvedServer.url, schema_version: 2 } : {}),
      });

      // Persist the D4 online_check_token + server_time so a subsequent
      // restart (potentially offline) can go through Path A in
      // checkOfflineGrace. When we fell back to offline grace, there is no
      // server response — skip the write entirely (CLI gate.js semantics:
      // missing online-check.json = offline_expired until next /refresh).
      if (onlineActivateData) {
        writeOnlineCheck(
          this.configDir,
          onlineActivateData.server_time,
          onlineActivateData.online_check_token
        );
      }

      // Successful activate clears any stale fatal/cooldown state — same
      // recovery semantics as a successful refresh.
      try {
        clearFatal(this.configDir);
        clearRefreshState(this.configDir);
      } catch (e) {
        serviceLogger.warn('LicenseService.activate: failed to clear fatal/refresh-state', {
          error: String(e),
        });
      }

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
      void this._doRefresh({ startup: true });
    } else {
      this._scheduleNextRefresh(hostEnv.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
    }
  }

  private _scheduleNextRefresh(delayMs: number): void {
    this._clearRefreshTimer();
    this._refreshTimer = setTimeout(() => void this._doRefresh(), delayMs);
  }

  private async _doRefresh(opts: { startup?: boolean } = {}): Promise<RefreshOutcome> {
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

      // D5 cooldown — if a recent /refresh failed transiently, skip the next
      // online attempt entirely so a slow/broken endpoint can't add latency to
      // every startup. Offline-grace still gates the session.
      const cooldownState = readRefreshState(this.configDir);
      if (isWithinCooldown(cooldownState)) {
        serviceLogger.debug?.('LicenseService.refresh: skipped (within transient cooldown)', {
          host: cooldownState?.host,
        });
        this._handleOfflineGrace(meta, licenseFile);
        this._scheduleNextRefresh(REFRESH_RETRY_MS);
        return { kind: 'network_error' };
      }

      const refreshPromise = onlineRefresh({
        license_id: licenseFile.payload.license_id,
        activation_id: meta.activation_id,
      });

      // Startup budget — when the host opts in (CLI does, App does not),
      // race the network call against a wall-clock timer. Crossing the
      // budget falls back to offline grace so a slow license server cannot
      // block process startup.
      const budgetMs = opts.startup ? hostEnv.refreshStartupBudgetMs : undefined;
      const result =
        budgetMs !== undefined
          ? await Promise.race([
              refreshPromise,
              new Promise<{ success: false; error: { type: 'network_error' } }>((resolve) => {
                setTimeout(
                  () =>
                    resolve({
                      success: false,
                      error: { type: 'network_error' },
                    }),
                  budgetMs
                );
              }),
            ])
          : await refreshPromise;

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
      // D5 — record the transient so the next startup skips the network call
      // for REFRESH_COOLDOWN_MS. revoked / fatal paths intentionally do NOT
      // write this; they're authoritative server decisions.
      try {
        writeRefreshState(this.configDir, {
          kind: 'transient',
          last_attempt: new Date().toISOString(),
          error: errorType,
        });
      } catch (e) {
        serviceLogger.warn('LicenseService.refresh: failed to persist refresh-state', {
          error: String(e),
        });
      }
      this._handleOfflineGrace(meta, licenseFile);
      this._scheduleNextRefresh(REFRESH_RETRY_MS);
      return { kind: 'network_error' };
    }

    serviceLogger.warn('LicenseService.refresh: server rejected license', { reason: rejection });

    // Persist last-fatal on the *first* authoritative reject so the 24h grace
    // window anchors to the initial failure (not the most recent retry).
    // 'revoked' is NOT a "fatal" in the legacy CLI sense — it's a deliberate
    // admin action with its own UI box, so don't overwrite the fatal record.
    if (rejection !== 'revoked') {
      try {
        const existing = readFatal(this.configDir);
        if (!existing) {
          writeFatal(this.configDir, this._buildFatalRecord(rejection));
        }
      } catch (e) {
        serviceLogger.warn('LicenseService.refresh: failed to persist last-fatal', {
          error: String(e),
        });
      }
    }

    this._applyServerRejection(rejection, meta, licenseFile);
    this._scheduleNextRefresh(REFRESH_RETRY_MS);
    return { kind: 'server_rejected', reason: rejection };
  }

  private _buildFatalRecord(rejection: RefreshRejectionReason): FatalRecord {
    // RefreshRejectionReason → FatalRecord.reason mapping. license-client's
    // current rejection alphabet is narrower than CLI's; map to the closest
    // legacy bucket so printLockoutBox copy stays useful.
    const reason: FatalRecord['reason'] =
      rejection === 'not_found' ? 'not_found' : 'license_invalid';
    const host = getCurrentLicenseServerURL()?.hostname;
    return {
      kind: 'fatal',
      reason,
      ...(host ? { host } : {}),
      message: rejection,
      occurred_at: new Date().toISOString(),
    };
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

    // Persist last_online_check / server_time / signed_token for offline grace.
    // server omits `online_check_token` on revoked responses (deliberate D4
    // server behaviour — see server/license-api/src/routes/refresh.js), so the
    // write only happens on the non-revoked branch.
    //
    // When the server response has no token (pre-D4 deployment OR token
    // signing failed on the server), `online_check_token` is undefined and
    // online-check-store omits the `signed_token` field while still bumping
    // `last_online_check` + `server_time` so legacy Path B keeps working.
    writeOnlineCheck(this.configDir, refreshData.server_time, refreshData.online_check_token);

    // Recovery path: a successful refresh clears both the fatal record and
    // the transient cooldown so the next invocation refreshes on schedule.
    // Best-effort — failures here don't block authorization.
    try {
      clearFatal(this.configDir);
      clearRefreshState(this.configDir);
    } catch (e) {
      serviceLogger.warn('LicenseService.refresh: failed to clear fatal/refresh-state', {
        error: String(e),
      });
    }

    await this._applyRefreshNotRevoked(licenseFile, meta, now);
    this._scheduleNextRefresh(hostEnv.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
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
      const fp = await _collectFingerprintWithOverride(this.configDir).catch(() => null);
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
      // v2 product/version compatibility check (RFC-002). v1 payloads
      // pass through unconditionally per legacy tolerance.
      const compat = checkProductCompatibility(result.license);
      if (compat.skipped && compat.warn) {
        serviceLogger.warn(compat.warn);
      }
      if (!compat.ok) {
        // Type narrowing: v2-only reason implies license is v2.
        const license = result.license;
        const hostIdent = getHostProductIdentity();
        const productCompat =
          license.version === 2 && hostIdent
            ? {
                licenseProduct: license.product,
                licenseProductVersion: license.product_version,
                hostProduct: hostIdent.product,
                hostVersion: hostIdent.version,
              }
            : undefined;
        return {
          state: 'error',
          reason: compat.reason ?? 'product_mismatch',
          details: compat.detail,
          license,
          ...(productCompat ? { productCompat } : {}),
        };
      }
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
