/**
 * TypeScript type definitions for the license-client system.
 *
 * Ported from CortexDev-Agents/src/main/core/license/types.ts and
 * vendor/cortexdev-pro/packages/core/src/license/ — kept byte-compatible with
 * the existing license format so all in-the-field licenses continue to validate
 * after consumers switch from the embedded implementation to @clouditera/
 * license-client.
 *
 * SECURITY: All license validation logic runs exclusively in the host process
 * (Electron main, or a CLI process). When a consumer surfaces status to a
 * sandboxed UI (e.g. an Electron renderer), it must forward only `LicenseStatus`
 * over IPC — never the raw `LicenseFile` or its private fields.
 */

// ---------------------------------------------------------------------------
// License payload (the signed portion of a license file)
// ---------------------------------------------------------------------------

/**
 * The data payload embedded inside a license file and covered by the ECDSA
 * signature. Field order and key naming must match the signing tool exactly
 * because the signature is computed over the canonicalized JSON.
 */
export interface LicensePayload {
  /** Schema version. Always 1 for current format. */
  version: 1;
  /** License type — 'pro' for paid, 'free' for open. */
  type: 'pro' | 'free';
  /** Unique identifier for this license (UUID). */
  license_id: string;
  /** Display name of the license holder. */
  user: string;
  /** Email address of the license holder. */
  email: string;
  /**
   * Device fingerprint bound to this license (64-char lowercase hex SHA-256).
   * Must be null for 'free' licenses.
   */
  fingerprint: string | null;
  /** ISO-8601 timestamp when the license was issued. */
  issued_at: string;
  /**
   * ISO-8601 timestamp when the license expires.
   * Must be null for 'free' licenses; required for 'pro'.
   */
  expires_at: string | null;
  /** Feature flags granted by this license. */
  features: string[];
}

// ---------------------------------------------------------------------------
// License file (payload + signature, stored on disk)
// ---------------------------------------------------------------------------

/**
 * The full license file structure written to
 * `{configDir}/license/license.json`. Compatible with the legacy DevAgent-App
 * and DevAgent-CLI embedded implementations.
 */
export interface LicenseFile {
  /** The data payload covered by the ECDSA signature. */
  payload: LicensePayload;
  /** Base64-encoded ECDSA-SHA256 signature over the canonicalized payload. */
  signature: string;
}

// ---------------------------------------------------------------------------
// Activation metadata (persisted separately to track anti-tamper state)
// ---------------------------------------------------------------------------

/**
 * Snapshot of the last server refresh response, stored alongside activation
 * metadata. Used to track revocation state across restarts.
 */
export interface ServerStatus {
  /** Whether the server has revoked this license. */
  revoked: boolean;
  /** ISO-8601 server timestamp from the refresh response. */
  server_time: string;
  /** ISO-8601 timestamp when the license was revoked (if revoked). */
  revoked_at?: string | null;
  /** Reason for revocation (e.g. "admin_revocation"). */
  reason?: string | null;
  /** ISO-8601 client-side timestamp when this refresh was recorded. */
  checked_at: string;
}

/**
 * Metadata written to `{configDir}/license/activation.json` on each
 * successful validation. Used for clock-tamper detection and online refresh
 * state tracking.
 */
export interface ActivationMeta {
  /** ISO-8601 timestamp of the last successful validation. */
  last_verified_at: string;
  /** Device fingerprint collected at activation time. */
  fingerprint_at_activation?: string;
  /** ISO-8601 timestamp when the user first activated. */
  activated_at?: string;
  /**
   * UUID v4 assigned at first online activation. Persisted here and reused
   * for all subsequent /api/v1/refresh calls so the server can track this
   * specific device registration.
   */
  activation_id?: string;
  /**
   * Snapshot of the most recent /api/v1/refresh response. Used to restore
   * revocation state after an app restart without requiring a network call.
   */
  server_status?: ServerStatus;
  /**
   * ISO-8601 timestamp of the last successful /refresh round-trip. Drives the
   * steady-state refresh cadence in callers that schedule their own timers
   * (CLI gate). Distinct from `last_verified_at` which tracks any successful
   * validation (including offline).
   */
  last_refresh?: string;
  /**
   * Fully-resolved license server URL that issued this activation.
   *
   * Used by `initialize()` to detect cross-environment misuse (`server_mismatch`)
   * — if the env now resolves to a different host, calling `/refresh` would
   * pollute the wrong KV store with this license's traffic. Adapters populate
   * this on first online activation; legacy v1 records without the field skip
   * the check (back-fillable via separate migration).
   */
  issued_server?: string;
  /**
   * Schema version of this activation record. Absent / 1 = legacy; 2 carries
   * `issued_server` reliably. Adapters writing fresh records set this to 2 so
   * the gate can rely on the field.
   */
  schema_version?: number;
}

