/**
 * Tests for online-check-store.ts — atomic I/O for online-check.json.
 *
 * Covers the file-format invariants the LicenseService.checkOfflineGrace
 * decision tree relies on:
 *   - read: returns null on missing / malformed / non-object JSON
 *   - read: returns the parsed object on a well-formed file
 *   - write: atomic via tmp + rename
 *   - write: mode 0600
 *   - write: omits `signed_token` when undefined (forward/backward compat
 *     with pre-D4 servers and clients)
 *   - write: omits `server_time` when undefined
 *   - write: `last_online_check` is always present (uses local wall clock)
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOnlineCheck, writeOnlineCheck } from './online-check-store.js';
import { createTempDir, type TempDir } from './__test-fixtures__/temp-dir.js';
import type { OnlineCheckFile, SignedToken } from './types.js';

const FIXTURE_TOKEN: SignedToken = {
  payload: {
    license_id: '4f56ab7d-7d0b-44fd-9ea5-0834b78b628f',
    server_time: '2026-06-16T00:00:00.000Z',
    expires_at: '2026-06-23T00:00:00.000Z',
  },
  signature: 'BASE64-DER-SIG',
};

describe('readOnlineCheck', () => {
  let temp: TempDir;

  beforeEach(() => {
    temp = createTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('returns null when the file does not exist', () => {
    expect(readOnlineCheck(temp.path)).toBeNull();
  });

  it('returns null when the file contains invalid JSON', () => {
    const licenseDir = path.join(temp.path, 'license');
    fs.mkdirSync(licenseDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(licenseDir, 'online-check.json'), 'not-json-{');
    expect(readOnlineCheck(temp.path)).toBeNull();
  });

  it('returns null when the file deserializes to a non-object (string)', () => {
    const licenseDir = path.join(temp.path, 'license');
    fs.mkdirSync(licenseDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(licenseDir, 'online-check.json'), '"hello"');
    expect(readOnlineCheck(temp.path)).toBeNull();
  });

  it('returns null when the file deserializes to null', () => {
    const licenseDir = path.join(temp.path, 'license');
    fs.mkdirSync(licenseDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(licenseDir, 'online-check.json'), 'null');
    expect(readOnlineCheck(temp.path)).toBeNull();
  });

  it('returns null when the file deserializes to an array', () => {
    const licenseDir = path.join(temp.path, 'license');
    fs.mkdirSync(licenseDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(licenseDir, 'online-check.json'), '[1, 2, 3]');
    expect(readOnlineCheck(temp.path)).toBeNull();
  });

  it('returns the parsed object when the file is well-formed', () => {
    const fixture: OnlineCheckFile = {
      last_online_check: '2026-06-15T10:00:00.000Z',
      server_time: '2026-06-15T09:59:55.000Z',
      signed_token: FIXTURE_TOKEN,
    };
    writeOnlineCheck(temp.path, fixture.server_time, fixture.signed_token);
    // The writer stamps its own last_online_check (local clock), so we compare
    // the persisted fields we can predict.
    const result = readOnlineCheck(temp.path);
    expect(result).not.toBeNull();
    expect(result?.server_time).toBe(fixture.server_time);
    expect(result?.signed_token).toEqual(FIXTURE_TOKEN);
    expect(typeof result?.last_online_check).toBe('string');
  });
});

describe('writeOnlineCheck — file shape', () => {
  let temp: TempDir;

  beforeEach(() => {
    temp = createTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function readRaw(): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(temp.path, 'license', 'online-check.json'), 'utf8')
    ) as Record<string, unknown>;
  }

  it('writes last_online_check as an ISO timestamp (always present)', () => {
    const before = Date.now();
    writeOnlineCheck(temp.path, undefined, undefined);
    const after = Date.now();

    const data = readRaw();
    expect(typeof data['last_online_check']).toBe('string');
    const writtenMs = Date.parse(data['last_online_check'] as string);
    expect(writtenMs).toBeGreaterThanOrEqual(before);
    expect(writtenMs).toBeLessThanOrEqual(after);
  });

  it('omits server_time field entirely when undefined', () => {
    writeOnlineCheck(temp.path, undefined, undefined);
    const data = readRaw();
    expect('server_time' in data).toBe(false);
  });

  it('omits signed_token field entirely when undefined', () => {
    writeOnlineCheck(temp.path, '2026-06-16T00:00:00.000Z', undefined);
    const data = readRaw();
    expect('signed_token' in data).toBe(false);
    expect(data['server_time']).toBe('2026-06-16T00:00:00.000Z');
  });

  it('omits signed_token field when token is structurally incomplete (missing payload)', () => {
    writeOnlineCheck(temp.path, '2026-06-16T00:00:00.000Z', {
      signature: 'sig',
    } as unknown as SignedToken);
    const data = readRaw();
    expect('signed_token' in data).toBe(false);
  });

  it('omits signed_token field when token is structurally incomplete (missing signature)', () => {
    writeOnlineCheck(temp.path, '2026-06-16T00:00:00.000Z', {
      payload: FIXTURE_TOKEN.payload,
    } as unknown as SignedToken);
    const data = readRaw();
    expect('signed_token' in data).toBe(false);
  });

  it('persists signed_token when provided', () => {
    writeOnlineCheck(temp.path, '2026-06-16T00:00:00.000Z', FIXTURE_TOKEN);
    const data = readRaw();
    expect(data['signed_token']).toEqual(FIXTURE_TOKEN);
  });
});

describe('writeOnlineCheck — atomic semantics', () => {
  let temp: TempDir;

  beforeEach(() => {
    temp = createTempDir();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('writes the file with mode 0600', () => {
    // Skip on Windows where POSIX permission bits do not exist.
    if (process.platform === 'win32') {
      return;
    }
    writeOnlineCheck(temp.path, '2026-06-16T00:00:00.000Z', FIXTURE_TOKEN);
    const filePath = path.join(temp.path, 'license', 'online-check.json');
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('does not leave a tmp file behind on success', () => {
    writeOnlineCheck(temp.path, '2026-06-16T00:00:00.000Z', FIXTURE_TOKEN);
    const licenseDir = path.join(temp.path, 'license');
    const entries = fs.readdirSync(licenseDir);
    const tmpFiles = entries.filter((e) => e.includes('.tmp.'));
    expect(tmpFiles).toEqual([]);
  });

  it('overwrites a pre-existing online-check.json with the new shape', () => {
    // First write with token, then overwrite without token. The second write
    // must NOT preserve the old signed_token field — D4 tokens are short-lived
    // and the stale field would let an attacker who reverts the file extend
    // their grace beyond the actual server response.
    writeOnlineCheck(temp.path, '2026-06-15T00:00:00.000Z', FIXTURE_TOKEN);
    writeOnlineCheck(temp.path, '2026-06-16T00:00:00.000Z', undefined);

    const data = JSON.parse(
      fs.readFileSync(path.join(temp.path, 'license', 'online-check.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(data['server_time']).toBe('2026-06-16T00:00:00.000Z');
    expect('signed_token' in data).toBe(false);
  });
});
