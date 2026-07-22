import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TempDir } from './__test-fixtures__/temp-dir.js';
import {
  REFRESH_COOLDOWN_MS,
  clearRefreshState,
  isWithinCooldown,
  readRefreshState,
  writeRefreshState,
} from './refresh-state.js';
import type { RefreshStateRecord } from './types.js';

describe('refresh-state', () => {
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

  const sampleState = (lastAttempt: string): RefreshStateRecord => ({
    kind: 'transient',
    last_attempt: lastAttempt,
    host: 'license.clouditera.online',
    error: 'fetch timeout',
  });

  describe('writeRefreshState / readRefreshState', () => {
    it('persists and reads back', () => {
      const rec = sampleState(new Date(NOW).toISOString());
      writeRefreshState(tmp.path, rec);
      expect(readRefreshState(tmp.path)).toEqual(rec);
    });

    it.skipIf(process.platform === 'win32')('writes the file with mode 0600', () => {
      writeRefreshState(tmp.path, sampleState(new Date(NOW).toISOString()));
      const filePath = join(tmp.path, 'license', 'refresh-state.json');
      const mode = statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('returns null when file is absent', () => {
      expect(readRefreshState(tmp.path)).toBeNull();
    });

    it('returns null when file is corrupt JSON', () => {
      writeRefreshState(tmp.path, sampleState(new Date(NOW).toISOString()));
      writeFileSync(join(tmp.path, 'license', 'refresh-state.json'), '{not json');
      expect(readRefreshState(tmp.path)).toBeNull();
    });

    it('returns null when kind discriminator is missing', () => {
      writeRefreshState(tmp.path, sampleState(new Date(NOW).toISOString()));
      writeFileSync(
        join(tmp.path, 'license', 'refresh-state.json'),
        JSON.stringify({ last_attempt: new Date(NOW).toISOString() })
      );
      expect(readRefreshState(tmp.path)).toBeNull();
    });
  });

  describe('clearRefreshState', () => {
    it('removes the file', () => {
      writeRefreshState(tmp.path, sampleState(new Date(NOW).toISOString()));
      const filePath = join(tmp.path, 'license', 'refresh-state.json');
      expect(existsSync(filePath)).toBe(true);
      clearRefreshState(tmp.path);
      expect(existsSync(filePath)).toBe(false);
    });

    it('is idempotent when the file is absent', () => {
      expect(() => clearRefreshState(tmp.path)).not.toThrow();
    });
  });

  describe('isWithinCooldown', () => {
    it('returns false for null/undefined', () => {
      expect(isWithinCooldown(null)).toBe(false);
      expect(isWithinCooldown(undefined)).toBe(false);
    });

    it('returns false for missing last_attempt', () => {
      expect(isWithinCooldown({ kind: 'transient', last_attempt: '' } as RefreshStateRecord)).toBe(
        false
      );
    });

    it('returns false for unparseable last_attempt', () => {
      expect(
        isWithinCooldown({ kind: 'transient', last_attempt: 'nope' } as RefreshStateRecord)
      ).toBe(false);
    });

    it('returns true within the cooldown window', () => {
      const lastAttempt = new Date(NOW - 5 * 60 * 1000).toISOString();
      expect(isWithinCooldown(sampleState(lastAttempt))).toBe(true);
    });

    it('returns false after the cooldown window', () => {
      const lastAttempt = new Date(NOW - REFRESH_COOLDOWN_MS - 1).toISOString();
      expect(isWithinCooldown(sampleState(lastAttempt))).toBe(false);
    });

    it('honours injected `now`', () => {
      const lastAttempt = new Date(NOW).toISOString();
      const future = NOW + REFRESH_COOLDOWN_MS + 1;
      expect(isWithinCooldown(sampleState(lastAttempt), future)).toBe(false);
    });
  });
});
