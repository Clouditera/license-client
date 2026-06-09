/**
 * Lightweight temp-dir fixture for unit tests.
 * Inlined copy of CortexDev-Agents/test/fixtures/fs.ts (createTempDir only)
 * so license-mgr has zero workspace dependencies.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TempDir {
  /** Absolute path of the temp directory. */
  path: string;
  /** Recursively remove the directory and all its contents. */
  cleanup: () => void;
}

export function createTempDir(prefix = 'license-mgr-test-'): TempDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
