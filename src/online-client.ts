/**
 * HTTP client for the CortexDev Pro license API.
 *
 * Ported byte-equivalent from CortexDev-Agents/src/main/core/license/online-client.ts.
 * Changes:
 *   - `@shared/brand.CORTEXDEV_ENV_VARS` → inlined env-var name.
 *   - `@shared/result.{ok, err, Result}` → local `./result.js`.
 *
 * Endpoints:
 *   POST /api/v1/activate  — register a device when a license is first activated
 *   POST /api/v1/refresh   — check revocation status and update last_seen
 *
 * All functions return a `Result` — they never throw. Network errors and
 * unexpected HTTP responses are folded into typed `OnlineClientError` values.
 *
 * SECURITY: This module is intended to run in the host process (Electron main,
 * or a CLI). Renderer / UI processes must reach it through the host's IPC
 * layer rather than calling fetch on the license server directly.
 */

import { err, ok, type Result } from './result.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PRODUCTION_BASE_URL = 'https://license.cloudrouter.online';
const REQUEST_TIMEOUT_MS = 10_000;

function getBaseUrl(): string {
  return process.env['CORTEXDEV_LICENSE_API_URL'] ?? PRODUCTION_BASE_URL;
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
}

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

interface ApiSuccessEnvelope<T> {
  data: T;
}

interface ApiErrorEnvelope {
  error: string;
  message: string;
}

/**
 * Execute a POST request against the license API with a 10-second timeout.
 * Returns a typed Result; never throws.
 */
async function post<TResponse>(
  path: string,
  body: unknown
): Promise<Result<TResponse, OnlineClientError>> {
  const url = `${getBaseUrl()}${path}`;
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

    let errorBody: ApiErrorEnvelope = { error: 'UNKNOWN', message: 'Unknown error' };
    try {
      errorBody = (await response.json()) as ApiErrorEnvelope;
    } catch {
      // ignore parse failure
    }

    if (response.status === 409 && errorBody.error === 'DEVICE_LIMIT_EXCEEDED') {
      return err({ type: 'device_limit_exceeded' } as const);
    }
    if (response.status === 403 && errorBody.error === 'LICENSE_REVOKED') {
      return err({ type: 'license_revoked' } as const);
    }
    if (response.status === 404) {
      return err({ type: 'not_found' } as const);
    }

    return err({
      type: 'api_error',
      status: response.status,
      code: errorBody.error,
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
 * Call `POST /api/v1/activate` to register this device with the license server.
 */
export async function onlineActivate(
  req: ActivateRequest
): Promise<Result<ActivateResponse, OnlineClientError>> {
  return post<ActivateResponse>('/api/v1/activate', req);
}

/**
 * Call `POST /api/v1/refresh` to check for revocation and update `last_seen`.
 */
export async function onlineRefresh(
  req: RefreshRequest
): Promise<Result<RefreshResponse, OnlineClientError>> {
  return post<RefreshResponse>('/api/v1/refresh', req);
}