// ---------------------------------------------------------------------------
// Fatal refresh record (last-fatal.json)
// ---------------------------------------------------------------------------

/**
 * On-disk shape of `{configDir}/license/last-fatal.json` — the persistent
 * record of the most recent authoritative server reject (HTTP 404 / 4xx /
 * payload integrity failure).
 *
 * Mirrors the CLI legacy `gate.js: writeFatal(...)` shape so adapters can
 * surface the same `printLockoutBox('fatal_refresh_failure')` payload without
 * a translation layer. Within `FATAL_GRACE_MS` (24h) of `occurred_at`, the
 * gate emits a warning banner but still authorizes the session; after the
 * grace window the gate hard-blocks.
 *
 * Distinct from the offline-grace window: that one is for *transient*
 * network failures. `last-fatal.json` only ever records *authoritative*
 * rejections (the server actually replied "no").
 */
export interface FatalRecord {
  /** Mirror of CLI `kind` discriminator — always `'fatal'`. */
  kind: 'fatal';
  /** Why the server rejected. Drives the lockout box copy. */
  reason: 'not_found' | 'license_invalid' | 'signature_mismatch' | 'id_mismatch';
  /** Best-effort hostname extracted from the resolved license server URL. */
  host?: string;
  /** HTTP status from the failing response, when one is available. */
  httpStatus?: number;
  /** Human-readable message for the lockout box (NOT shown to the user verbatim). */
  message?: string;
  /** ISO-8601 timestamp recorded when the fatal *first* occurred (grace anchor). */
  occurred_at: string;
}

// ---------------------------------------------------------------------------
// Refresh-state record (refresh-state.json)
// ---------------------------------------------------------------------------

/**
 * On-disk shape of `{configDir}/license/refresh-state.json` — D5 transient
 * cooldown record.
 *
 * When `/refresh` hits a transient failure (network / 429 / 5xx), the next
 * `REFRESH_COOLDOWN_MS` window skips the online attempt entirely so a slow
 * or flapping server cannot pile latency onto every CLI startup. Successful
 * refresh clears this record.
 *
 * Only `kind: 'transient'` is currently written; the discriminator is kept so
 * future CLI fail modes (rate-limited / circuit-open) can extend without a
 * file-schema break.
 */
