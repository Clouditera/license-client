/**
 * Persistence for `{configDir}/license/online-check.json` — the D4 token plus
 * the legacy `last_online_check` timestamp used by Path B grace.
 *
 * Ported byte-equivalent from CLI legacy
 * `packages/devagent-pro/src/license/activate.js: writeOnlineCheckOnActivate`
 * and `packages/devagent-pro/src/license/refresh.js: writeOnlineCheck`. The
 * two CLI writers are historically split; we merge them here because the
 * file format is identical and the only difference was the call site.
 *
 *   - Atomic write: tmp + rename, mode 0600, same `tmp.{pid}` suffix used by
 *     store.ts so concurrent writers across activate/refresh/online-check
 *     don't clobber each other's temp.
 *   - Optional-field elision: `server_time` and `signed_token` are omitted
 *     from the JSON when the server response did not carry them, keeping the
 *     file forward/backward compatible with both pre-D4 and post-D4 servers.
 *   - `last_online_check` is always the local wall clock; never trust the
 *     server for this value (it is the marker used by clock-rollback detection).
 *
 * Reads tolerate a missing or malformed file: callers (LicenseService.
 * checkOfflineGrace) treat null as `offline_expired`, matching CLI gate.js.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getLicenseDir } from './store.js';
import type { OnlineCheckFile, SignedToken } from './types.js';

const ONLINE_CHECK_FILENAME = 'online-check.json';

function onlineCheckPath(configDir: string): string {
  return join(getLicenseDir(configDir), ONLINE_CHECK_FILENAME);
}

/**
 * Read and parse `online-check.json`. Returns null when the file is missing,
 * is not valid JSON, or does not deserialize to an object (e.g. someone wrote
 * `null` or an array). Never throws.
 */
export function readOnlineCheck(configDir: string): OnlineCheckFile | null {
  const path = onlineCheckPath(configDir);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  return parsed as OnlineCheckFile;
}

/**
 * Atomically write `online-check.json` with the freshly-issued state. Omits
 * `server_time` / `signed_token` when undefined so the file stays compatible
 * with older servers that do not ship D4 yet.
 *
 *   - `serverTime` — ISO timestamp from the `/activate` or `/refresh` server
 *     response. Used by Path B grace calculation.
 *   - `signedToken` — the D4 `online_check_token`. Used by Path A grace.
 */
export function writeOnlineCheck(
  configDir: string,
  serverTime: string | undefined,
  signedToken: SignedToken | undefined
): void {
  const path = onlineCheckPath(configDir);
  const data: OnlineCheckFile = {
    last_online_check: new Date().toISOString(),
    ...(serverTime ? { server_time: serverTime } : {}),
    ...(signedToken && signedToken.payload && signedToken.signature
      ? { signed_token: signedToken }
      : {}),
  };
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
}
