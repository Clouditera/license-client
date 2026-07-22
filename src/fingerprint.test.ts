/**
 * Tests for device fingerprint generation (fingerprint.ts).
 * Ported byte-equivalent from CortexDev-Agents.
 */

import fs from 'node:fs';
import type * as NodeFsNS from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TempDir } from './__test-fixtures__/temp-dir.js';
import { collectFingerprint, matchFingerprint } from './fingerprint.js';

type NodeFs = typeof NodeFsNS;

// ---------------------------------------------------------------------------
// Tests: collectFingerprint() — cache behaviour (cache-file manipulation)
// ---------------------------------------------------------------------------

describe('collectFingerprint() — cache handling', () => {
  let tmp: TempDir;

  beforeEach(() => {
    tmp = createTempDir('fingerprint-test-');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('returns a 64-char hex fingerprint on this machine', async () => {
    try {
      const fp = await collectFingerprint(tmp.path, { skipCache: true });
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    } catch (e: unknown) {
      if (String(e).includes('Unsupported platform') || String(e).includes('Insufficient')) {
        console.warn('Skipping: unsupported platform or insufficient hardware IDs');
        return;
      }
      throw e;
    }
  }, 15000);

  it('returns a cached value without re-running collectors', async () => {
    const cachePath = path.join(tmp.path, 'license', 'fingerprint-cache.json');
    const cachedFp = '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3';
    fs.mkdirSync(path.join(tmp.path, 'license'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ fingerprint: cachedFp, ts: Date.now() - 1000, platform: os.platform() }),
      { mode: 0o600 }
    );

    const fp = await collectFingerprint(tmp.path);
    expect(fp).toBe(cachedFp);
  });

  it('ignores a cache file with a future timestamp', async () => {
    const cachePath = path.join(tmp.path, 'license', 'fingerprint-cache.json');
    fs.mkdirSync(path.join(tmp.path, 'license'), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        fingerprint: 'a'.repeat(64),
        ts: Date.now() + 9_999_999,
        platform: os.platform(),
      })
    );

    try {
      const fp = await collectFingerprint(tmp.path);
      expect(fp).not.toBe('a'.repeat(64));
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    } catch (e: unknown) {
      if (String(e).includes('Unsupported') || String(e).includes('Insufficient')) {
        return;
      }
      throw e;
    }
  }, 15000);

  it('ignores a cache file from a different platform', async () => {
    const otherPlatform = os.platform() === 'darwin' ? 'linux' : 'darwin';
    const cachePath = path.join(tmp.path, 'license', 'fingerprint-cache.json');
    fs.mkdirSync(path.join(tmp.path, 'license'), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        fingerprint: 'b'.repeat(64),
        ts: Date.now() - 1000,
        platform: otherPlatform,
      })
    );

    try {
      const fp = await collectFingerprint(tmp.path);
      expect(fp).not.toBe('b'.repeat(64));
    } catch (e: unknown) {
      if (String(e).includes('Unsupported') || String(e).includes('Insufficient')) {
        return;
      }
      throw e;
    }
  }, 15000);

  it('bypasses cache when skipCache=true', async () => {
    const cachedFp = '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3';
    const cachePath = path.join(tmp.path, 'license', 'fingerprint-cache.json');
    fs.mkdirSync(path.join(tmp.path, 'license'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ fingerprint: cachedFp, ts: Date.now() - 1000, platform: os.platform() }),
      { mode: 0o600 }
    );

    try {
      const fp = await collectFingerprint(tmp.path, { skipCache: true });
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    } catch (e: unknown) {
      if (String(e).includes('Unsupported') || String(e).includes('Insufficient')) {
        return;
      }
      throw e;
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// Tests: matchFingerprint()
// ---------------------------------------------------------------------------

describe('matchFingerprint()', () => {
  const VALID_FP = '6d86c3f45548b75a4101547734efc9899a033e2b93e6479ee464d5a2425b64b3';
  const OTHER_FP = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  it('returns true for identical fingerprints', () => {
    expect(matchFingerprint(VALID_FP, VALID_FP)).toBe(true);
  });

  it('returns true — case-insensitive (uppercase input normalised)', () => {
    expect(matchFingerprint(VALID_FP.toUpperCase(), VALID_FP)).toBe(true);
    expect(matchFingerprint(VALID_FP, VALID_FP.toUpperCase())).toBe(true);
  });

  it('returns false for different fingerprints', () => {
    expect(matchFingerprint(VALID_FP, OTHER_FP)).toBe(false);
  });

  it('returns false for non-hex strings', () => {
    expect(matchFingerprint('not-a-hex-string', VALID_FP)).toBe(false);
    expect(matchFingerprint(VALID_FP, 'not-a-hex-string')).toBe(false);
  });

  it('returns false for wrong-length strings', () => {
    expect(matchFingerprint(VALID_FP.slice(0, 32), VALID_FP)).toBe(false);
  });

  it('returns false for non-string inputs', () => {
    expect(matchFingerprint(null as unknown as string, VALID_FP)).toBe(false);
    expect(matchFingerprint(VALID_FP, undefined as unknown as string)).toBe(false);
    expect(matchFingerprint(123 as unknown as string, VALID_FP)).toBe(false);
  });

  it('rejects strings with non-hex characters', () => {
    const nonHex = 'G'.repeat(64);
    expect(matchFingerprint(nonHex, VALID_FP)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: platform collectors with deterministic module mocks
// ---------------------------------------------------------------------------

describe('fingerprint platform collectors', () => {
  afterEach(() => {
    vi.doUnmock('node:os');
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('collects Linux identifiers and falls back to sysfs disk serial when lsblk fails', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { platform: () => 'linux' },
    }));
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn(
        (
          _cmd: string,
          _args: readonly string[],
          _options: unknown,
          callback: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          callback(new Error('lsblk unavailable'));
        }
      ),
    }));
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<NodeFs>('node:fs');
      return {
        ...actual,
        readFileSync: vi.fn((filePath: string) => {
          if (filePath === '/etc/machine-id') return 'machine-123\n';
          if (filePath === '/sys/block/sda/device/serial') return 'disk-456\n';
          if (filePath === '/proc/cpuinfo') return 'model name : Cortex CPU 9000\n';
          throw new Error(`unexpected read: ${filePath}`);
        }),
      };
    });

    const { collectFingerprintComponents } = await import('./fingerprint.js');

    await expect(collectFingerprintComponents()).resolves.toEqual({
      platform: 'linux',
      components: {
        machineId: 'machine-123',
        diskSerial: 'disk-456',
        cpu: 'Cortex CPU 9000',
      },
    });
  });

  it('returns null Linux component values when command and file collectors fail', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { platform: () => 'linux' },
    }));
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn(
        (
          _cmd: string,
          _args: readonly string[],
          _options: unknown,
          callback: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          callback(new Error('command unavailable'));
        }
      ),
    }));
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<NodeFs>('node:fs');
      return {
        ...actual,
        readFileSync: vi.fn(() => {
          throw new Error('missing file');
        }),
      };
    });

    const { collectFingerprintComponents } = await import('./fingerprint.js');

    await expect(collectFingerprintComponents()).resolves.toEqual({
      platform: 'linux',
      components: {
        machineId: null,
        diskSerial: null,
        cpu: null,
      },
    });
  });

  it('collects Windows identifiers with null fallbacks when PowerShell commands fail', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { platform: () => 'win32' },
    }));
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn(
        (
          _cmd: string,
          _args: readonly string[],
          _options: unknown,
          callback: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          callback(new Error('PowerShell unavailable'));
        }
      ),
    }));

    const { collectFingerprintComponents } = await import('./fingerprint.js');

    await expect(collectFingerprintComponents()).resolves.toEqual({
      platform: 'win32',
      components: {
        machineGuid: null,
        diskSerial: null,
        cpu: null,
      },
    });
  });

  it('normalizes empty command and file collector output to null', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { platform: () => 'linux' },
    }));
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn(
        (
          _cmd: string,
          _args: readonly string[],
          _options: unknown,
          callback: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          callback(null, '\n', '');
        }
      ),
    }));
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<NodeFs>('node:fs');
      return {
        ...actual,
        readFileSync: vi.fn((filePath: string) => {
          if (
            filePath === '/etc/machine-id' ||
            filePath === '/sys/block/sda/device/serial' ||
            filePath === '/proc/cpuinfo'
          ) {
            return '\n';
          }
          throw new Error(`unexpected read: ${filePath}`);
        }),
      };
    });

    const { collectFingerprintComponents } = await import('./fingerprint.js');

    await expect(collectFingerprintComponents()).resolves.toEqual({
      platform: 'linux',
      components: {
        machineId: null,
        diskSerial: null,
        cpu: null,
      },
    });
  });

  it('throws for unsupported platforms', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { platform: () => 'freebsd' },
    }));

    const { collectFingerprintComponents } = await import('./fingerprint.js');

    await expect(collectFingerprintComponents()).rejects.toThrow('Unsupported platform: freebsd');
  });

  it('throws when fewer than two hardware identifiers are available', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { platform: () => 'linux' },
    }));
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn(
        (
          _cmd: string,
          _args: readonly string[],
          _options: unknown,
          callback: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          callback(new Error('command unavailable'));
        }
      ),
    }));
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<NodeFs>('node:fs');
      return {
        ...actual,
        readFileSync: vi.fn((filePath: string) => {
          if (filePath === '/etc/machine-id') return 'only-machine-id\n';
          throw new Error(`missing file: ${filePath}`);
        }),
      };
    });

    const { collectFingerprint } = await import('./fingerprint.js');

    await expect(collectFingerprint(undefined, { skipCache: true })).rejects.toThrow(
      'Insufficient hardware identifiers (got 1, need >= 2)'
    );
  });
});

