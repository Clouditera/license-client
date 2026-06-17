# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-alpha.2] - 2026-06-17

D4 (`online_check_token`) + R1 byte-equivalence catch-up against CLI legacy.
First version of `@clouditera/license-mgr` that DevAgent-CLI (or any future
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
  Default 14 (preserves license-mgr pre-D4 contract); CLI adapter passes 60.
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
