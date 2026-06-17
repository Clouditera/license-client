/**
 * Unit tests for the license online-client HTTP layer.
 * Ported byte-equivalent from CortexDev-Agents.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_LICENSE_HOSTS,
  onlineActivate,
  onlineRefresh,
  setOnlineClientLogger,
  type ActivateResponse,
  type RefreshResponse,
} from './online-client.js';

const LICENSE_API_URL_ENV = 'CORTEXDEV_LICENSE_API_URL';
const LEGACY_ENV = 'CORTEXDEV_LICENSE_SERVER';

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response) as unknown as typeof fetch;
}

/**
 * Mocks the current Cloudflare Worker error envelope:
 *
 *   { ok: false, error: { code, message } }
 *
 * Use this for any test that exercises 4xx / 5xx behaviour against the
 * production server contract (every test in this file unless explicitly
 * proving back-compat with the legacy envelope).
 */
function mockFetchError(status: number, code: string, message: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ ok: false, error: { code, message } }),
  } as unknown as Response) as unknown as typeof fetch;
}

/**
 * Mocks the legacy flat error envelope:
 *
 *   { error: 'CODE', message: '...' }
 *
 * Kept so we can prove the normaliseEnvelope back-compat path still maps
 * 409 DEVICE_LIMIT_EXCEEDED → device_limit_exceeded etc. even if the
 * Worker is reverted to an older response shape.
 */
function mockFetchErrorLegacyEnvelope(status: number, code: string, message: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: code, message }),
  } as unknown as Response) as unknown as typeof fetch;
}

function mockFetchInvalidJson(status: number, isOk: boolean): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: isOk,
    status,
    json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
  } as unknown as Response) as unknown as typeof fetch;
}

function mockFetchNetworkFailure(): typeof fetch {
  return vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
}

function mockFetchTimeout(): typeof fetch {
  return vi
    .fn()
    .mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError')
    ) as unknown as typeof fetch;
}

function mockFetchRejects(value: unknown): typeof fetch {
  return vi.fn().mockRejectedValue(value) as unknown as typeof fetch;
}

const ACTIVATE_REQ = {
  license_id: 'test-license-id',
  fingerprint: 'a'.repeat(64),
  activation_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  client_version: '1.0.0',
};

const REFRESH_REQ = {
  license_id: 'test-license-id',
  activation_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
};

// ---------------------------------------------------------------------------
// onlineActivate
// ---------------------------------------------------------------------------

describe('onlineActivate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[LICENSE_API_URL_ENV];
  });

  it('returns Ok with ActivateResponse on 200 success', async () => {
    const responseBody: ActivateResponse = {
      status: 'activated',
      server_time: '2026-05-17T10:00:00.000Z',
      activation_id: ACTIVATE_REQ.activation_id,
    };
    vi.stubGlobal('fetch', mockFetchOk({ data: responseBody }));

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('activated');
      expect(result.data.activation_id).toBe(ACTIVATE_REQ.activation_id);
    }
  });

  it('returns Ok when the server returns an unwrapped success payload', async () => {
    const responseBody: ActivateResponse = {
      status: 'activated',
      server_time: '2026-05-17T10:00:00.000Z',
      activation_id: ACTIVATE_REQ.activation_id,
    };
    vi.stubGlobal('fetch', mockFetchOk(responseBody));

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result).toEqual({ success: true, data: responseBody });
  });

  it('uses the configured license API base URL (env override, allowlisted host)', async () => {
    process.env[LICENSE_API_URL_ENV] = 'https://license.clouditera.com/api/v1';
    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    await onlineActivate(ACTIVATE_REQ);

    const [url] = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://license.clouditera.com/api/v1/activate');
  });

  it('uses the production license API base URL by default', async () => {
    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    await onlineActivate(ACTIVATE_REQ);

    const [url] = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://license.clouditera.online/api/v1/activate');
  });

  it('returns Err with device_limit_exceeded on 409', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchError(409, 'DEVICE_LIMIT_EXCEEDED', 'Device limit of 1 reached')
    );

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('device_limit_exceeded');
    }
  });

  it('returns Err with license_revoked on 403', async () => {
    vi.stubGlobal('fetch', mockFetchError(403, 'LICENSE_REVOKED', 'This license has been revoked'));

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('license_revoked');
    }
  });

  it('returns Err with not_found on 404', async () => {
    vi.stubGlobal('fetch', mockFetchError(404, 'NOT_FOUND', 'License not found'));

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('not_found');
    }
  });

  it('returns Err with network_error on fetch network failure', async () => {
    vi.stubGlobal('fetch', mockFetchNetworkFailure());

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('network_error');
    }
  });

  it('returns Err with network_error on AbortError (timeout)', async () => {
    vi.stubGlobal('fetch', mockFetchTimeout());

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('network_error');
    }
  });

  it('aborts the request when the timeout timer fires', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        })
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', mockFetch);

    try {
      const resultPromise = onlineActivate(ACTIVATE_REQ);

      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: 'network_error',
          message: 'The operation was aborted.',
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns Err with api_error on 500 server error', async () => {
    vi.stubGlobal('fetch', mockFetchError(500, 'INTERNAL_ERROR', 'Server error'));

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('api_error');
      if (result.error.type === 'api_error') {
        expect(result.error.status).toBe(500);
      }
    }
  });

  it('returns Err with api_error on malformed 2xx JSON', async () => {
    vi.stubGlobal('fetch', mockFetchInvalidJson(200, true));

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatchObject({
        type: 'api_error',
        status: 200,
        code: 'INVALID_SUCCESS_PAYLOAD',
        message: 'Unexpected token < in JSON',
      });
    }
  });

  it('stringifies non-Error malformed 2xx JSON failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject('not json'),
      } as unknown as Response)
    );

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatchObject({
        type: 'api_error',
        status: 200,
        code: 'INVALID_SUCCESS_PAYLOAD',
        message: 'not json',
      });
    }
  });

  it('uses UNKNOWN api_error fallback when an error response body is malformed', async () => {
    vi.stubGlobal('fetch', mockFetchInvalidJson(502, false));

    const result = await onlineActivate(ACTIVATE_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toEqual({
        type: 'api_error',
        status: 502,
        code: 'UNKNOWN',
        message: 'Unknown error',
      });
    }
  });

  it('sends correct request body and headers', async () => {
    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    await onlineActivate(ACTIVATE_REQ);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/api/v1/activate');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(options.body as string) as {
      license_id: string;
      fingerprint: string;
      activation_id: string;
    };
    expect(body.license_id).toBe(ACTIVATE_REQ.license_id);
    expect(body.fingerprint).toBe(ACTIVATE_REQ.fingerprint);
    expect(body.activation_id).toBe(ACTIVATE_REQ.activation_id);
  });
});

