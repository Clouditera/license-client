import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TempDir } from './__test-fixtures__/temp-dir.js';
import {
  FATAL_GRACE_MS,
  clearFatal,
  fatalGraceRemainingHours,
  isFatalExpired,
  readFatal,
  writeFatal,
} from './fatal-state.js';
import type { FatalRecord } from './types.js';

describe('fatal-state', () => {
  let tmp: TempDir;
  const NOW = new Date('2026-06-17T12:00:00Z').getTime();

  beforeEach(() => {
    tmp = createTempDir();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    tmp.cleanup();
    vi.useRealTimers();
  });

  const sampleRecord = (occurredAt: string): FatalRecord => ({
    kind: 'fatal',
    reason: 'not_found',
    host: 'license.clouditera.online',
    httpStatus: 404,
    message: 'HTTP 404',
    occurred_at: occurredAt,
  });

  describe('writeFatal / readFatal', () => {
    it('persists and reads back the record', () => {
      const rec = sampleRecord(new Date(NOW).toISOString());
      writeFatal(tmp.path, rec);
      expect(readFatal(tmp.path)).toEqual(rec);
    });

    it('writes the file with mode 0600', () => {
      writeFatal(tmp.path, sampleRecord(new Date(NOW).toISOString()));
      const filePath = join(tmp.path, 'license', 'last-fatal.json');
      const mode = statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('returns null when file is absent', () => {
      expect(readFatal(tmp.path)).toBeNull();
    });

    it('returns null when file is corrupt JSON', () => {
      const filePath = join(tmp.path, 'license', 'last-fatal.json');
      // create dir via a throwaway write
      writeFatal(tmp.path, sampleRecord(new Date(NOW).toISOString()));
      writeFileSync(filePath, '{not json');
      expect(readFatal(tmp.path)).toBeNull();
    });

    it('returns null when kind discriminator is wrong', () => {
      const filePath = join(tmp.path, 'license', 'last-fatal.json');
      writeFatal(tmp.path, sampleRecord(new Date(NOW).toISOString()));
      writeFileSync(filePath, JSON.stringify({ kind: 'other', reason: 'not_found' }));
      expect(readFatal(tmp.path)).toBeNull();
    });
  });

  describe('clearFatal', () => {
    it('removes the file', () => {
      writeFatal(tmp.path, sampleRecord(new Date(NOW).toISOString()));
      const filePath = join(tmp.path, 'license', 'last-fatal.json');
      expect(existsSync(filePath)).toBe(true);
      clearFatal(tmp.path);
      expect(existsSync(filePath)).toBe(false);
    });

    it('is idempotent when the file is absent', () => {
      expect(() => clearFatal(tmp.path)).not.toThrow();
    });
  });

  describe('isFatalExpired', () => {
    it('returns true for null/undefined/missing occurred_at', () => {
      expect(isFatalExpired(null)).toBe(true);
      expect(isFatalExpired(undefined)).toBe(true);
      expect(isFatalExpired({ occurred_at: '' } as FatalRecord)).toBe(true);
    });

    it('returns true for unparseable occurred_at', () => {
      expect(isFatalExpired({ occurred_at: 'not-a-date' } as FatalRecord)).toBe(true);
    });

    it('returns false within the 24h grace window', () => {
      const occurredAt = new Date(NOW - 23 * 60 * 60 * 1000).toISOString();
      expect(isFatalExpired(sampleRecord(occurredAt))).toBe(false);
    });

    it('returns true after the 24h grace window', () => {
      const occurredAt = new Date(NOW - FATAL_GRACE_MS - 1).toISOString();
      expect(isFatalExpired(sampleRecord(occurredAt))).toBe(true);
    });
  });

  describe('fatalGraceRemainingHours', () => {
    it('returns 0 for null/undefined', () => {
      expect(fatalGraceRemainingHours(null)).toBe(0);
      expect(fatalGraceRemainingHours(undefined)).toBe(0);
    });

    it('returns 0 once grace has elapsed', () => {
      const occurredAt = new Date(NOW - FATAL_GRACE_MS - 1).toISOString();
      expect(fatalGraceRemainingHours(sampleRecord(occurredAt))).toBe(0);
    });

    it('returns ceil hours remaining within the window', () => {
      // 1h 30m into the grace → 23h ceil remaining (FATAL_GRACE_MS - 1.5h = 22.5h → ceil 23)
      const occurredAt = new Date(NOW - 90 * 60 * 1000).toISOString();
      expect(fatalGraceRemainingHours(sampleRecord(occurredAt))).toBe(23);
    });

    it('returns 0 for unparseable timestamp', () => {
      expect(fatalGraceRemainingHours({ occurred_at: 'nope' } as FatalRecord)).toBe(0);
    });
  });
});
