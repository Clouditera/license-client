/**
 * Host product identity — injected by each host at bootstrap so v2 licenses
 * can verify that the product + version they were signed for matches the
 * running binary. See RFC-002 §2.2 for the design.
 *
 * Semantics (RFC-002 §7 OQ-2/OQ-3/OQ-8):
 * - Missing identity → v2 product/version checks are SKIPPED with a
 *   serviceLogger.warn (allow-with-warning; see OQ-8 decision).
 * - Same {product, version} called twice → no-op.
 * - Different `product` on second call → THROW. Guards against the "two
 *   product binaries in one process" pathology.
 * - Same `product` but different `version` → NO throw. Version can legitimately
 *   change mid-process during, e.g., hot-reload / auto-update handoffs; the
 *   later version wins.
 */

import type { ProductCode } from './types.js';

/**
 * Identity declared by a host at bootstrap.
 */
export interface HostProductIdentity {
  /**
   * Product code — see `KNOWN_PRODUCTS` for documented values. Any non-empty
   * string is accepted (typed as `ProductCode = string`).
   */
  product: ProductCode;
  /**
   * SemVer version of the running host binary. Typically read from the host's
   * own `package.json` at bootstrap.
   */
  version: string;
}

let hostIdentity: HostProductIdentity | null = null;

/**
 * Declare the running host's product identity for v2 license verification.
 *
 * Should be called ONCE during the host's bootstrap phase, before any call to
 * `licenseService.initialize()`. Safe to omit for hosts that don't require
 * per-product enforcement (e.g. lite editions, test harnesses, dev tools) —
 * v2 checks are simply skipped when no identity is registered.
 *
 * @throws {Error} If called a second time with a DIFFERENT `product`.
 */
export function setHostProductIdentity(identity: HostProductIdentity): void {
  if (!identity || typeof identity.product !== 'string' || identity.product.length === 0) {
    throw new Error('[license-client] setHostProductIdentity: product must be a non-empty string');
  }
  if (typeof identity.version !== 'string' || identity.version.length === 0) {
    throw new Error('[license-client] setHostProductIdentity: version must be a non-empty string');
  }

  if (hostIdentity !== null && hostIdentity.product !== identity.product) {
    throw new Error(
      `[license-client] setHostProductIdentity: conflicting product identity — ` +
        `already registered as ${JSON.stringify(hostIdentity.product)}, ` +
        `refusing to overwrite with ${JSON.stringify(identity.product)}`
    );
  }

  hostIdentity = { product: identity.product, version: identity.version };
}

/**
 * Return the current host product identity, or null if none registered.
 *
 * Internal helpers (validator, license-service) consult this at v2 payload
 * evaluation time.
 */
export function getHostProductIdentity(): HostProductIdentity | null {
  return hostIdentity;
}

/**
 * Reset the host identity to its unregistered state.
 *
 * Test-only. Not exported from the package index — call directly via
 * `import { _resetHostProductIdentityForTest } from './host-identity.js'` in
 * tests that need isolation between cases.
 */
export function _resetHostProductIdentityForTest(): void {
  hostIdentity = null;
}