// ---------------------------------------------------------------------------
// onlineRefresh
// ---------------------------------------------------------------------------

describe('onlineRefresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[LICENSE_API_URL_ENV];
  });

  it('returns Ok with revoked=false on successful refresh', async () => {
    const responseBody: RefreshResponse = {
      revoked: false,
      server_time: '2026-05-17T10:00:00.000Z',
      license: null,
    };
    vi.stubGlobal('fetch', mockFetchOk({ data: responseBody }));

    const result = await onlineRefresh(REFRESH_REQ);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.revoked).toBe(false);
    }
  });

  it('returns Ok with revoked=true when license is revoked', async () => {
    const responseBody: RefreshResponse = {
      revoked: true,
      server_time: '2026-05-17T10:00:00.000Z',
      revoked_at: '2026-05-16T08:00:00.000Z',
      reason: 'admin_revocation',
      license: null,
    };
    vi.stubGlobal('fetch', mockFetchOk({ data: responseBody }));

    const result = await onlineRefresh(REFRESH_REQ);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.revoked).toBe(true);
      expect(result.data.reason).toBe('admin_revocation');
      expect(result.data.revoked_at).toBe('2026-05-16T08:00:00.000Z');
    }
  });

  it('returns Err with not_found on 404', async () => {
    vi.stubGlobal('fetch', mockFetchError(404, 'NOT_FOUND', 'License not found'));

    const result = await onlineRefresh(REFRESH_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('not_found');
    }
  });

  it('returns Err with network_error on network failure', async () => {
    vi.stubGlobal('fetch', mockFetchNetworkFailure());

    const result = await onlineRefresh(REFRESH_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('network_error');
    }
  });

  it('stringifies non-Error network failures', async () => {
    vi.stubGlobal('fetch', mockFetchRejects('offline'));

    const result = await onlineRefresh(REFRESH_REQ);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toEqual({ type: 'network_error', message: 'offline' });
    }
  });

  it('sends correct request body and headers', async () => {
    const mockFetch = mockFetchOk({
      data: { revoked: false, server_time: '2026-05-17T10:00:00.000Z', license: null },
    });
    vi.stubGlobal('fetch', mockFetch);

    await onlineRefresh(REFRESH_REQ);

    const [url, options] = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/api/v1/refresh');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string) as {
      license_id: string;
      activation_id: string;
    };
    expect(body.license_id).toBe(REFRESH_REQ.license_id);
    expect(body.activation_id).toBe(REFRESH_REQ.activation_id);
  });
});

// ---------------------------------------------------------------------------
// D4 + R1 hardening: hostname allowlist, env-name compat, token field carry
// ---------------------------------------------------------------------------

