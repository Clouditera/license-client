/**
 * HTTP client for the CortexDev Pro license API.
 *
 * Ported byte-equivalent from CortexDev-Agents/src/main/core/license/online-client.ts
 * with D4 + R1 hardening:
 *   - `ALLOWED_LICENSE_HOSTS` hostname allowlist (matches CLI server-url.js
 *     byte-equivalent) — refuses non-allowlisted hostnames so a tampered env
 *     var cannot redirect activation to evil.attacker.com.
 *   - Env-name compatibility: `CORTEXDEV_LICENSE_API_URL` takes precedence;
 *     legacy `CORTEXDEV_LICENSE_SERVER` is still honoured with a deprecation
 *     warning. Per docs/d4-design.md §4.2 Q-2=B: removal in v1.1.
 *   - Default base URL aligns with CLI legacy `https://license.clouditera.online/api/v1`
 *     (base contains `/api/v1`, request path uses `/activate` / `/refresh`).
 *   - `ActivateResponse` / `RefreshResponse` carry the optional D4
 *     `online_check_token` field.
 *
 * Endpoints (relative to base):
 *   POST /activate  — register a device when a license is first activated
 *   POST /refresh   — check revocation status and update last_seen
 *
 * All functions return a `Result` — they never throw. Network errors,
 * allowlist refusals and unexpected HTTP responses are folded into typed
 * `OnlineClientError` values.
 *
 * SECURITY: This module is intended to run in the host process (Electron main,
 * or a CLI). Renderer / UI processes must reach it through the host's IPC
 * layer rather than calling fetch on the license server directly.
 */

import { err, ok, type Result } from './result.js';
import type { SignedToken } from './types.js';

// ---------------------------------------------------------------------------
// Logger injection (mirrors crypto.ts pattern — no module-level side effects)
// ---------------------------------------------------------------------------

interface OnlineClientLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

let logger: OnlineClientLogger = { warn: () => undefined };

