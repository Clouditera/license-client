/**
 * Persistent record of the most recent authoritative `/refresh` reject.
 *
 * Ported byte-equivalent from CortexDev-CLI's `gate.js` family
 * (devagent-pro/src/license/fatal-state.js). Provides a 24-hour soft grace
 * after a fatal server reject so a transient KV-injection mistake doesn't
 * instantly lock the user out — they keep working with a warning banner;
 * after 24h the gate hard-blocks.
 *
 * SECURITY: file written atomically (tmp + rename), mode 0600.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLicenseDir } from './store.js';
import type { FatalRecord } from './types.js';

/**
 * Short emergency grace window (ms) after a *fatal* refresh failure before
 * the gate hard-blocks. Distinct from the offline-grace window which is for
 * *transient* network failures only.
 */
export const FATAL_GRACE_MS = 24 * 60 * 60 * 1000;

function fatalPath(configDir: string): string {
  return join(getLicenseDir(configDir), 'last-fatal.json');
}

export function writeFatal(configDir: string, record: FatalRecord): void {
  const filePath = fatalPath(configDir);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

export function readFatal(configDir: string): FatalRecord | null {
  const filePath = fatalPath(configDir);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<FatalRecord>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.kind !== 'fatal') return null;
    if (typeof parsed.reason !== 'string') return null;
    if (typeof parsed.occurred_at !== 'string') return null;
    return parsed as FatalRecord;
  } catch {
    return null;
  }
}

export function clearFatal(configDir: string): void {
  const filePath = fatalPath(configDir);
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

/**
 * Whether a fatal record's grace window has elapsed. Missing or unparseable
 * `occurred_at` is treated as expired (fail-closed).
 */
export function isFatalExpired(record: FatalRecord | null | undefined): boolean {
  if (!record || !record.occurred_at) return true;
  const occurredMs = Date.parse(record.occurred_at);
  if (!Number.isFinite(occurredMs)) return true;
  return Date.now() - occurredMs > FATAL_GRACE_MS;
}

/**
 * Hours remaining in the fatal grace window (ceil). Returns 0 once expired.
 */
export function fatalGraceRemainingHours(record: FatalRecord | null | undefined): number {
  if (!record || !record.occurred_at) return 0;
  const occurredMs = Date.parse(record.occurred_at);
  if (!Number.isFinite(occurredMs)) return 0;
  const remainingMs = FATAL_GRACE_MS - (Date.now() - occurredMs);
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / (60 * 60 * 1000));
}
