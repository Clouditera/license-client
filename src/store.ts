/**
 * License file persistence — read/write license and activation metadata.
 *
 * Ported byte-equivalent from CortexDev-Agents/src/main/core/license/store.ts.
 * The only changes are decoupling from host-project utilities:
 *   - `@shared/brand.CORTEXDEV_ENV_VARS` → inlined string literals so the
 *     module has zero workspace dependencies.
 *   - `@main/utils/userEnv.getHomeDir` → `node:os.homedir()`.
 *
 * Files are stored at `{configDir}/license/` which is shared with the
 * cortexdev-pro CLI so that a license activated in the host is immediately
 * recognised by the CLI and vice-versa.
 *
 * SECURITY: Uses atomic writes (tmp + rename) to prevent partial writes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ActivationMeta, LicenseFile } from './types.js';

// ---------------------------------------------------------------------------
// Config directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the CortexDev Pro config directory.
 *
 * Resolution order (identical to the cortexdev-pro CLI):
 * 1. `CORTEXDEV_CONFIG_DIR` environment variable
 * 2. `CORTEXDEV_PRO_CONFIG_DIR` environment variable
 * 3. `~/.cortexdev-pro` (default)
 *
 * The host deliberately does NOT use `app.getPath('userData')` (or similar
 * per-app paths). Using the same path as the CLI enables host/CLI license
 * sharing.
 */
export function resolveConfigDir(): string {
  return (
    process.env['CORTEXDEV_CONFIG_DIR'] ??
    process.env['CORTEXDEV_PRO_CONFIG_DIR'] ??
    join(homedir(), '.cortexdev-pro')
  );
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate that configDir is a non-empty string that resolves to an absolute
 * path without path-traversal segments.
 *
 * @throws Error for invalid paths.
 */
function validateConfigDir(configDir: string): void {
  if (typeof configDir !== 'string' || configDir.length === 0) {
    throw new Error('Invalid configDir: must be a non-empty string');
  }
  if (!configDir.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(configDir)) {
    throw new Error('Invalid configDir: must resolve to an absolute path');
  }
  const resolved = resolve(configDir);
  if (resolved.split(/[\\/]/).includes('..')) {
    throw new Error('Invalid configDir: path traversal (..) is not allowed');
  }
}

// ---------------------------------------------------------------------------
// Atomic file write
// ---------------------------------------------------------------------------

/**
 * Atomically write `data` to `filePath` by first writing to a temp file
 * (`{filePath}.tmp.{pid}`) then renaming it into place.
 */
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, data, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// License directory
// ---------------------------------------------------------------------------

/**
 * Return the license sub-directory path for a given config dir, creating it
 * with mode 0700 if it does not exist.
 */
export function getLicenseDir(configDir: string): string {
  validateConfigDir(configDir);
  const licenseDir = join(configDir, 'license');
  if (!existsSync(licenseDir)) {
    mkdirSync(licenseDir, { recursive: true, mode: 0o700 });
  }
  return licenseDir;
}

// ---------------------------------------------------------------------------
// JSON file helpers
// ---------------------------------------------------------------------------

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// License file (license.json)
// ---------------------------------------------------------------------------

/**
 * Read and parse `{configDir}/license/license.json`.
 *
 * @returns The parsed `LicenseFile`, or `null` if the file is missing or corrupt.
 */
export function readLicense(configDir: string): LicenseFile | null {
  validateConfigDir(configDir);
  return readJsonFile<LicenseFile>(join(configDir, 'license', 'license.json'));
}

/**
 * Atomically write `licenseData` as JSON to `{configDir}/license/license.json`.
 * Creates the license directory with mode 0700 if it does not exist.
 */
export function writeLicense(configDir: string, licenseData: LicenseFile): void {
  validateConfigDir(configDir);
  const licenseDir = getLicenseDir(configDir);
  atomicWrite(join(licenseDir, 'license.json'), JSON.stringify(licenseData, null, 2));
}

/**
 * Delete `{configDir}/license/license.json` if it exists.
 * Does nothing if the file is absent.
 */
export function deleteLicense(configDir: string): void {
  validateConfigDir(configDir);
  const filePath = join(configDir, 'license', 'license.json');
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

// ---------------------------------------------------------------------------
// Activation metadata (activation.json)
// ---------------------------------------------------------------------------

/**
 * Read and parse `{configDir}/license/activation.json`.
 *
 * @returns The parsed `ActivationMeta`, or `null` if missing or corrupt.
 */
export function readActivationMeta(configDir: string): ActivationMeta | null {
  validateConfigDir(configDir);
  return readJsonFile<ActivationMeta>(join(configDir, 'license', 'activation.json'));
}

/**
 * Atomically write `meta` as JSON to `{configDir}/license/activation.json`.
 */
export function writeActivationMeta(configDir: string, meta: ActivationMeta): void {
  validateConfigDir(configDir);
  const licenseDir = getLicenseDir(configDir);
  atomicWrite(join(licenseDir, 'activation.json'), JSON.stringify(meta, null, 2));
}