export function setOnlineClientLogger(impl: OnlineClientLogger): void {
  logger = impl;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Production base URL — includes `/api/v1` so request paths can stay short
 * (`/activate`, `/refresh`) and match CLI legacy fetch sites byte-for-byte.
 * Migrated from `license.cloudrouter.online` on 2026-06-14; both domains
 * remain live during transition (CLI allowlist already covers both).
 */
const PRODUCTION_BASE_URL = 'https://license.clouditera.online/api/v1';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Domain pinning. Mirrors CLI `packages/core/src/license/server-url.js
 * ALLOWED_LICENSE_HOSTS` so a tampered launcher / env var cannot redirect
 * activation traffic to an attacker-controlled host. Renderer / UI hosts
 * MUST NOT bypass this check.
 *
 * Keep byte-aligned with CLI; both files must agree on the production +
 * staging hostnames.
 */
export const ALLOWED_LICENSE_HOSTS: ReadonlySet<string> = new Set([
  'license.devagent.io',
  'license.clouditera.com',
  'license.clouditera.online',
  'devagent-license-api.clouditera2026.workers.dev',
  'devagent-license-api-staging.clouditera2026.workers.dev',
  'devagent-license-api-staging.kangkangli.workers.dev',
  // China proxy domains (license-api-cn-proxy)
  'license.cloudrouter.online',
  'license-staging.cloudrouter.online',
  // Local dev
  'localhost',
  '127.0.0.1',
]);

/**
 * Resolve the base URL from env vars with legacy-name compatibility.
 *
 * Order (high to low priority):
 *   1. `CORTEXDEV_LICENSE_API_URL` (canonical, current)
 *   2. `CORTEXDEV_LICENSE_SERVER`  (legacy, emits deprecation warn; removal in v1.1)
 *   3. `PRODUCTION_BASE_URL` default
 */
function getBaseUrl(): string {
  const newName = process.env['CORTEXDEV_LICENSE_API_URL'];
  if (newName) return newName;

  const legacyName = process.env['CORTEXDEV_LICENSE_SERVER'];
  if (legacyName) {
    logger.warn(
      'CORTEXDEV_LICENSE_SERVER is deprecated and will be removed in v1.1. Use CORTEXDEV_LICENSE_API_URL.',
      { resolved: legacyName }
    );
    return legacyName;
  }

  return PRODUCTION_BASE_URL;
}

/**
 * Enforce HTTPS + allowlist on the resolved base URL. Throws synchronously
 * because misconfigured env vars are a startup-time configuration error, not
 * a runtime network condition — matching CLI `resolveLicenseServerURL()`
 * behaviour.
 *
 * Localhost / 127.0.0.1 are permitted over plain http for dev convenience
 * (same exception CLI carries).
 */
function assertAllowedUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    throw new Error(
      `[license/online-client] Invalid CORTEXDEV_LICENSE_API_URL: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new Error('[license/online-client] License server URL must use HTTPS protocol');
  }
  if (!ALLOWED_LICENSE_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `[license/online-client] License server domain not allowed: ${parsed.hostname}`
    );
  }
  return parsed;
}

/**
 * Resolve the base URL exactly as `post()` does (env → default), then enforce
 * HTTPS + allowlist. Public so adapters can pin `ActivationMeta.issued_server`
 * to the same value the next /refresh call will hit, and so the initialize
 * gate can detect `server_mismatch` before any network traffic.
 *
 * Returns `null` when env points at a URL that fails HTTPS/allowlist — the
 * gate is responsible for surfacing the configuration error, but should not
 * crash. (Mirrors CLI `gate.js` swallowing of `resolveLicenseServerURL()`
 * throws into a `currentServer = null` branch.)
 */
export function getCurrentLicenseServerURL(): { url: string; hostname: string } | null {
  try {
    const raw = getBaseUrl();
    const parsed = assertAllowedUrl(raw);
    return { url: raw, hostname: parsed.hostname };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all possible online-client failure modes.
 * Each variant maps to a distinct user-visible error message.
 */
export type OnlineClientError =
  | {
      /** A transport-level failure: DNS, TCP, timeout, AbortError, etc. */
      type: 'network_error';
      message: string;
    }
  | {
      /** An unexpected non-2xx HTTP response not covered by specific variants. */
      type: 'api_error';
      status: number;
      code: string;
      message: string;
    }
  | {
      /** HTTP 409 DEVICE_LIMIT_EXCEEDED — this license is already bound to max devices. */
      type: 'device_limit_exceeded';
    }
  | {
      /** HTTP 403 LICENSE_REVOKED — this license has been administratively revoked. */
      type: 'license_revoked';
    }
  | {
      /** HTTP 404 NOT_FOUND — the license_id is not registered server-side. */
      type: 'not_found';
    };

// ---------------------------------------------------------------------------
// Request / Response types (matching license-api server contracts)
// ---------------------------------------------------------------------------

export interface ActivateRequest {
  license_id: string;
  fingerprint: string;
  activation_id: string;
  client_version?: string;
}

export interface ActivateResponse {
  status: 'activated';
  server_time: string;
  activation_id: string;
  /**
   * D4 server-signed offline-grace assertion. Optional because pre-D4 server
   * builds (and signing failures within a D4-capable server) omit the field
   * entirely. Clients store this in `online-check.json` for offline Path A.
   */
  online_check_token?: SignedToken;
}

export interface RefreshRequest {
  license_id: string;
  activation_id: string;
}

export interface RefreshResponse {
  revoked: boolean;
  server_time: string;
  revoked_at?: string | null;
  reason?: string | null;
  /** Currently always null (server does not re-sign). */
  license: null;
  /**
   * D4 server-signed offline-grace assertion. Server omits this on revoked
   * responses (cf. server route refresh.js — revoked sessions must not be
   * granted continued offline use).
   */
  online_check_token?: SignedToken;
}

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

interface ApiSuccessEnvelope<T> {
  data: T;
}

/**
 * Current server error envelope (Cloudflare Worker, alpha.2+):
 *
 *   { "ok": false, "error": { "code": "BAD_REQUEST", "message": "..." } }
 *
 * Older deployments / shim layers historically returned the flat shape
 *
 *   { "error": "BAD_REQUEST", "message": "..." }
 *
 * `normalizeErrorEnvelope` accepts both so a server-side rollback (or a
 * proxy that doesn't preserve nesting) cannot wedge the client into a
 * "no error code at all" state.
 *
 * Without this normalisation step the code path `errorBody.error === '...'`
 * compares a string against an object, returns false silently, and the
 * `device_limit_exceeded` / `license_revoked` branches NEVER fire — every
 * 409 / 403 collapses into the generic `api_error` variant. See License-Mgr#1.
 */
interface NormalizedErrorEnvelope {
  code: string;
  message: string;
}

function normalizeErrorEnvelope(raw: unknown): NormalizedErrorEnvelope {
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;

    // Shape A (current): { ok: false, error: { code, message } }
    if (obj['error'] !== null && typeof obj['error'] === 'object' && !Array.isArray(obj['error'])) {
      const inner = obj['error'] as Record<string, unknown>;
      const code = typeof inner['code'] === 'string' ? inner['code'] : 'UNKNOWN';
      const message = typeof inner['message'] === 'string' ? inner['message'] : 'Unknown error';
      return { code, message };
    }

    // Shape B (legacy): { error: 'CODE', message: '...' }
    if (typeof obj['error'] === 'string') {
      return {
        code: obj['error'],
        message: typeof obj['message'] === 'string' ? obj['message'] : 'Unknown error',
      };
    }
  }

  return { code: 'UNKNOWN', message: 'Unknown error' };
}

/**
 * Execute a POST request against the license API with a 10-second timeout.
 * Returns a typed Result; never throws on network conditions. Throws ONLY on
 * env-var misconfiguration (invalid URL / non-HTTPS / disallowed host) since
 * those are startup-time errors that callers should surface to the user
 * rather than silently retry.
 */
async function post<TResponse>(
  path: string,
  body: unknown
): Promise<Result<TResponse, OnlineClientError>> {
  const base = getBaseUrl();
  assertAllowedUrl(base); // throws synchronously on misconfig
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timerId);

    if (response.ok) {
      try {
        const envelope = (await response.json()) as ApiSuccessEnvelope<TResponse> | TResponse;
        const data =
          envelope !== null &&
          typeof envelope === 'object' &&
          'data' in (envelope as Record<string, unknown>)
            ? (envelope as ApiSuccessEnvelope<TResponse>).data
            : (envelope as TResponse);
        return ok(data);
      } catch (e) {
        return err({
          type: 'api_error',
          status: response.status,
          code: 'INVALID_SUCCESS_PAYLOAD',
          message: e instanceof Error ? e.message : String(e),
        } as const);
      }
    }

    let errorBody: NormalizedErrorEnvelope = { code: 'UNKNOWN', message: 'Unknown error' };
    try {
      errorBody = normalizeErrorEnvelope(await response.json());
    } catch {
      // ignore parse failure
    }

    if (response.status === 409 && errorBody.code === 'DEVICE_LIMIT_EXCEEDED') {
      return err({ type: 'device_limit_exceeded' } as const);
    }
    if (response.status === 403 && errorBody.code === 'LICENSE_REVOKED') {
      return err({ type: 'license_revoked' } as const);
    }
    if (response.status === 404) {
      return err({ type: 'not_found' } as const);
    }

    return err({
      type: 'api_error',
      status: response.status,
      code: errorBody.code,
      message: errorBody.message,
    } as const);
  } catch (e) {
    clearTimeout(timerId);
    return err({
      type: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    } as const);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call `POST /activate` to register this device with the license server.
 * Wire URL = `${baseUrl}/activate`; baseUrl already contains `/api/v1`.
 */
export async function onlineActivate(
  req: ActivateRequest
): Promise<Result<ActivateResponse, OnlineClientError>> {
  return post<ActivateResponse>('/activate', req);
}

/**
 * Call `POST /refresh` to check for revocation and update `last_seen`.
 */
export async function onlineRefresh(
  req: RefreshRequest
): Promise<Result<RefreshResponse, OnlineClientError>> {
  return post<RefreshResponse>('/refresh', req);
}
