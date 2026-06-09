/**
 * Device fingerprint generation for license binding.
 *
 * Ported byte-equivalent from CortexDev-Agents/src/main/core/license/fingerprint.ts.
 * The only change is decoupling from `@shared/brand` — the two env-var names
 * are inlined here so the module has zero workspace dependencies.
 *
 * The algorithm, hardware collectors, cache format, and hash function must
 * remain byte-for-byte identical to the CLI so that the same machine produces
 * the same fingerprint in both consumers.
 *
 * SECURITY: The fingerprint is collected in the host process only.
 * Renderer / UI processes receive it via the host's IPC layer.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Platform-specific hardware collectors (async)
// ---------------------------------------------------------------------------

async function execAsync(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function readFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// ---- macOS ----------------------------------------------------------------

async function darwinUUID(): Promise<string | null> {
  const out = await execAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  if (!out) return null;
  const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return m ? m[1]! : null;
}

async function darwinDiskSerial(): Promise<string | null> {
  const out = await execAsync('ioreg', ['-c', 'IOMedia', '-r', '-d', '1']);
  if (!out) return null;
  const m = out.match(/"Serial Number"\s*=\s*"([^"]+)"/);
  return m ? m[1]! : null;
}

async function darwinCPU(): Promise<string | null> {
  return execAsync('sysctl', ['-n', 'machdep.cpu.brand_string']);
}

// ---- Linux ----------------------------------------------------------------

function linuxMachineId(): Promise<string | null> {
  return Promise.resolve(readFile('/etc/machine-id'));
}

async function linuxDiskSerial(): Promise<string | null> {
  let s = await execAsync('lsblk', ['-ndo', 'SERIAL', '/dev/sda']);
  if (!s) s = readFile('/sys/block/sda/device/serial');
  return s;
}

function linuxCPU(): Promise<string | null> {
  const info = readFile('/proc/cpuinfo');
  if (!info) return Promise.resolve(null);
  const m = info.match(/model name\s*:\s*(.+)/);
  return Promise.resolve(m ? m[1]!.trim() : null);
}

// ---- Windows --------------------------------------------------------------

async function winMachineGuid(): Promise<string | null> {
  // Fast path: read directly from the registry via reg.exe.
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 3000 }
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    if (m?.[1]) return m[1];
  } catch {
    // fall through to PowerShell
  }
  return execAsync('powershell', [
    '-NoProfile',
    '-Command',
    "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
  ]);
}

async function winDiskSerial(): Promise<string | null> {
  return execAsync('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_DiskDrive | Select-Object -ExpandProperty SerialNumber -First 1',
  ]);
}

async function winCPU(): Promise<string | null> {
  return execAsync('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_Processor | Select-Object -ExpandProperty ProcessorId -First 1',
  ]);
}

// ---------------------------------------------------------------------------
// Collector registry
// ---------------------------------------------------------------------------

type Collector = () => Promise<string | null>;

const collectors: Record<string, Collector[]> = {
  darwin: [darwinUUID, darwinDiskSerial, darwinCPU],
  linux: [linuxMachineId, linuxDiskSerial, linuxCPU],
  win32: [winMachineGuid, winDiskSerial, winCPU],
};

const componentNames: Record<string, string[]> = {
  darwin: ['uuid', 'diskSerial', 'cpu'],
  linux: ['machineId', 'diskSerial', 'cpu'],
  win32: ['machineGuid', 'diskSerial', 'cpu'],
};

// ---------------------------------------------------------------------------
// Fingerprint computation
// ---------------------------------------------------------------------------

export interface FingerprintComponents {
  platform: string;
  components: Record<string, string | null>;
}

/**
 * Collect platform-specific hardware identifiers in parallel.
 *
 * @throws Error for unsupported platforms.
 */
