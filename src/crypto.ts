/**
 * ECDSA P-256 license cryptography.
 *
 * Ported byte-equivalent from CortexDev-Agents/src/main/core/license/crypto.ts.
 * The only changes are decoupling from Electron and from the host project's
 * logger / userEnv utilities:
 *   - `app.isPackaged` → an injectable `setProductionBuildResolver()`.
 *   - `@main/lib/logger` → an injectable `setLogger()` with a no-op default.
 *   - `@main/utils/userEnv.getHomeDir` → `node:os.homedir()`.
 *
 * SECURITY CONSTRAINTS (unchanged):
 * - Only Node.js built-in `node:crypto` is used — no third-party crypto libs.
 * - Production (packaged) builds use PROD_KEY exclusively. The
 *   CORTEXDEV_PUBLIC_KEY env override is honoured only in non-packaged
 *   development / test runs, so a tampered launcher cannot inject an
 *   attacker-controlled key into a shipped binary.
 *
 * KEY ROTATION POLICY:
 * - DEV_KEY:    public test key, byte-identical to vendor/cortexdev-pro
 *               `dev-keys/dev-public.pem`. Used in dev builds.
 * - PROD_KEY:   current production key, must stay in sync with the CLI's
 *               PROD_KEY constant. Used in packaged builds.
 * - LEGACY_KEYS: previously-shipped production keys retained during a
 *                migration window so users with licenses signed by older
 *                prod keys are not abruptly locked out. See LEGACY_KEY_SUNSET
 *                for the planned removal date.
 */

import { verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LicensePayload } from './types.js';

// ---------------------------------------------------------------------------
// Host-injected dependencies (replaces electron.app and the host logger)
// ---------------------------------------------------------------------------

/**
 * Resolver telling crypto.ts whether this process is running from a packaged
 * production build. Defaults to `false` so unit tests and dev launchers behave
 * correctly out of the box; production hosts (Electron main process, packaged
 * CLI) must call `setProductionBuildResolver(() => app.isPackaged)` (or
 * equivalent) at startup.
 */
let productionBuildResolver: () => boolean = () => false;

export function setProductionBuildResolver(fn: () => boolean): void {
  productionBuildResolver = fn;
}

/**
 * Minimal logger interface. Only `debug` is used here, but we accept a full
 * shape so existing host loggers can be passed in unchanged.
 */
export interface CryptoLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

let logger: CryptoLogger = {
  debug: () => {
    /* no-op */
  },
};

export function setLogger(impl: CryptoLogger): void {
  logger = impl;
}

// ---------------------------------------------------------------------------
// Canonicalization (deterministic JSON, identical to cortexdev-pro CLI)
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys to produce a deterministic JSON representation.
 * Arrays are preserved in their original order; object keys are sorted.
 *
 * This must stay byte-for-byte identical to the `canonicalize()` function in
 * `vendor/cortexdev-pro/packages/core/src/license/crypto.js`.
 */
export function canonicalize(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  return Object.keys(obj as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalize((obj as Record<string, unknown>)[key]);
      return acc;
    }, {});
}

// ---------------------------------------------------------------------------
// Embedded public keys
// ---------------------------------------------------------------------------

/**
 * Public dev keypair. Byte-identical to vendor/cortexdev-pro/dev-keys/dev-public.pem.
 * Public test material — leak has zero impact on production licensing because
 * packaged prod builds never honour this key.
 */
const DEV_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfWRU7Mo5xInqF55J1fH/qfGxlYmC
9B+S9QSUPXeZ3FGHKMvgNXb21dJr2Q7lxJ1I1B4FU8EhD3QSC4jRIhJ3gg==
-----END PUBLIC KEY-----`;

/**
 * Current production public key. Must stay byte-identical to the CLI's
 * PROD_KEY constant in `vendor/cortexdev-pro/packages/core/src/license/crypto.js`.
 */
const PROD_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqngbja1JXeaGl9GQTPH3Tz3rsJr9
vA3/ulccFmPcoerQU5hzZ+VCke3PVTdCBZtucJICzdiTxmjaKm5eGC7SDg==
-----END PUBLIC KEY-----`;

/**
 * Sunset date for legacy prod keys. After this date, licenses signed by any
 * key in LEGACY_KEYS should be rejected — drop the entries and ship a new
 * release. Telemetry on legacy hits guides whether the window can close
 * earlier or needs an extension.
 *
 * Format is ISO-8601 calendar date (YYYY-MM-DD). It is parsed as UTC midnight
 * by `isLegacyWindowOpen()` so DST and local-timezone drift cannot keep the
 * window open past the intended cutoff.
 */
export const LEGACY_KEY_SUNSET = '2026-11-15'; // 6 months from rollout (2026-05-15)

/**
 * Returns `true` while the legacy-key migration window is still open, i.e.
 * the current wall-clock time is at or before LEGACY_KEY_SUNSET (UTC 00:00).
 */
function isLegacyWindowOpen(): boolean {
  const sunsetMs = Date.parse(`${LEGACY_KEY_SUNSET}T00:00:00Z`);
  if (Number.isNaN(sunsetMs)) {
    return false;
  }
  return Date.now() <= sunsetMs;
}

/**
 * Previous production public keys retained during the migration window so
 * existing user licenses keep verifying after a key rotation.
 */