export interface RefreshStateRecord {
  kind: 'transient';
  /** ISO-8601 timestamp of the last transient attempt — the cooldown anchor. */
  last_attempt: string;
  host?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// License status (the public view exposed to consumers / forwarded via IPC)
// ---------------------------------------------------------------------------

/**
 * Reason why an active license has reached the 'expired' state.
 * - `license_expired`: the license's own `expires_at` date has passed.
 * - `offline_grace_exceeded`: the device has been offline for > 14 days.
 */
export type LicenseExpiredReason = 'license_expired' | 'offline_grace_exceeded';

/**
 * Discriminated union representing the current license state.
 *
 * Extended states (online integration):
 * - `active.serverRevoked`: server has flagged revocation; current session
 *   continues but next restart will yield `revoked`.
 * - `active.offlineWarningDaysLeft`: device is approaching the 14-day offline
 *   grace limit (< 3 days remain).
 * - `revoked`: license was revoked server-side and a restart has occurred.
 */
export type LicenseStatus =
  | { state: 'unlicensed' }
  | { state: 'validating' }
  | {
      state: 'active';
      license: LicensePayload;
      /** True when the server has revoked this license; current session runs to completion. */
      serverRevoked?: boolean;
      /** Days remaining before the 14-day offline grace period expires (shown < 3 days). */
      offlineWarningDaysLeft?: number;
    }
  | { state: 'expired'; license: LicensePayload; reason: LicenseExpiredReason }
  | { state: 'revoked'; license: LicensePayload }
  | {
      state: 'error';
      reason: LicenseErrorReason;
      details?: string;
      /**
       * The license payload that was on-disk when the error was raised. Carried
       * so the lockout box can render contextual info (license_id, expires_at,
       * mismatch hosts). Absent when the error fired before validation —
       * e.g. `file_corrupt` from an unreadable license.json.
       */
      license?: LicensePayload;
      /**
       * Server-side fatal record. Present when `reason === 'fatal_refresh_failure'`
       * so the lockout box can show reason / host / httpStatus / remaining grace.
       */
      fatal?: FatalRecord;
      /**
       * Activation / runtime server URL mismatch. Present when
       * `reason === 'server_mismatch'`. `issued` is the server pinned at
       * activation; `current` is what the env now resolves to.
       */
      mismatch?: { issued: string; current: string };
    };

// ---------------------------------------------------------------------------
// Error reasons
// ---------------------------------------------------------------------------

/**
 * All possible reasons why license validation can fail.
 * Each reason maps to a distinct i18n key in the host application
 * (typically `license.error_*`).
 */
export type LicenseErrorReason =
  /** The file does not have the expected { payload, signature } shape. */
  | 'invalid_structure'
  /** One or more required fields in the payload are missing or wrong type. */
  | 'invalid_schema'
  /** The ECDSA signature does not match the payload. */
  | 'invalid_signature'
  /** The license fingerprint does not match the current device. */
  | 'fingerprint_mismatch'
  /** Device fingerprint could not be collected (hardware access error). */
  | 'fingerprint_unavailable'
  /** The license has passed its `expires_at` date. */
  | 'expired'
  /** The license file exists but cannot be parsed (corrupt JSON). */
  | 'file_corrupt'
  /**
   * System clock anomaly detected: current time is earlier than
   * `last_verified_at` (clock was set back) or earlier than `issued_at`.
   */
  | 'clock_tamper'
  /**
   * The server rejected online activation because this license is already
   * bound to the maximum number of allowed devices (HTTP 409).
   */
  | 'device_limit_exceeded'
  /**
   * The server reported that this license has been administratively revoked
   * (HTTP 403 during /activate, or `revoked: true` during /refresh).
   */
  | 'server_revoked'
  /**
   * Persistent fatal refresh failure: the server authoritatively rejected
   * the license (404 / 4xx / signature / id) and the 24h emergency grace
   * window from the *first* fatal has elapsed. Carries the `fatal` record
   * on the status so adapters can render the legacy lockout box.
   */
  | 'fatal_refresh_failure'
  /**
   * The license server URL the host now resolves to differs from the one
   * pinned at activation (`ActivationMeta.issued_server`). Calling /refresh
   * against the new server would pollute the wrong KV, so the gate blocks
   * before any network traffic. Carries the `mismatch` payload.
   */
  | 'server_mismatch';

// ---------------------------------------------------------------------------
// Refresh outcome (returned by doRefreshNow → IPC `license.refresh`)
// ---------------------------------------------------------------------------

/**
 * Result of an online refresh attempt, used to drive an accurate user-facing
 * message in the License settings tab "Verify Now" button.
 *
 * History: previously `_doRefresh` only returned a boolean and every failure
 * (transport AND server rejection alike) was folded into the offline-grace
 * path, so a server `not_found` / `revoked` response wrongly surfaced as
 * "Unable to connect to the verification server. Check your network." This
 * type lets the renderer distinguish the three cases.
 *
 * - `ok`             : the server was reached and the license is valid.
 * - `network_error`  : the request never reached the server (DNS/TCP/timeout);
 *                      the offline grace period applies. "Check your network."
 * - `server_rejected`: the server WAS reached and explicitly rejected the
 *                      license (not_found / revoked / device_limit / api_error).
 *                      This is NOT a network problem — the license must be
 *                      re-activated, so offline grace must NOT be applied.
 */
export type RefreshOutcome =
  | { kind: 'ok' }
  | { kind: 'network_error' }
  | { kind: 'server_rejected'; reason: RefreshRejectionReason };

/**
 * Why the server reached a *definitive* decision to reject the license during
 * an online refresh. Maps to a distinct i18n key so the user sees actionable
 * guidance instead of a generic "check your network" message.
 *
 * Note: transient availability failures (transport errors, HTTP 5xx, malformed
 * payloads) are deliberately NOT represented here — they flow through the
 * `network_error` outcome and the offline grace period, because the server
 * never actually rejected the license.
 */
export type RefreshRejectionReason =
  /** HTTP 404 — the license_id is unknown to the server (deleted / never issued). */
  | 'not_found'
  /** `revoked: true` or HTTP 403 — administratively revoked. */
  | 'revoked'
  /** HTTP 409 — bound to the maximum number of devices. */
  | 'device_limit_exceeded';

// ---------------------------------------------------------------------------
// Activation result (returned by LicenseService.activate / activateFromFile)
// ---------------------------------------------------------------------------

/**
 * Result of an activation attempt. Returned by `LicenseService.activate()`.
 */
export interface ActivationResult {
  /** Whether activation succeeded. */
  success: boolean;
  /** The updated license status after activation (present on both success and failure). */
  status?: LicenseStatus;
  /** The specific error reason when `success` is false. */
  error?: LicenseErrorReason;
  /** Human-readable details about the error (for logging, not displayed directly). */
  details?: string;
  /**
   * Whether the activation was successfully registered with the online server.
   * - `true`: /api/v1/activate returned 200.
   * - `false`: network failure occurred; local activation succeeded under offline grace.
   * - `undefined`: online activation was not attempted (e.g. validation failed locally).
   */
  serverSynced?: boolean;
}

// ---------------------------------------------------------------------------
// Fingerprint result
// ---------------------------------------------------------------------------

/**
 * Result returned by `LicenseService.getFingerprint()` (and the IPC channel
 * `license.getFingerprint` in Electron consumers).
 */
export interface FingerprintResult {
  /** 64-character lowercase hex SHA-256 device fingerprint. */
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// D4 — online_check_token (server-signed offline grace assertion)
// ---------------------------------------------------------------------------

/**
 * Server-signed offline grace assertion returned by `/activate` and `/refresh`.
 *
 * Wire format byte-equivalent with the server's `signOnlineCheckToken()` output
 * (devagent-cli/server/license-api/src/lib/token.js): the server computes
 * `canonicalize(payload)` → ECDSA P-256 / SHA-256 sign → P1363→DER → base64,
 * and the client verifies with `node:crypto verify('SHA256', ...)` against
 * `EMBEDDED_TOKEN_PUBLIC_KEY` (token-key.ts, separate trust root from license
 * payload signing).
 */
export interface SignedToken {
  payload: {
    /** Must match the locally-bound license's `license_id` to prevent token reuse. */
    license_id: string;
    /** Server-controlled ISO timestamp; mirrors the value carried by the response envelope. */
    server_time: string;
    /**
     * Server-controlled ISO expiry. Defaults to `server_time + 7d` and is
     * authoritative — any caller-injected `expires_at` is stripped before
     * signing (see server token.js).
     */
    expires_at: string;
  };
  /** Base-64 of the DER-encoded ECDSA signature over `canonicalize(payload)`. */
  signature: string;
}

/**
 * Discriminated outcome of {@link verifyOnlineCheckToken}.
 *
 * Reasons exist independently so the offline-grace caller can distinguish
 * "old/corrupt token file — fall through to legacy Path B" (`malformed`) from
 * hard failures that must NOT slip past the lax legacy path:
 *   - `id_mismatch` — token belongs to a different license_id
 *   - `expired` — token TTL elapsed
 *   - `invalid_signature` — tamper or wrong trust root
 *
 * Conflating these would let an attacker break the signature and fall back
 * into the more permissive Path B window.
 */
export type OnlineCheckVerdict =
  | { valid: true }
  | { valid: false; reason: 'malformed' | 'id_mismatch' | 'expired' | 'invalid_signature' };

/**
 * On-disk shape of `{configDir}/license/online-check.json`.
 *
 * - `last_online_check` is the local wall-clock timestamp when the gate last
 *   recorded an authorised startup. Always present after the first activate.
 * - `server_time` is the most-recent server-issued ISO timestamp echoed back
 *   from `/activate` or `/refresh`. Used by legacy Path B grace calculation.
 * - `signed_token` is the optional server-signed D4 assertion. Omitted when
 *   the server has not yet shipped the token-signing patch so the file stays
 *   interoperable with both older and newer servers.
 */
export interface OnlineCheckFile {
  last_online_check: string;
  server_time?: string;
  signed_token?: SignedToken;
}

/**
 * Result of `LicenseService.checkOfflineGrace()` — mirrors the CLI legacy
 * `gate.js: checkOfflineGrace()` return shape so adapters can map 1:1.
 *
 * `reason` is undefined when `authorized` is true; otherwise it carries the
 * specific failure mode for UI/CLI presentation.
 *
 * `tokenFailure` is populated only when Path A's D4 token verification failed
 * for a non-malformed reason — the caller may want to log or surface "token
 * tampered" vs. plain "offline_expired".
 */
export interface OfflineGraceResult {
  authorized: boolean;
  reason?: 'offline_expired' | 'clock_anomaly';
  daysLeft?: number;
  lastCheck?: string;
  tokenFailure?: 'id_mismatch' | 'expired' | 'invalid_signature';
  source?: 'signed_token' | 'last_online_check';
}
