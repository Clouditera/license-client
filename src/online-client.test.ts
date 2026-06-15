/**
 * Unit tests for the license online-client HTTP layer.
 * Ported byte-equivalent from CortexDev-Agents.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  onlineActivate,
  onlineRefresh,
  type ActivateResponse,
  type RefreshResponse,
} from './online-client.js';

const LICENSE_API_URL_ENV = 'CORTEXDEV_LICENSE_API_URL';

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

function mockFetchError(status: number, code: string, message: string): typeof fetch {
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

  it('uses the configured license API base URL', async () => {
    process.env[LICENSE_API_URL_ENV] = 'https://license.test';
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
    expect(url).toBe('https://license.test/api/v1/activate');
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