export async function collectFingerprintComponents(): Promise<FingerprintComponents> {
  const plat = os.platform();
  const fns = collectors[plat];
  const names = componentNames[plat];
  if (!fns || !names) throw new Error(`Unsupported platform: ${plat}`);

  const results = await Promise.all(fns.map((fn) => fn()));
  const components: Record<string, string | null> = {};
  for (let i = 0; i < names.length; i++) {
    components[names[i]!] = results[i] ?? null;
  }
  return { platform: plat, components };
}

function computeHash(plat: string, components: Record<string, string | null>): string {
  const hashInput = `${plat}:${Object.values(components)
    .map((v) => v ?? '')
    .join(':')}`;
  return createHash('sha256').update(hashInput).digest('hex');
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function readCache(cachePath: string): string | null {
  try {
    const raw = readFileSync(cachePath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    const ts = Number(data?.['ts']);
    const fp = typeof data?.['fingerprint'] === 'string' ? data['fingerprint'].toLowerCase() : '';
    if (
      Number.isFinite(ts) &&
      ts <= now && // reject future timestamps
      now - ts < CACHE_TTL_MS &&
      /^[0-9a-f]{64}$/.test(fp) &&
      data['platform'] === os.platform()
    ) {
      return fp;
    }
  } catch {
    // cache miss
  }
  return null;
}

function writeCache(cachePath: string, fingerprint: string): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ fingerprint, ts: Date.now(), platform: os.platform() });
    writeFileSync(cachePath, payload, { mode: 0o600 });
  } catch {
    // non-critical, ignore
  }
}

function getCachePath(configDir?: string): string | null {
  const dir =
    configDir ?? process.env['CORTEXDEV_CONFIG_DIR'] ?? process.env['CORTEXDEV_PRO_CONFIG_DIR'];
  if (dir) return join(dir, 'license', 'fingerprint-cache.json');
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect the device fingerprint, using a 24-hour on-disk cache.
 *
 * @param configDir  Optional path to the CortexDev Pro config directory
 *                   (defaults to `CORTEXDEV_CONFIG_DIR` / `CORTEXDEV_PRO_CONFIG_DIR`).
 * @param opts.skipCache  When `true`, bypass the cache and re-collect hardware
 *                        identifiers. Use for security-critical paths (license gate).
 * @returns 64-character lowercase hex SHA-256 fingerprint.
 * @throws Error if fewer than 2 hardware identifiers are available.
 */
export async function collectFingerprint(
  configDir?: string,
  opts: { skipCache?: boolean } = {}
): Promise<string> {
  const cachePath = getCachePath(configDir);

  if (!opts.skipCache && cachePath) {
    const cached = readCache(cachePath);
    if (cached) return cached;
  }

  const { platform: plat, components } = await collectFingerprintComponents();
  const values = Object.values(components).filter(Boolean);
  if (values.length < 2) {
    throw new Error(`Insufficient hardware identifiers (got ${values.length}, need >= 2)`);
  }
  const fingerprint = computeHash(plat, components);

  // Only persist to cache when all collectors succeeded — a partial result
  // (e.g. machineGuid = null due to PowerShell timeout) would write a
  // different fingerprint than subsequent full collections, causing spurious
  // fingerprint_mismatch errors after the cache expires.
  const allPresent = Object.values(components).every(Boolean);
  if (cachePath && allPresent) {
    writeCache(cachePath, fingerprint);
  }

  return fingerprint;
}

/**
 * Timing-safe comparison of two fingerprint hex strings.
 *
 * Normalizes to lowercase, validates format, then uses `timingSafeEqual`
 * to prevent timing side-channels.
 *
 * @returns `true` if both fingerprints are equal.
 */
export function matchFingerprint(expected: string, collected: string): boolean {
  if (typeof expected !== 'string' || typeof collected !== 'string') return false;
  expected = expected.toLowerCase();
  collected = collected.toLowerCase();
  if (expected.length !== collected.length) return false;
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(collected)) {
    return false;
  }
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(collected, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
