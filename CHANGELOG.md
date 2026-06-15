# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