describe('setFingerprintCollector — host override', () => {
  it('delegates to the host-provided collector when set', async () => {
    vi.resetModules();
    const fp = await import('./fingerprint.js');

    const override = vi.fn().mockResolvedValue('aa'.repeat(32));
    fp.setFingerprintCollector(override);

    const got = await fp._collectFingerprintWithOverride('/x/configDir', { skipCache: true });
    expect(got).toBe('aa'.repeat(32));
    expect(override).toHaveBeenCalledWith('/x/configDir', { skipCache: true });

    fp.setFingerprintCollector(null); // restore
  });

  it('falls back to built-in collector when no override is set', async () => {
    vi.resetModules();
    const fp = await import('./fingerprint.js');
    fp.setFingerprintCollector(null);

    // No override → the call routes to the built-in `collectFingerprint`.
    // The built-in's verdict is environment-dependent: a GitHub-hosted runner
    // has enough hardware identifiers to succeed, whereas a sandboxed test
    // rig may not. We only assert the fallback wiring is correct — i.e. the
    // built-in was reached and produced *some* verdict (valid fingerprint
    // OR a real error), not a wiring failure like "collector is not a
    // function".
    try {
      const got = await fp._collectFingerprintWithOverride(undefined, { skipCache: true });
      expect(got).toMatch(/^[0-9a-f]{64}$/);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/Insufficient hardware identifiers|fingerprint/i);
    }
  });
});
