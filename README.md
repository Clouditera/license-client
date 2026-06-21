# @clouditera/license-mgr

> Standalone license management module extracted from `CortexDev-Agents/src/main/core/license/`.
> Status: **alpha (v1.0.0-alpha.0)** — port complete, awaiting downstream wire-up.

## 范围

为 DevAgent-App、DevAgent-CLI、DevEye、DevEyeProd 及未来产品提供统一的 license 校验与生命周期管理。**事实统一源**（single source of truth），替代当前两份内嵌实现（CortexDev-Agents 主进程 + cortexdev-pro CLI 内部）。

完整需求文档：[`docs/requirements.md`](./docs/requirements.md)

## 核心约束

- **行为不变**：本模块是原样抽取，与现有 `src/main/core/license/` 字节级等价
- **零运行时第三方依赖**：仅 `node:crypto` / `node:fs` / `node:path` / `node:os` / `globalThis.fetch`
- **Node 18+**，TypeScript 5.x，ESM + CJS 双产物
- **不支持浏览器 / Renderer**

## 安装

V1 阶段（NPM 内部 registry 未就绪）：

```bash
# Git URL + tag（推荐）
pnpm add git+ssh://git@github.com/Clouditera/license-mgr.git#v1.0.0

# 或 GitHub Packages
echo "@clouditera:registry=https://npm.pkg.github.com" >> .npmrc
pnpm add @clouditera/license-mgr
```

## 解耦设计

模块对宿主环境的依赖（Electron `app`、`@main/lib/logger`、内置 Pro 二进制下载器等）通过 **module-level setter 注入**实现，默认值都是 no-op 或安全 fallback。宿主在启动时按需注入：

| Setter | 注入对象 | 默认行为 |
|---|---|---|
| `setProductionBuildResolver(fn)` | `() => boolean`，判断是否打包发布 | `() => false`（dev 模式） |
| `setLogger(impl)` | crypto 模块的 debug 日志 | no-op |
| `setLegacyKeyHitListener(fn)` | LEGACY-key 命中遥测 | `null` |
| `setServiceLogger(impl)` | LicenseService 的 warn/error 日志 | no-op |
| `setHostEnvironment(env)` | `isPackaged()` / 可选 `getUserDataDir()` | `isPackaged: () => false` |
| `setBinaryDownloadHooks(hooks)` | 可选的 Pro 二进制清理 / 自动下载钩子 | 不执行（CLI 宿主无需提供） |

## 快速接入

### Electron 主进程（DevAgent-App）

```typescript
import { app } from 'electron';
import { log } from './main/lib/logger.js';
import {
  licenseService,
  setHostEnvironment,
  setServiceLogger,
  setProductionBuildResolver,
  setLegacyKeyHitListener,
} from '@clouditera/license-mgr';

setProductionBuildResolver(() => app.isPackaged);
setHostEnvironment({
  isPackaged: () => app.isPackaged,
  getUserDataDir: () => app.getPath('userData'),
});
setServiceLogger(log);
setLegacyKeyHitListener((label) => log.warn(`legacy-key hit: ${label}`));

await licenseService.initialize();
const status = licenseService.getStatus();
if (status.state === 'active') {
  // 主流程
}
```

### CLI 宿主（DevAgent-CLI / DevEye）

```typescript
import {
  LicenseService,
  setHostEnvironment,
  setProductionBuildResolver,
} from '@clouditera/license-mgr';

setProductionBuildResolver(() => true);
setHostEnvironment({ isPackaged: () => true });

const service = new LicenseService();
await service.initialize();
```

## 公共 API

```typescript
// Top-level orchestrator
LicenseService, licenseService

// Validation pipeline
validateLicense(licenseFile, fingerprint, opts?)
validatePayload(payload)
isExpired(payload)
isExpiredWithServerTime(payload, serverTime?)

// Crypto
verifySignature(payload, signature, publicKey?)
canonicalize(obj)
getPublicKey()
LEGACY_KEY_SUNSET

// Device fingerprint
collectFingerprint(opts?)
collectFingerprintComponents()
matchFingerprint(expected, collected)

// Persistence
readLicense(configDir), writeLicense, deleteLicense
readActivationMeta(configDir), writeActivationMeta
resolveConfigDir(), getLicenseDir(configDir)

// Online client
onlineActivate(req), onlineRefresh(req)

// Injection setters
setHostEnvironment, setServiceLogger, setProductionBuildResolver,
setLogger, setLegacyKeyHitListener, setBinaryDownloadHooks

// Result helpers
ok(value), err(error)
```

