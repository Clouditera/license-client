# @clouditera/license-client

> Standalone license management module extracted from `CortexDev-Agents/src/main/core/license/`.
> Status: **alpha (v2.0.0-alpha.1)** — RFC-002 schema v2 (product / product_version) landed.

## 范围

为 DevAgent-App、DevAgent-CLI (pro edition)、DevEye、CloudShield 及未来产品提供统一的 license 校验与生命周期管理。**事实统一源**（single source of truth），替代当前两份内嵌实现（CortexDev-Agents 主进程 + cortexdev-pro CLI 内部）。

完整需求文档：[`docs/requirements.md`](./docs/requirements.md) · v2 schema：见上游 license-tools 仓的 [RFC-002](https://github.com/Clouditera/license-tools/blob/main/docs/rfc/rfc-002-product-version-fields.md)。

## 核心约束

- **行为不变**：本模块是原样抽取，与现有 `src/main/core/license/` 字节级等价
- **零运行时第三方依赖**：仅 `node:crypto` / `node:fs` / `node:path` / `node:os` / `globalThis.fetch`
- **Node 18+**，TypeScript 5.x，ESM + CJS 双产物
- **不支持浏览器 / Renderer**

## 安装

V1 阶段（NPM 内部 registry 未就绪）：

```bash
# Git URL + tag（推荐）
pnpm add git+ssh://git@github.com/Clouditera/license-client.git#v1.0.0

# 或 GitHub Packages
echo "@clouditera:registry=https://npm.pkg.github.com" >> .npmrc
pnpm add @clouditera/license-client
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
} from '@clouditera/license-client';

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
} from '@clouditera/license-client';

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

## Product binding (v2 schema, RFC-002)

从 v2.0.0-alpha.1 开始，license payload 支持两个新字段用于 SKU 级绑定：

- **`product`** — 产品代码（case-sensitive 精确匹配）
- **`product_version`** — 严格 SemVer range，如 `'*'`、`'>=1.0.0 <2.0.0'`、`'^1.2.3'`

Host product 在 bootstrap 时通过 setter 声明自己身份：

```typescript
import { setHostProductIdentity } from '@clouditera/license-client';

setHostProductIdentity({
  product: 'devagent-cli',          // 见下方 KNOWN_PRODUCTS 常量
  version: '1.0.0-alpha.6',         // 通常从 host 自己的 package.json 读
});
```

license-client 在 activate + refresh 时会自动校验：

- **v1 payload**（无 `product` / `product_version`）→ 通过（legacy tolerance）
- **v2 payload + host identity 未注入** → 通过 **但触发 warning**：`serviceLogger.warn` 会记录一行 `[license-client] product identity not set; skipping v2 checks — this is a bug in the host bootstrap`
- **v2 payload + product 不匹配** → `LicenseStatus { state: 'error', reason: 'product_mismatch' }`
- **v2 payload + product 匹配但 version 不满足范围** → `reason: 'product_version_mismatch'`
- **v2 payload 但 `product_version` 不是合法 range** → `reason: 'product_version_range_invalid'`

出错的 `LicenseStatus` 会带 `productCompat` 字段用于 UI 提示（license/host 两侧的实际值）。

### 已知产品

`KNOWN_PRODUCTS` 常量列出当前发放 license 的产品：

```typescript
import { KNOWN_PRODUCTS } from '@clouditera/license-client';
// ['devagent-cli', 'devagent-app', 'deveye', 'cloudshield']
```

**仅供文档 / IDE autocomplete，不做 runtime 强制**。ProductCode 类型是 `string`，未来新增产品**无需 bump license-client 版本**：admin 用新字符串签 license，新 host 传同一字符串给 setter 即可。

### SemVer 语义

`product_version` 使用**严格** SemVer：`>=1.0.0 <2.0.0` **不匹配** `1.0.0-alpha.6`（prerelease 严格小于 release）。admin 想覆盖 alpha 客户端必须显式写 `>=1.0.0-alpha.6 <1.0.1`。详细规则见 `src/semver-satisfies.ts` 文件头注释。

### Feature flag

```typescript
import { LICENSE_SCHEMA_V2_SUPPORTED } from '@clouditera/license-client';
```

Runtime 常量，本 build 是否支持 v2。跨包 test / adapter 可用它探测能力，避免对 `VERSION` 字符串做 SemVer 解析。

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
