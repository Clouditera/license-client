/**
 * @clouditera/license-mgr
 *
 * Standalone license management module shared by DevAgent-App, DevAgent-CLI,
 * DevEye, DevEyeProd and future Clouditera products.
 *
 * The package is decoupled from Electron, `@shared/*` and `@main/*` via a set
 * of module-level injection setters (see README). Hosts wire up their concrete
 * implementations at startup; everything else uses safe defaults.
 *
 * V1.0.0-alpha.0 — initial port from CortexDev-Agents src/main/core/license/.
 */

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

export { err, ok } from './result.js';
export type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Shared license types
// ---------------------------------------------------------------------------

export type {
  ActivationMeta,
  ActivationResult,
  FatalRecord,
  FingerprintResult,
  LicenseErrorReason,
  LicenseExpiredReason,
  LicenseFile,
  LicensePayload,
  LicenseStatus,
  OfflineGraceResult,
  OnlineCheckFile,
  OnlineCheckVerdict,
  RefreshOutcome,
  RefreshRejectionReason,
  RefreshStateRecord,
  ServerStatus,
  SignedToken,
} from './types.js';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

export { isExpired, isExpiredWithServerTime, validatePayload } from './schema.js';
export type { ValidationResult } from './schema.js';

// ---------------------------------------------------------------------------
// Token key (D4 trust root for online_check_token verification)
// ---------------------------------------------------------------------------

export {
  DEV_TOKEN_KEY,
  EMBEDDED_TOKEN_PUBLIC_KEY,
  PROD_TOKEN_KEY,
  publicKeysEqual,
} from './token-key.js';

// ---------------------------------------------------------------------------
// Online-check token verification (D4 — server-signed offline grace)
// ---------------------------------------------------------------------------

export { verifyOnlineCheckToken } from './online-check.js';

// ---------------------------------------------------------------------------
// Online-check persistence (online-check.json on disk)
// ---------------------------------------------------------------------------

export { readOnlineCheck, writeOnlineCheck } from './online-check-store.js';

// ---------------------------------------------------------------------------
// Crypto (signature verification + key resolution)
// ---------------------------------------------------------------------------

export {
  canonicalize,
  getPublicKey,
  isProductionBuild,
  LEGACY_KEY_SUNSET,
  setLegacyKeyHitListener,
  setLogger,
  setProductionBuildResolver,
  verifySignature,
  _internal as _cryptoInternal,
} from './crypto.js';
export type { CryptoLogger } from './crypto.js';

// ---------------------------------------------------------------------------
// Device fingerprint
// ---------------------------------------------------------------------------

export {
  collectFingerprint,
  collectFingerprintComponents,
  matchFingerprint,
  setFingerprintCollector,
} from './fingerprint.js';
export type { FingerprintComponents } from './fingerprint.js';
export type { FingerprintCollector } from './fingerprint.js';

// ---------------------------------------------------------------------------
// Persistence (license + activation-meta on disk)
// ---------------------------------------------------------------------------

export {
  deleteLicense,
  getLicenseDir,
  readActivationMeta,
  readLicense,
  resolveConfigDir,
  writeActivationMeta,
  writeLicense,
} from './store.js';

// ---------------------------------------------------------------------------
// Validator pipeline
// ---------------------------------------------------------------------------

export { validateLicense } from './validator.js';
export type { ValidateLicenseOptions, ValidateResult } from './validator.js';

// ---------------------------------------------------------------------------
// Online client (activate / refresh against license server)
// ---------------------------------------------------------------------------

export {
  onlineActivate,
  onlineRefresh,
  setOnlineClientLogger,
  getCurrentLicenseServerURL,
  ALLOWED_LICENSE_HOSTS,
} from './online-client.js';
export type {
  ActivateRequest,
  ActivateResponse,
  OnlineClientError,
  RefreshRequest,
  RefreshResponse,
} from './online-client.js';

// ---------------------------------------------------------------------------
// Fatal-state (CLI-parity: 24h grace after authoritative server reject)
// ---------------------------------------------------------------------------

export {
  FATAL_GRACE_MS,
  clearFatal,
  fatalGraceRemainingHours,
  isFatalExpired,
  readFatal,
  writeFatal,
} from './fatal-state.js';

// ---------------------------------------------------------------------------
// Refresh-state (CLI-parity D5: transient cooldown to avoid startup latency)
// ---------------------------------------------------------------------------

export {
  REFRESH_COOLDOWN_MS,
  clearRefreshState,
  isWithinCooldown,
  readRefreshState,
  writeRefreshState,
} from './refresh-state.js';

// ---------------------------------------------------------------------------
// LicenseService (top-level orchestrator)
// ---------------------------------------------------------------------------

export {
  LicenseService,
  licenseService,
  setBinaryDownloadHooks,
  setHostEnvironment,
  setServiceLogger,
} from './license-service.js';
export type { BinaryDownloadHooks, HostEnvironment, ServiceLogger } from './license-service.js';

export const VERSION = '1.0.0-alpha.6';