完整类型导出见 `src/index.ts`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CORTEXDEV_PUBLIC_KEY` | 内置 DEV/PROD/LEGACY keys | 覆盖签名验证公钥 |
| `CORTEXDEV_LICENSE_API_URL` | `https://license.clouditera.online` | 覆盖 license server 地址 |
| `CORTEXDEV_CONFIG_DIR` | `~/.cortexdev-pro` | 覆盖 config 根目录 |
| `CORTEXDEV_PRO_CONFIG_DIR` | （fallback） | 旧名，向后兼容 |

## 开发

```bash
pnpm install
pnpm test          # 单元测试（vitest）
pnpm test:coverage # 覆盖率（目标 ≥90%）
pnpm typecheck
pnpm lint
pnpm build         # 输出到 dist/（ESM + CJS + d.ts）
pnpm ci            # 本地完整 CI（fail-fast）
```

## 模块结构

| 文件 | 对应现有 | 状态 |
|---|---|---|
| `src/result.ts` | （新增，替代 `@shared/result`） | ✅ |
| `src/types.ts` | `src/main/core/license/types.ts` | ✅ |
| `src/crypto.ts` | `src/main/core/license/crypto.ts` | ✅ |
| `src/schema.ts` | `src/main/core/license/schema.ts` | ✅ |
| `src/fingerprint.ts` | `src/main/core/license/fingerprint.ts` | ✅ |
| `src/store.ts` | `src/main/core/license/store.ts` | ✅ |
| `src/validator.ts` | `src/main/core/license/validator.ts` | ✅ |
| `src/online-client.ts` | `src/main/core/license/online-client.ts` | ✅ |
| `src/license-service.ts` | `src/main/core/license/license-service.ts` | ✅ |

## 诊断工具

`scripts/` 目录下两个独立脚本，用于排查"客户端 `verifyOnlineCheckToken` 返回 `invalid_signature` 但 `/refresh` 本身成功"这一类问题（典型代表：上游 `devagent-cli#228`）。

| 脚本 | 跑在哪里 | 作用 |
|---|---|---|
| `scripts/diagnose-token-key.mjs` | 客户端本地（Node） | 打印客户端嵌入的 `PROD_TOKEN_KEY` / `DEV_TOKEN_KEY` 的 SHA-256 DER 指纹；若给出 `online-check.json` 路径还会本地验签 |
| `scripts/server-side-fingerprint-worker.ts` | 服务端 Cloudflare Worker | 从 `env.TOKEN_SIGNING_KEY` 读私钥 → 派生公钥 → 输出 SHA-256 DER 指纹 + 与客户端 expected 的对比结果 |

### 用法

**客户端：**

```bash
pnpm diagnose:token-key                          # 自动找 ~/.devagent-pro/license/online-check.json
pnpm diagnose:token-key /path/to/online-check.json
```

**服务端**（Cloudflare Worker — DEPLOY → CALL ONCE → DELETE）：

1. 把 `scripts/server-side-fingerprint-worker.ts` 集成进生产 Worker（或作为独立 Worker 部署）
2. `wrangler secret put ADMIN_DIAG_TOKEN`（32 字节随机值）
3. `wrangler deploy`
4. `curl -H "X-Admin-Token: <token>" https://<worker>/admin/token-key-fingerprint`
5. 比对返回 JSON 里的 `sha256_der` 与 `expected` 是否一致
6. **收尾**：从源码删除该路由 → `wrangler deploy` → `wrangler secret delete ADMIN_DIAG_TOKEN`

三种结果的诊断含义见脚本文件头部注释。

## 路线图

详见上游需求文档 §1.4 Phase 1–8。当前处于 Phase 1（抽取与发布）末尾，正准备 Phase 2（CortexDev-Agents 接入替换）。

## License

UNLICENSED — 内部使用。
