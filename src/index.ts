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
  FingerprintResult,
  LicenseErrorReason,
  LicenseExpiredReason,
  LicenseFile,
  LicensePayload,
  LicenseStatus,
  RefreshOutcome,
  RefreshRejectionReason,
  ServerStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

export { isExpired, isExpiredWithServerTime, validatePayload } from './schema.js';
export type { ValidationResult } from './schema.js';

// ---------------------------------------------------------------------------
// Crypto (signature verification + key resolution)
// ---------------------------------------------------------------------------

export {
  canonicalize,
  getPublicKey,
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
} from './fingerprint.js';
export type { FingerprintComponents } from './fingerprint.js';

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

export { onlineActivate, onlineRefresh } from './online-client.js';
export type {
  ActivateRequest,
  ActivateResponse,
  OnlineClientError,
  RefreshRequest,
  RefreshResponse,
} from './online-client.js';

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

export const VERSION = '1.0.0-alpha.0';