describe('ALLOWED_LICENSE_HOSTS', () => {
  // Whichever consumer ships next (DevAgent-CLI Phase 3 / DevEye / ...) must
  // see the same hostnames in the allowlist as CLI legacy carries. Drift here
  // is a silent R1 violation, so we enumerate.
  it('contains every production / staging host from CLI server-url.js', () => {
    for (const host of [
      'license.devagent.io',
      'license.clouditera.com',
      'license.clouditera.online',
      'devagent-license-api.clouditera2026.workers.dev',
      'devagent-license-api-staging.clouditera2026.workers.dev',
      'devagent-license-api-staging.kangkangli.workers.dev',
      'license.cloudrouter.online',
      'license-staging.cloudrouter.online',
      'localhost',
      '127.0.0.1',
    ]) {
      expect(ALLOWED_LICENSE_HOSTS.has(host)).toBe(true);
    }
  });
});

describe('post: hostname allowlist enforcement', () => {
  afterEach(() => {
    delete process.env[LICENSE_API_URL_ENV];
    delete process.env[LEGACY_ENV];
    vi.unstubAllGlobals();
  });

  it('rejects an attacker-controlled hostname via env override', async () => {
    process.env[LICENSE_API_URL_ENV] = 'https://evil.attacker.com/api/v1';
    // fetch must not be called — the throw happens before any network reach.
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(onlineActivate(ACTIVATE_REQ)).rejects.toThrow(/License server domain not allowed/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects http:// for non-localhost hostnames', async () => {
    process.env[LICENSE_API_URL_ENV] = 'http://license.clouditera.online/api/v1';
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(onlineActivate(ACTIVATE_REQ)).rejects.toThrow(/must use HTTPS/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('permits http://localhost for local dev', async () => {
    process.env[LICENSE_API_URL_ENV] = 'http://localhost:8787/api/v1';
    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('permits http://127.0.0.1 for local dev', async () => {
    process.env[LICENSE_API_URL_ENV] = 'http://127.0.0.1:8787/api/v1';
    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(true);
  });

  it('throws clearly when CORTEXDEV_LICENSE_API_URL is malformed', async () => {
    process.env[LICENSE_API_URL_ENV] = 'not-even-a-url';
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(onlineActivate(ACTIVATE_REQ)).rejects.toThrow(/Invalid CORTEXDEV_LICENSE_API_URL/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('env-name compatibility (CORTEXDEV_LICENSE_API_URL ↔ CORTEXDEV_LICENSE_SERVER)', () => {
  const warnSpy = vi.fn();

  afterEach(() => {
    delete process.env[LICENSE_API_URL_ENV];
    delete process.env[LEGACY_ENV];
    warnSpy.mockClear();
    setOnlineClientLogger({ warn: () => undefined });
    vi.unstubAllGlobals();
  });

  it('CORTEXDEV_LICENSE_API_URL takes precedence over CORTEXDEV_LICENSE_SERVER', async () => {
    process.env[LICENSE_API_URL_ENV] = 'https://license.clouditera.com/api/v1';
    process.env[LEGACY_ENV] = 'https://license.cloudrouter.online/api/v1';
    setOnlineClientLogger({ warn: warnSpy });

    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    await onlineActivate(ACTIVATE_REQ);

    const [url] = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://license.clouditera.com/api/v1/activate');
    // Legacy not consulted → no deprecation warn.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to CORTEXDEV_LICENSE_SERVER + emits deprecation warning', async () => {
    process.env[LEGACY_ENV] = 'https://license.cloudrouter.online/api/v1';
    setOnlineClientLogger({ warn: warnSpy });

    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    await onlineActivate(ACTIVATE_REQ);

    const [url] = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://license.cloudrouter.online/api/v1/activate');
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/CORTEXDEV_LICENSE_SERVER is deprecated/);
    expect(msg).toMatch(/will be removed in v1\.1/);
  });

  it('default base URL is https://license.clouditera.online/api/v1', async () => {
    // Regression: this URL also doubles as proof of the 2026-06-14 migration
    // (license.cloudrouter.online → license.clouditera.online) AND the
    // alpha.2 base-URL realignment to include /api/v1 for CLI parity.
    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    await onlineActivate(ACTIVATE_REQ);

    const [url] = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://license.clouditera.online/api/v1/activate');
  });
});

describe('D4 online_check_token field carry', () => {
  afterEach(() => {
    delete process.env[LICENSE_API_URL_ENV];
    delete process.env[LEGACY_ENV];
    vi.unstubAllGlobals();
  });

  const SIGNED_TOKEN = {
    payload: {
      license_id: ACTIVATE_REQ.license_id,
      server_time: '2026-06-15T00:00:00.000Z',
      expires_at: '2026-06-22T00:00:00.000Z',
    },
    signature: 'base64-DER-sig',
  };

  it('ActivateResponse round-trips online_check_token when present', async () => {
    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
        online_check_token: SIGNED_TOKEN,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.online_check_token).toEqual(SIGNED_TOKEN);
    }
  });

  it('ActivateResponse leaves online_check_token undefined when server omits it', async () => {
    const mockFetch = mockFetchOk({
      data: {
        status: 'activated',
        server_time: '2026-05-17T10:00:00.000Z',
        activation_id: ACTIVATE_REQ.activation_id,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.online_check_token).toBeUndefined();
    }
  });

  it('RefreshResponse round-trips online_check_token when present', async () => {
    const mockFetch = mockFetchOk({
      data: {
        revoked: false,
        server_time: '2026-05-17T10:00:00.000Z',
        revoked_at: null,
        reason: null,
        license: null,
        online_check_token: SIGNED_TOKEN,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await onlineRefresh(REFRESH_REQ);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.online_check_token).toEqual(SIGNED_TOKEN);
    }
  });

  it('RefreshResponse leaves online_check_token undefined when server omits it (e.g. revoked)', async () => {
    const mockFetch = mockFetchOk({
      data: {
        revoked: true,
        server_time: '2026-05-17T10:00:00.000Z',
        revoked_at: '2026-05-15T00:00:00.000Z',
        reason: 'admin_revoke',
        license: null,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await onlineRefresh(REFRESH_REQ);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.online_check_token).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Error envelope normalisation (License-Mgr#1 regression suite)
// ---------------------------------------------------------------------------
//
// Before the alpha.4 fix, ApiErrorEnvelope expected `{ error: STRING, message }`
// but the Cloudflare Worker had already moved to `{ ok: false, error: { code,
// message } }`. The string === object comparison silently always returned
// false, so 409 DEVICE_LIMIT_EXCEEDED and 403 LICENSE_REVOKED collapsed
// into the generic api_error variant. Surface tests above already exercise
// the current shape; the cases below pin the back-compat path so a server
// rollback to the legacy envelope still maps to the correct variants.

describe('error envelope normalisation — legacy { error: STRING, message } back-compat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('legacy envelope: 409 still maps to device_limit_exceeded', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchErrorLegacyEnvelope(409, 'DEVICE_LIMIT_EXCEEDED', 'Device limit of 1 reached')
    );

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('device_limit_exceeded');
    }
  });

  it('legacy envelope: 403 still maps to license_revoked', async () => {
    vi.stubGlobal('fetch', mockFetchErrorLegacyEnvelope(403, 'LICENSE_REVOKED', 'License revoked'));

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('license_revoked');
    }
  });

  it('legacy envelope: unknown 5xx surfaces code + message under api_error', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchErrorLegacyEnvelope(503, 'BACKEND_DOWN', 'Upstream unavailable')
    );

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(false);
    if (!result.success && result.error.type === 'api_error') {
      expect(result.error.code).toBe('BACKEND_DOWN');
      expect(result.error.message).toBe('Upstream unavailable');
      expect(result.error.status).toBe(503);
    }
  });

  it('current envelope: unknown 5xx surfaces nested code + message under api_error', async () => {
    vi.stubGlobal('fetch', mockFetchError(503, 'BACKEND_DOWN', 'Upstream unavailable'));

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(false);
    if (!result.success && result.error.type === 'api_error') {
      expect(result.error.code).toBe('BACKEND_DOWN');
      expect(result.error.message).toBe('Upstream unavailable');
      expect(result.error.status).toBe(503);
    }
  });

  it('completely malformed body falls back to UNKNOWN / Unknown error (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.resolve('not an error envelope at all'),
      } as unknown as Response) as unknown as typeof fetch
    );

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(false);
    if (!result.success && result.error.type === 'api_error') {
      expect(result.error.code).toBe('UNKNOWN');
      expect(result.error.message).toBe('Unknown error');
    }
  });

  it('non-object body (null) falls back to UNKNOWN', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.resolve(null),
      } as unknown as Response) as unknown as typeof fetch
    );

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(false);
    if (!result.success && result.error.type === 'api_error') {
      expect(result.error.code).toBe('UNKNOWN');
    }
  });

  it('current envelope with missing inner code falls back to UNKNOWN code (not crash)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ ok: false, error: { message: 'no code field' } }),
      } as unknown as Response) as unknown as typeof fetch
    );

    const result = await onlineActivate(ACTIVATE_REQ);
    expect(result.success).toBe(false);
    if (!result.success && result.error.type === 'api_error') {
      expect(result.error.code).toBe('UNKNOWN');
      expect(result.error.message).toBe('no code field');
    }
  });
});
