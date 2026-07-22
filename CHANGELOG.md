# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0-alpha.1] - 2026-07-03

### Added (RFC-002 P1 — v2 schema with product / product_version)

Implements phase 1 of [RFC-002](https://github.com/Clouditera/license-tools/blob/main/docs/rfc/rfc-002-product-version-fields.md) in the license-client. Enables SKU-level license binding — a license can be locked to a specific product code and SemVer range, verified at every activation and refresh.

**New public API:**

- `setHostProductIdentity({product, version})` — idempotent setter (throws on conflicting product per §7 OQ-3). Should be called once at host bootstrap.
- `getHostProductIdentity()` — returns current identity or null.
- `checkProductCompatibility(payload, identity?)` — v1 payload passes through; v2 payload compared against host identity.
- `satisfies(version, range)` — inline strict-SemVer satisfier (Alt-A per §7 OQ-4). Supports `*`, exact, `>=/>/</<=/=`, tilde, caret, space-separated AND. No `||`, hyphen, or x-ranges.
- `parseVersion(v)`, `parseRange(r)`, `compareVersions(a,b)`, `isValidRange(r)` — helper exports.
- `LICENSE_SCHEMA_V2_SUPPORTED = true` — runtime feature flag for adapters.
- `KNOWN_PRODUCTS` — documentation-only array of currently-signed product codes.
- New types: `LicensePayloadV1`, `LicensePayloadV2`, `ProductCode`, `HostProductIdentity`, `ProductCompatibilityReason`, `ProductCompatibilityResult`.

**Type change (breaking on `LicensePayload`):**

- `LicensePayload` is now a discriminated union: `LicensePayloadV1 | LicensePayloadV2`. Consumers narrowing on `payload.version === 1` continue to work; consumers assuming a flat interface may need to add a version discriminator.

**New error reasons:**

- `product_mismatch` — v2 payload's `product` doesn't equal the host identity's product.
- `product_version_mismatch` — v2 host version doesn't satisfy the license's `product_version` range.
- `product_version_range_invalid` — v2 `product_version` fails to parse as SemVer range.

Error `LicenseStatus` variants for these carry a `productCompat` payload with license/host values for adapter lockout boxes.

### Behavior notes (per RFC-002 §7 decisions)

- **v1 licenses continue to validate** without any product binding (legacy tolerance per §2.6).
- **v2 license with no host identity registered** → allow with warning: `serviceLogger.warn("[license-client] product identity not set; skipping v2 checks — this is a bug in the host bootstrap")` (OQ-2/OQ-8).
- **`ProductCode` is `string`, not a locked enum** (OQ-1 revision-1) — new products can be added by admin CLI + host bootstrap alone, no license-client bump required. Design target: ~100 concurrent product codes.
- **Strict SemVer semantics**: `product_version: '1.0.0'` does NOT accept a `1.0.0-alpha.6` host; admin must explicitly write `>=1.0.0-alpha.6 <1.0.1` for prerelease coverage (OQ-4).
- **`checkProductCompatibility` is idempotent + pure** given a payload + identity — safe to call at both activation and every refresh.

### Testing

- 160 new tests across `host-identity.test.ts` (10), `semver-satisfies.test.ts` (99), and extensions to `schema.test.ts` (51). Full suite continues to pass, including all license-service integration paths.

## [1.0.0-alpha.6] - 2026-06-18

Real-world adapter shake-down catch-up. Smoke testing the CLI adapter
against a production-signed license on a developer machine surfaced
two fingerprint-collection gaps that would block the eventual flip of
`CORTEXDEV_LICENSE_IMPL=core` to default. Both are now closed.

Wire URL unchanged. Server unchanged. No client-visible behaviour change
for hosts that don't install a custom fingerprint collector.

### Added

- `fingerprint.ts: setFingerprintCollector(fn)` — module-level setter
  that lets a host plug in its own `collectFingerprint` implementation.
  Use case: CortexDev-CLI's `packages/core/src/license/fingerprint.js`
  wraps the built-in collector with a permanent `fingerprint-lock.json`
  fallback that survives a transient hardware-probe failure long after
  the 24h cache TTL. Without this injection point, license-client's own
  collector falsely locks out an established user whose ioreg / WMI
  probe returns 0 components on a given startup.
- `_collectFingerprintWithOverride()` — internal entry point used by
  `LicenseService.initialize()` and `_processActivation()`. Delegates
  to the host override when set, falls back to the built-in collector
  otherwise. Adapters should not call this directly.
- `FingerprintCollector` type in the public surface.

### Changed

- `LicenseService.initialize()` adds a two-layer fingerprint collection
  fallback (mirrors CLI gate.js):
  1. Fresh collect (`skipCache: true`) — preferred.
  2. If fresh THROWS (insufficient hardware identifiers), fall back to
     the on-disk cache so a previously-good activation survives a
     transient probe failure. Only used when fresh produces nothing.
- `LicenseService.initialize()` adds a `fingerprint_mismatch` recovery
  branch. If validation fails on `fingerprint_mismatch` AND the cache
  contains a different fingerprint than the fresh collect, validation
  retries with the cached value. Picks up the case where Windows WMI
  returns partial cold-start data that hashes differently than the
  activation-time fingerprint.

### Compatibility

- Built-in collector (when no host injects) is unchanged. Existing
  tests pass without modification. 333 → 335 (two new tests covering
  the override + fallback path).
- License-mgr alone still ships without lock-file semantics; hosts
  that want them inject their own collector. DevAgent-CLI does this
  in `adapter-core.js` v1.0.0-alpha.6+.

### Known issues

- Server-issued `online_check_token` signature verification fails
  against the client's embedded `PROD_TOKEN_KEY` (see License-Client-
  consumers issue tracker, e.g. devagent-cli#228). Until fixed,
  `checkOfflineGrace` Path A is effectively dead in prod; Path B
  still works via `last_online_check + offlineGraceDays`. Not a
  license-client code problem — server key drift.


## [1.0.0-alpha.5] - 2026-06-17

CLI-parity catch-up. Closes the three "CLI-only fallback" gaps that were
documented in `docs/phase3-cli-adapter.md` and called out in PR #218 as
reasons to keep the legacy default. With alpha.5 the standalone module
covers them; the CLI adapter can flip `CORTEXDEV_LICENSE_IMPL=core` to
the default with no behavioural regression.

Wire URL unchanged from alpha.4. No server-side change required.

### Added

- `fatal-state.ts` — `last-fatal.json` 24h soft grace after authoritative
  server reject. `writeFatal()` / `readFatal()` / `clearFatal()` /
  `isFatalExpired()` / `fatalGraceRemainingHours()` mirror CLI legacy
  `gate.js: fatal-state.js`. Anchored to *first* fatal occurrence so
  repeated rejects don't reset the window.
- `refresh-state.ts` — D5 cooldown record (`refresh-state.json`).
  `REFRESH_COOLDOWN_MS = 30min`; within the window `_doRefresh` skips
  the network attempt and falls through to offline grace so a slow
  /flapping license server cannot add seconds to every CLI startup.
- `ActivationMeta.issued_server?: string` + `schema_version?: number` —
  pins the resolved license server URL at activation time. Future
  `initialize()` calls compare this against the current resolution to
  detect cross-environment misuse (`server_mismatch`) BEFORE any
  `/refresh` traffic that would pollute the wrong KV.
- `online-client.ts: getCurrentLicenseServerURL()` — public helper used
  by both the activate path (to record `issued_server`) and the gate
  (to detect mismatch). Returns `null` instead of throwing so a
  misconfigured env doesn't crash the gate.
- `LicenseStatus.error` extended with optional `license`, `fatal`, and
  `mismatch` carryover fields so adapters can render contextual lockout
  boxes without a translation layer. `LicenseErrorReason` gains
  `'fatal_refresh_failure'` and `'server_mismatch'`.
- `FatalRecord` and `RefreshStateRecord` types in the public surface.

### Changed

- `LicenseService.initialize()` runs two new guards after validation +
  offline-grace and before refresh scheduling:
  1. `server_mismatch` — only when `activationMeta.issued_server` is set
     (v1 records skip; back-compat). Hard-stops at error/server_mismatch.
  2. `fatal-state grace` — reads `last-fatal.json`. Expired → status
     becomes error/fatal_refresh_failure carrying the `fatal` record.
     Within grace → keep active, log a warning with `hoursRemaining`.
- `LicenseService._doRefresh()` consults `isWithinCooldown()` before
  the network call. If true: skip fetch, apply offline grace,
  return `network_error`.
- `_handleRefreshFailure` (transient branch) writes refresh-state.
  `_handleRefreshFailure` (rejection, non-revoked) writes last-fatal
  *only on first occurrence*.
- `_handleRefreshSuccess` clears both fatal-state and refresh-state on
  the non-revoked path. `_processActivation` does the same on a
  successful online activate (activation is a recovery point too).
- `_processActivation` records `issued_server` + `schema_version: 2`
  in `ActivationMeta` when `serverSynced` is true.

### Compatibility

- Wire format unchanged. Server unchanged. v1 activation records (no
  `issued_server`) still authorise — the mismatch check is opt-in via
  presence of the field. Hosts that don't trigger online activation
  (CLI-mocked test envs) get `issued_server` left undefined exactly
  as in alpha.4.
- `printLockoutBox` in the CLI adapter receives the same `{reason,
  license, fatal, mismatch}` shape as legacy gate.js → no UI change.


## [1.0.0-alpha.4] - 2026-06-17

GA-blocker bug fix. The `device_limit_exceeded` and `license_revoked`
error branches in `online-client.post()` have been silently dead since
alpha.0 — they compared a string against a server payload that has long
been an object. Every 409 / 403 from the production Cloudflare Worker
was collapsing into the generic `api_error` variant, hiding the user-
facing "this license is bound to too many devices" / "this license was
revoked" messages behind a vague "server returned 409".

Closes License-Mgr#1. No client-visible change for activate/refresh
*success* paths; this only restores the correct typed error variants.

### Fixed

- `online-client.ts: ApiErrorEnvelope` rewritten to accept the current
  Cloudflare Worker envelope `{ ok: false, error: { code, message } }`
  AND tolerate the legacy flat shape `{ error: "CODE", message }` so a
  server rollback can't silently re-break the client. The 409 →
  `device_limit_exceeded` and 403 → `license_revoked` discriminated
  variants now actually fire under the production server contract.
  (License-Mgr#1)

### Changed

- `online-client.ts` introduces `normalizeErrorEnvelope(raw)` which
  produces a `NormalizedErrorEnvelope { code, message }` regardless of
  which envelope shape the server returned. `post()` reads
  `errorBody.code` for the variant dispatch; the public `OnlineClientError`
  union (and `api_error.code` / `api_error.message`) is unchanged so
  downstream consumers are not affected.

## [1.0.0-alpha.3] - 2026-06-17

Phase 3 unblock release. Lands the `HostEnvironment.refreshIntervalMs` and
`HostEnvironment.refreshStartupBudgetMs` injection points the CLI adapter
needs to preserve its 3-day refresh cadence + 5-second startup budget on
top of `@clouditera/license-client`. Without these, the CLI flipping its
default to license-client would 3x server traffic and risk slow startup on
degraded networks. Closes License-Mgr#3.

Wire URL unchanged. Default behaviour preserved when fields are unset
(REFRESH_INTERVAL_MS = 24h, no budget) — DevAgent-App sees no change.

### Added

- `HostEnvironment.refreshIntervalMs?: number` — adapter-injected override
  for the steady-state interval between `/refresh` calls. CLI adapter
  passes `3 * 24 * 60 * 60 * 1000`. Defaults to `REFRESH_INTERVAL_MS` (24h).
- `HostEnvironment.refreshStartupBudgetMs?: number` — wall-clock budget
  for the `initialize()` startup refresh. When set + exceeded, the refresh
  aborts and the gate falls back to offline grace. Matches CLI
  `refresh.js: STARTUP_BUDGET_MS = 5000`. Defaults to unlimited.

### Changed

- `LicenseService._doRefresh(opts)` now takes an optional `{ startup?: boolean }`
  flag. When `startup: true` AND `hostEnv.refreshStartupBudgetMs` is set,
  the network call races a budget timer; the budget wins → `network_error`
  → offline grace. Non-startup refreshes ignore the budget entirely.
  Internal API; not part of the public surface.

## [1.0.0-alpha.2] - 2026-06-17

D4 (`online_check_token`) + R1 byte-equivalence catch-up against CLI legacy.
First version of `@clouditera/license-client` that DevAgent-CLI (or any future
CLI consumer) can adopt without losing functionality or security guard-rails
that the CLI legacy implementation already ships. Closes the gap surfaced
during Phase 3 prep on 2026-06-16 (see License-Mgr#2).

Wire URL is unchanged from alpha.1 (`https://license.clouditera.online/api/v1/{activate,refresh}`);
this release does not require a server-side change.

### Added

D4 stack (server-signed offline grace assertion):

- `src/token-key.ts` — `EMBEDDED_TOKEN_PUBLIC_KEY` + `DEV_TOKEN_KEY` / `PROD_TOKEN_KEY`
  byte-embedded from CLI legacy; trust root physically isolated from license
  `PROD_KEY`. Reuses `crypto.ts: isProductionBuild` so the same production
  resolver applies uniformly. Honours `DEVAGENT_TOKEN_PUBLIC_KEY` env override
  in dev builds, refuses it in prod builds.
- `src/online-check.ts` — `verifyOnlineCheckToken(token, licenseId, embeddedTokenPublicKey)`
  pure verifier. Returns a discriminated `OnlineCheckVerdict` (`valid` /
  `malformed` / `id_mismatch` / `expired` / `invalid_signature`) so callers
  can distinguish "old/corrupt token file → fall through to legacy Path B"
  from hard tamper failures.
- `src/online-check-store.ts` — atomic `readOnlineCheck` / `writeOnlineCheck`
  for `{configDir}/license/online-check.json` (mode 0600, tmp + rename, optional
  `signed_token` / `server_time` elision for forward/backward compat with
  pre-D4 servers).
- `LicenseService.checkOfflineGrace()` — mirrors CLI `gate.js: checkOfflineGrace()`
  byte-for-byte: Path A (signed_token) with `malformed`-only fall-through to
  Path B; Path B with clock-rollback detection and `offlineGraceDays` / `requireSignedToken`
  honoured from `HostEnvironment`.
- D4 types: `SignedToken`, `OnlineCheckVerdict`, `OnlineCheckFile`, `OfflineGraceResult`.
- `HostEnvironment.offlineGraceDays?: number` — adapter-injected grace window.
  Default 14 (preserves license-client pre-D4 contract); CLI adapter passes 60.
- `HostEnvironment.requireSignedToken?: boolean` — compliance hardening, refuses
  Path B entirely. Mirrors CLI `LICENSE_REQUIRE_SIGNED_TOKEN=true` env.
- activate() / doRefreshNow() — both persist the D4 token to `online-check.json`
  on success; revoked refresh + network failure intentionally skip the write
  (matches CLI gate semantics).

Network layer hardening (R1 catch-up):

- `online-client.ts: ALLOWED_LICENSE_HOSTS` — domain pinning Set covering every
  CLI legacy host. Enforced inside `post()` before fetch; a tampered
  `CORTEXDEV_LICENSE_API_URL` pointing at a non-allowlisted host is refused
  synchronously.
- `online-client.ts: setOnlineClientLogger(...)` — module-level setter so the
  legacy env-name deprecation warning surfaces through the host logger.
- `ActivateResponse.online_check_token?: SignedToken` and
  `RefreshResponse.online_check_token?: SignedToken` — optional field carried
  end-to-end. Server omits on pre-D4 deployment AND on revoked responses; client
  tolerates either.

Tooling (5-piece trust-root suite):

- `scripts/verify-trust-root.mjs` — CI gate. Two layers: (1) text PLACEHOLDER
  detection against PROD_KEY + PROD_TOKEN_KEY; (2) DER-byte collision detection
  (`publicKeysEqual(PROD_TOKEN_KEY, DEV_TOKEN_KEY) === false` and
  `publicKeysEqual(PROD_TOKEN_KEY, PROD_KEY) === false`). Wired into ci.yml
  after build and into release.yml before publish; also exposed as
  `pnpm run verify:trust-root`.
- `scripts/gen-prod-token-key.mjs` — self-contained key rotation. Generates
  ECDSA P-256 keypair into `token-keys/` (private 0600, public 0644) and
  prints paste-ready public block + SOP for Workers Secret / GitHub Secret push.
- `.gitignore` — `token-keys/` + `*.pem` to prevent accidental commit of the
  private half.

Documentation:

- `docs/d4-design.md` — design doc evolved through v0.1 → v0.2 → v0.3 (CLI
  ground truth corrections to Q-1 + 5-piece trust-root scope).
- `docs/requirements.md` v0.6 → v0.7 — §F2 / F5 / F8 / N4 / M3 synced to
  reflect the D4 / R1 reality post-alpha.2.

### Changed

- `online-client.ts: PRODUCTION_BASE_URL` now `https://license.clouditera.online/api/v1`
  (base contains `/api/v1`, request paths shortened to `/activate` / `/refresh`).
  Wire URL unchanged from alpha.1 — only the split between base and path moves —
  but CLI users porting `DEVAGENT_LICENSE_SERVER` values can copy them directly
  without producing `/api/v1/api/v1` doubling.
- `crypto.ts: verifySignature` parameter type widened from `LicensePayload` to
  plain `object` so D4 token payloads can run through the same verifier path.
  Runtime body is unchanged (`canonicalize(payload)` + JSON.stringify + verify).
- `crypto.ts: isProductionBuild` exported (was file-local) so `token-key.ts`
  can reuse the same production-resolver plumbing.
- `src/index.ts: VERSION` updated to match `package.json` (was stale at
  `1.0.0-alpha.0`).

### Deprecated

- `CORTEXDEV_LICENSE_SERVER` env variable — superseded by `CORTEXDEV_LICENSE_API_URL`.
  Still honoured in v1.0.x with a logger.warn deprecation; **scheduled for
  removal in v1.1.0** (see docs/d4-design.md §4.2 Q-2=B).

### Security

- Independent trust roots for D4 token signing vs. license payload signing.
  Compromise of one no longer forges the other.
- `publicKeysEqual()` DER-byte comparison — re-wrapped identical PEM cannot
  slip past the collision guard.
- CI gate fails loud on PROD_TOKEN_KEY ≡ DEV_TOKEN_KEY or PROD_TOKEN_KEY ≡
  license PROD_KEY (regression guard against silent trust-root downgrade).
- Hostname allowlist on `CORTEXDEV_LICENSE_API_URL` — env override cannot
  redirect license traffic to attacker-controlled hosts.

## [1.0.0-alpha.1] - 2026-06-14

### Changed

- License API production URL switched from `https://license.cloudrouter.online`
  to `https://license.clouditera.online`. Same Cloudflare account / same Workers
  runtime — only the domain changes. `CORTEXDEV_LICENSE_API_URL` override still
  takes precedence. No request/response schema or error-code changes.

## [1.0.0-alpha.0] - 2026-06-09

### Added

- Project scaffold: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
- ESLint + Prettier + tsup + vitest toolchain
- `Result<T, E>` utility (replaces external `@shared/result` dependency)
- CI workflow (macOS / Linux / Windows × Node 18/20/22)
- Release workflow (publish to GitHub Packages on `v*` tag)
- README, LICENSE pointer
- Initial empty `src/index.ts` exporting `VERSION` and `Result` helpers

### Pending (per requirements doc §F1–F9)

- `types.ts` — license payload / status / activation meta types
- `crypto.ts` — ECDSA P-256 signature verification with legacy key fallback
- `schema.ts` — payload field validation
- `fingerprint.ts` — cross-platform device fingerprint collection
- `store.ts` — atomic file I/O for license.json / activation.json
- `validator.ts` — 7-step validation pipeline
- `online-client.ts` — HTTP client for license.cloudrouter.online
- `license-service.ts` — state machine and lifecycle orchestration
