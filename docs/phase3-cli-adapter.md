# Phase 3 — DevAgent-CLI adopts `@clouditera/license-mgr@1.0.0-alpha.2`

> **状态**：草案 v0.1
> **日期**：2026-06-17
> **作者**：lc-kendo（与 AI 协作起草）
> **范围**：CLI side of the Phase 3 migration described in `docs/requirements.md` §1.4
> **依赖**：`@clouditera/license-mgr@1.0.0-alpha.2` (tag `v1.0.0-alpha.2`, commit `cfaaa05`)
> **关联**：[License-Mgr#2 closed](https://github.com/Clouditera/License-Mgr/issues/2)，docs/d4-design.md

---

## 0. 目的

DevAgent-CLI 现状有一份完整的内嵌 license 实现（`packages/core/src/license/` + `packages/devagent-pro/src/license/`）。Phase 3 的目的是让 CLI **跑** `@clouditera/license-mgr` 作为统一信任源，**不丢任何功能、不改任何客户行为**，再按 §1.4 Phase 4 灰度全量、Phase 5 删旧码。

本文档**不是**实施清单（那会随设计阶段产出），而是 CLI 集成的**起点材料**——dependency 怎么钉、注入点在哪、API 怎么映射、灰度怎么开、何时算 done。

---

## 1. 依赖钉死（§N7 R5 已对齐）

NPM 内部 registry 暂不可用，按 Git URL + tag 钉死：

```json
// packages/devagent-pro/package.json
{
  "dependencies": {
    "@clouditera/license-mgr": "git+ssh://git@github.com/Clouditera/license-mgr.git#v1.0.0-alpha.2"
  }
}
```

**为什么钉 tag 而非 commit**：alpha.2 已经把 5-piece trust-root suite + CI gate 锁死了，未来 alpha.3 / beta 不会动接口；钉 tag 让我们能在 release pipeline 改进时自然往前升。

**Wire URL 不变**：alpha.2 的 `PRODUCTION_BASE_URL = https://license.clouditera.online/api/v1`，与 CLI legacy `DEFAULT_LICENSE_SERVER` 字节一致。不需要先升 server。

---

## 2. CLI bootstrap 注入点

license-mgr 用 module-level setter 模式注入宿主信息（不是构造参数）。CLI bootstrap（`packages/devagent-pro/src/cli.js`）在最早的 license 调用之前必须跑一次：

```js
import {
  setHostEnvironment,
  setServiceLogger,
  setOnlineClientLogger,
  setProductionBuildResolver,
  setLogger,           // crypto.ts logger
} from '@clouditera/license-mgr';
import { isProductionBuild } from '@clouditera/core/license/crypto';  // CLI legacy resolver

// crypto.ts production resolver
setProductionBuildResolver(() => isProductionBuild());

// LicenseService host environment
setHostEnvironment({
  isPackaged: () => isProductionBuild(),
  // No Pro binary download in CLI — leave getUserDataDir undefined
  // CLI legacy uses 60-day grace; pass through to keep user behaviour unchanged.
  offlineGraceDays: 60,
  // Hard compliance mode honours CLI env var
  requireSignedToken: process.env.LICENSE_REQUIRE_SIGNED_TOKEN === 'true',
});

// Route license-mgr logger through CLI's existing logger
setServiceLogger(cliLogger);
setLogger(cliLogger);
setOnlineClientLogger(cliLogger);

// NO binary download hooks — CLI bundles its own binaries
// setBinaryDownloadHooks() NOT called
```

**Key decisions baked in**：
- `offlineGraceDays: 60` — preserves CLI 60-day legacy grace (license-mgr default is 14, which would be a downgrade)
- `requireSignedToken` reads CLI's existing `LICENSE_REQUIRE_SIGNED_TOKEN` env so the compliance flag keeps working
- `setBinaryDownloadHooks()` deliberately not called — CLI distributions bundle the pro binary themselves

---

## 3. API 映射表（CLI legacy → license-mgr）

| CLI legacy 调用点 | 现状 API | 替换为 license-mgr API | 字节等价? |
|---|---|---|---|
| `cli.js: import('./license/activate.js').activateLicense(licenseFilePath, configDir)` | local `activateLicense` | `licenseService.activateFromFile(licenseFilePath)` | ✅ |
| `cli.js: import('./license/gate.js').checkLicense(configDir)` | local `checkLicense` | composition: `licenseService.initialize()` + `licenseService.getStatus()` + `licenseService.checkOfflineGrace()` | ✅ |
| `cli.js: import('./license/gate.js').printLockoutBox(reason, license)` | UI helper, stays in CLI | **NOT migrated** — UI presentation is adapter concern | — |
| `packages/core/src/license/validator.js: validateLicense(...)` | 5-step pipeline | `import { validateLicense } from '@clouditera/license-mgr'` — runs 7-step pipeline (incl. clock A/B anti-rollback) | ⚠️ stricter (see §3.1) |
| `packages/core/src/license/crypto.js: verifySignature` | 直接调用 | `import { verifySignature } from '@clouditera/license-mgr'` | ✅ canonicalize byte-identical |
| `packages/devagent-pro/src/license/refresh.js: refreshLicense / shouldRefresh` | refresh + jitter | `licenseService.doRefreshNow()` + LicenseService 内置 schedule | ⚠️ schedule semantics differ (see §3.2) |
| `packages/devagent-pro/src/license/gate.js: checkOfflineGrace(configDir)` | Path A / Path B decision tree | `licenseService.checkOfflineGrace()` returning `OfflineGraceResult` | ✅ byte-equivalent |
| `packages/devagent-pro/src/license/gate.js: updateOnlineCheckTimestamp(configDir)` | bumps last_online_check preserving signed_token | currently no direct API — gate semantics fold into `_handleRefreshSuccess` | ⚠️ 需要 adapter shim 或 license-mgr 加 API |
| `packages/devagent-pro/src/license/online-check.js: verifyOnlineCheckToken(...)` | local verifier | `import { verifyOnlineCheckToken } from '@clouditera/license-mgr'` | ✅ |
| `packages/core/src/license/token-key.js: EMBEDDED_TOKEN_PUBLIC_KEY` | local key | `import { EMBEDDED_TOKEN_PUBLIC_KEY } from '@clouditera/license-mgr'` | ✅ same PEM bytes |
| `packages/core/src/license/server-url.js: resolveLicenseServerURL` | env + allowlist | license-mgr applies allowlist internally; CLI no longer calls this directly | ✅ |

### 3.1 Validator 步数差异

license-mgr `validateLicense` 跑 7 步（多 `issued_at - 60s` 防回拨 + `lastVerifiedAt - 60s` 防回拨）；CLI legacy 跑 5 步。

**影响**：CLI 现有 license 文件**应当全部通过** 7 步——因为 `issued_at` 是 server 签的过去时间，本机时钟正常时 7 步必过。**但** 若用户机器时钟回拨到 license 签发前，alpha.2 会拒绝、legacy 会接受。

**处理**：这是 license-mgr 的预期行为（防 grace 时间被人手动延长）。Phase 4 灰度对照监控"拒签率"是否突涨——若涨，定位是不是时钟回拨场景占多大比例，再决定是否 expose 一个 `skipClockChecks: boolean` 开关。

### 3.2 Refresh schedule 差异

| | CLI legacy | license-mgr alpha.2 |
|---|---|---|
| 默认间隔 | 3 天 ± 10% jitter | 24 小时 |
| 启动 budget | 5 秒 | 无（不限制） |
| 失败重试 | 30 分钟 | 30 分钟 |

**影响**：alpha.2 比 CLI 高频。这不是 R1 等价问题（CLI legacy 自己也用了不同时间常量给 App 和 CLI），但 24h 对 CLI 用户来说**过多** — server 端会看到 3x 流量。

**处理选项**：
- (A) license-mgr 加 `HostEnvironment.refreshIntervalMs?: number` 注入点，CLI 传 `3 * 24 * 60 * 60 * 1000`。**已落地于 v1.0.0-alpha.3**——同时加了 `refreshStartupBudgetMs?: number`（CLI 传 5000，匹配 `STARTUP_BUDGET_MS`）。
- (B) ~~CLI adapter 内部 bypass LicenseService schedule，自己 setTimeout 调 `licenseService.doRefreshNow()`。~~ 已否决——schedule 是 LicenseService 状态机的一部分。

CLI bootstrap 现在写成：

```js
setHostEnvironment({
  isPackaged: () => isProductionBuild(),
  offlineGraceDays: 60,
  requireSignedToken: process.env.LICENSE_REQUIRE_SIGNED_TOKEN === 'true',
  refreshIntervalMs: 3 * 24 * 60 * 60 * 1000,
  refreshStartupBudgetMs: 5000,
});
```

### 3.3 `updateOnlineCheckTimestamp` 没有直接对应

CLI gate.js 在 license 启动时（且 license valid）调 `updateOnlineCheckTimestamp(configDir)`——**保留**已有 `signed_token` + `server_time` 同时刷新 `last_online_check`。license-mgr 没有直接对应的方法。

**两种解决**：
- (A) license-mgr 加 `LicenseService.bumpLastOnlineCheck()`，封装"读 + 重写保留可选字段"
- (B) CLI adapter 直接 `import { readOnlineCheck, writeOnlineCheck } from '@clouditera/license-mgr'`，自己写 1 行 helper

后者更轻，**推荐 (B)**——这是 store 层暴露出来的 primitive，本来就是给 adapter 用的。

---

## 4. 双实现并存灰度（§1.4 Phase 2 / Phase 3 同款）

CLI 仓库内：

```js
// packages/devagent-pro/src/license/index.js  (new adapter shim)
const useLicenseMgr = process.env.CORTEXDEV_LICENSE_IMPL === 'core';

export async function checkLicense(configDir, options) {
  if (useLicenseMgr) {
    return (await import('./adapter-core.js')).checkLicense(configDir, options);
  }
  return (await import('./gate.js')).checkLicense(configDir, options);
}
// repeat for activate, refresh, deactivate
```

**Default**：legacy（与 §1.4 Phase 2 一致）。

**灰度路径**：
1. **dogfood 1-2 周** — internal users 设 `CORTEXDEV_LICENSE_IMPL=core`
2. **Phase 4 灰度全量** — default 改 `core`，观察 2 周
3. **Phase 5 删除 legacy** — 移除 `packages/core/src/license/` + `packages/devagent-pro/src/license/{gate,activate,refresh,validator,...}.js`，保留 adapter shim 作为 thin layer 或直接 inline 调 license-mgr。同时移除 `CORTEXDEV_LICENSE_IMPL` env。

---

## 5. 监控埋点（Phase 4 灰度对照必备）

CLI 现在的埋点（如果有）需要补对照：

| 指标 | legacy 实现 | core 实现 | 判断 |
|---|---|---|---|
| activate 成功率 | 已有? | 同源 fetch wrapper，自然对齐 | core ≥ legacy |
| refresh 成功率 | 已有? | 同上 | core ≥ legacy |
| 各状态分布（active / expired / revoked / error） | gate.js 状态 | LicenseService.getStatus().state | 偏移 < 1% |
| 错误码分布（DEVICE_LIMIT / REVOKED / NOT_FOUND / api / network） | online-client | OnlineClientError.type | 完全对齐（同 server） |
| validator 拒签率 | 5 步 | 7 步 | core 可能略高 (§3.1)，需要分时钟正常 vs 回拨 |
| D4 Path A 命中率 | gate.js Path A vs Path B | source: 'signed_token' vs 'last_online_check' | core ≥ legacy（都用同样 token） |

灰度结束门槛：**core 与 legacy 在前 4 行指标上无显著偏移 ≥ 2 周**。

---

## 6. 已知阻塞 & 建议 Pre-work

ship Phase 3 前必须解决：

| # | 项 | 解决方 | 风险 | 状态 |
|---|---|---|---|---|
| B1 | `refreshIntervalMs` / `refreshStartupBudgetMs` HostEnvironment 注入点（§3.2） | license-mgr v1.0.0-alpha.3 | 中 — 不解决 CLI 流量翻 3x | ✅ **解决于 [v1.0.0-alpha.3](https://github.com/Clouditera/License-Mgr/releases/tag/v1.0.0-alpha.3) / License-Mgr#3** |
| B2 | `updateOnlineCheckTimestamp` shim 决策（§3.3） | CLI adapter 内部实现 | 低 — 用 store primitive 就够 | 待 CLI 实施时定 |
| B3 | GitHub Actions billing 问题（alpha.2 release workflow 没跑） | 账户层 | 低 — 本地 ci 全绿，发布只是 npm packages 推不上 | 待账户处理 |
| B4 | CLI 仓库 dogfood 用户名单 + dogfood 周期 | 团队对齐 | — | 待 |

建议：
- B1 立刻在 license-mgr 开 issue + 1-2 天内 ship alpha.3
- B2 / B3 / B4 可以并行做

---

## 7. 验收清单（Phase 4 → 5 推进前必须满足）

- [ ] alpha.3 含 `HostEnvironment.refreshIntervalMs / refreshStartupBudgetMs` (or alpha.2 接受 24h 间隔)
- [ ] CLI adapter shim 落地 + `CORTEXDEV_LICENSE_IMPL=core|legacy` 开关
- [ ] 监控埋点对照表（§5）数据上墙
- [ ] dogfood 1-2 周：core 实现激活/刷新成功率 ≥ legacy
- [ ] 跨平台冒烟：macOS / Linux / Windows 各跑一次 activate + offline + refresh
- [ ] 多消费者并存测试：DevAgent-App + CLI 同时跑 core，license 文件读写无冲突（§R7）
- [ ] 文档更新：CLI README + CHANGELOG 标注 license-mgr 依赖 + 灰度方式

满足后默认 core 2 周观察，再 Phase 5 删 legacy。

---

## 8. Open questions

### Q-A：alpha.3 的 schedule 注入 vs CLI adapter 写 schedule

§3.2 我推荐 alpha.3 加注入点。但 alpha.3 不存在的情况下，CLI adapter 可以**完全 bypass LicenseService internal schedule**——CLI 自己用 `cron` / `setTimeout` 调 `licenseService.doRefreshNow()`。

代价：状态机 schedule 与外部 schedule 不一致；refresh 失败后 `_scheduleNextRefresh(REFRESH_RETRY_MS)` 还是会 fire 一个 24h 后的 timer，无害但浪费。

**决策**：等团队拍。我**强烈倾向**加注入点（一致性优于工期）。

### Q-B：dogfood 周期长度

§1.4 写 "1-2 周"。但 alpha.2 跨度大（D4 + allowlist + env + URL），保守 2 周。

### Q-C：监控埋点怎么发送

CLI 现状是否有 telemetry pipeline？如果没有，Phase 4 灰度对照怎么定量？

需要团队对齐 telemetry pipe（OTel / Sentry / 自己 endpoint）+ alpha.3 内 LicenseService 是否需要 emit hook。

---

## 9. 参考

- License-Mgr v1.0.0-alpha.2 tag: `cfaaa05`
- License-Mgr#2 (closed): D4 + R1 catch-up tracking
- `docs/d4-design.md`: 5-piece trust-root architecture + Q-1..Q-5 decisions
- `docs/requirements.md` §1.4 Phase 2-5: 灰度策略原文
- CLI legacy gate.js: `Path A: server-signed online_check_token (D4)` 注释为对照基线