const LEGACY_KEYS: ReadonlyArray<{ key: string; label: string; note: string }> = [
  {
    label: 'gui-original-EF14',
    note:
      'GUI BUNDLED_KEY shipped from initial license-module rollout (PR #106) ' +
      'until the 2026-05-15 alignment with the CLI. Sunset: ' +
      LEGACY_KEY_SUNSET,
    key: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEF14BAR4ML12SRd7KFf2ICiGZw8Bl
i0JNSBDzrcbI/+ohbtMiW0l5vtzwqt6t7jDeruQ5B+Pdcm1lPwjQnU7Rpg==
-----END PUBLIC KEY-----`,
  },
  {
    label: 'cli-prepatch7-E40v',
    note:
      'CLI BUNDLED_KEY in cortexdev-pro v2.1.119-patch.7 series (the value ' +
      'GUI was aligned to in commit 658548d4). Sunset: ' +
      LEGACY_KEY_SUNSET,
    key: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE40vKJoEguI7RZVEQF2akpps9su5N
co+Zl+cp5mMRPZgwD5+0Q8xzCkrb2k6UvEMsDR5ccGdrAzoRHl9Xx4RR6A==
-----END PUBLIC KEY-----`,
  },
] as const;

// ---------------------------------------------------------------------------
// Build mode
// ---------------------------------------------------------------------------

function isProductionBuild(): boolean {
  return productionBuildResolver();
}

// ---------------------------------------------------------------------------
// Public-key resolution
// ---------------------------------------------------------------------------

/**
 * Return the *primary* public key for license verification.
 *
 * Resolution order:
 * 1. Dev/test only: `CORTEXDEV_PUBLIC_KEY` env var if non-empty.
 *    Packaged builds NEVER honour the override regardless of any env-var
 *    combination, so a tampered launcher cannot inject an attacker key.
 * 2. Dev/test only: `~/.cortexdev-pro/license-keys/public.pem` if present.
 *    Allows developers whose CLI generated a local keypair to use the host
 *    without any manual env-var configuration.
 * 3. Dev/test default: DEV_KEY.
 * 4. Production: PROD_KEY.
 */
export function getPublicKey(): string {
  if (!isProductionBuild()) {
    const nodeEnv = process.env.NODE_ENV;
    const overrideAllowed =
      nodeEnv === 'development' || nodeEnv === 'test' || nodeEnv === undefined;
    if (process.env.CORTEXDEV_PUBLIC_KEY && overrideAllowed) {
      return process.env.CORTEXDEV_PUBLIC_KEY;
    }
    // Auto-discover the CLI's locally-generated public key so developers
    // don't need to set CORTEXDEV_PUBLIC_KEY manually after running keygen.
    // Skip in explicit test runs to keep unit tests hermetic.
    if (overrideAllowed && nodeEnv !== 'test') {
      const configDir =
        process.env['CORTEXDEV_CONFIG_DIR'] ??
        process.env['CORTEXDEV_PRO_CONFIG_DIR'] ??
        join(homedir(), '.cortexdev-pro');
      const localKeyPath = join(configDir, 'license-keys', 'public.pem');
      if (existsSync(localKeyPath)) {
        try {
          const raw = readFileSync(localKeyPath, 'utf8');
          if (raw.includes('BEGIN PUBLIC KEY')) {
            return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          }
          logger.debug('getPublicKey: local key file found but contains no PEM header', {
            localKeyPath,
          });
        } catch (e) {
          logger.debug('getPublicKey: failed to read local key file, falling back to DEV_KEY', {
            localKeyPath,
            error: String(e),
          });
        }
      }
    }
    return DEV_KEY;
  }
  return PROD_KEY;
}

/**
 * Optional hook fired when verifySignature() succeeds against a LEGACY key
 * rather than the primary key. Wire telemetry / logger here at the callsite —
 * kept as a settable callback to avoid a circular import.
 */
let legacyKeyHitListener: ((label: string) => void) | null = null;

export function setLegacyKeyHitListener(fn: ((label: string) => void) | null): void {
  legacyKeyHitListener = fn;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifyOnce(payload: LicensePayload, signatureBase64: string, publicKey: string): boolean {
  try {
    const data = Buffer.from(JSON.stringify(canonicalize(payload)), 'utf8');
    const signature = Buffer.from(signatureBase64, 'base64');
    return verify('SHA256', data, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Verify an ECDSA-SHA256 signature over a license payload.
 *
 * Tries the primary key first (DEV in dev builds, PROD in packaged builds),
 * then — for packaged builds during the migration window — falls back to
 * keys in LEGACY_KEYS. A successful legacy match fires
 * `legacyKeyHitListener` so the caller can record a warning / telemetry
 * event. Dev builds never consult LEGACY_KEYS.
 */
export function verifySignature(
  payload: LicensePayload,
  signatureBase64: string,
  publicKey?: string
): boolean {
  if (publicKey !== undefined) {
    return verifyOnce(payload, signatureBase64, publicKey);
  }

  const primary = getPublicKey();
  if (verifyOnce(payload, signatureBase64, primary)) {
    return true;
  }

  // Legacy fallback only in packaged production builds.
  if (!isProductionBuild()) {
    return false;
  }

  // After LEGACY_KEY_SUNSET passes, stop honouring legacy keys.
  if (!isLegacyWindowOpen()) {
    return false;
  }

  for (const entry of LEGACY_KEYS) {
    if (verifyOnce(payload, signatureBase64, entry.key)) {
      legacyKeyHitListener?.(entry.label);
      return true;
    }
  }
  return false;
}

// Exported for tests / diagnostics — never imported by production callsites.
export const _internal = { DEV_KEY, PROD_KEY, LEGACY_KEYS };
