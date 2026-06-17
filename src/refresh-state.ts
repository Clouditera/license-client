/**
 * Persistent cooldown record for transient `/refresh` failures (D5).
 *
 * Ported byte-equivalent from CortexDev-CLI's `refresh-state.js`. When a
 * refresh hits a transient error (network timeout / 429 / 5xx), the next
 * `REFRESH_COOLDOWN_MS` window skips the online attempt entirely so a slow
 * or flapping license server cannot add seconds to every CLI startup.
 * Successful refresh clears the record.
 *
 * SECURITY: file written atomically (tmp + rename), mode 0600.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLicenseDir } from './store.js';
import type { RefreshStateRecord } from './types.js';

/**
 * Cooldown window after a transient `/refresh` failure. Balances "don't
 * hammer a flapping server" against "recover quickly once the network is back".
 */
export const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

function stateFilePath(configDir: string): string {
  return join(getLicenseDir(configDir), 'refresh-state.json');
}

export function readRefreshState(configDir: string): RefreshStateRecord | null {
  const filePath = stateFilePath(configDir);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<RefreshStateRecord>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.kind !== 'transient') return null;
    if (typeof parsed.last_attempt !== 'string') return null;
    return parsed as RefreshStateRecord;
  } catch {
    return null;
  }
}

export function writeRefreshState(configDir: string, state: RefreshStateRecord): void {
  const filePath = stateFilePath(configDir);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

export function clearRefreshState(configDir: string): void {
  const filePath = stateFilePath(configDir);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

/**
 * True when the last transient attempt is younger than `REFRESH_COOLDOWN_MS`.
 * Null/missing/malformed records mean "not in cooldown" so the next attempt
 * proceeds normally.
 */
export function isWithinCooldown(
  state: RefreshStateRecord | null | undefined,
  now: number = Date.now()
): boolean {
  if (!state || !state.last_attempt) return false;
  const lastMs = Date.parse(state.last_attempt);
  if (!Number.isFinite(lastMs)) return false;
  return now - lastMs < REFRESH_COOLDOWN_MS;
}
