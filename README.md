# @clouditera/license-mgr

> Standalone license management module extracted from `CortexDev-Agents/src/main/core/license/`.
> Status: **scaffold (v1.0.0-alpha.0)** — implementation in progress.

## 范围

为 DevAgent-App、DevAgent-CLI、DevEye、DevEyeProd 及未来产品提供统一的 license 校验与生命周期管理。**事实统一源**（single source of truth），替代当前两份内嵌实现（CortexDev-Agents 主进程 + cortexdev-pro CLI 内部）。

完整需求文档：`CortexDev-Agents/docs/dev/license-standalone/license-standalone-requirements.md`

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

## 快速接入

```typescript
import { LicenseService } from '@clouditera/license-mgr';

const service = new LicenseService({
  configDir: '/Users/foo/.cortexdev-pro',
  isProductionBuild: true,
  logger: console,
});

await service.initialize();
const status = service.getStatus();
if (status.state === 'active') {
  // 主流程
}
```

## 开发

```bash
pnpm install
pnpm test          # 单元测试
pnpm test:coverage # 覆盖率（目标 ≥90%）
pnpm typecheck
pnpm lint
pnpm build         # 输出到 dist/
pnpm ci            # 本地完整 CI（fail-fast）
```

## 模块结构（规划）

| 文件 | 对应现有 | 状态 |
|---|---|---|
| `src/result.ts` | （新增，替代 `@shared/result`） | ✅ scaffold |
| `src/types.ts` | `src/main/core/license/types.ts` | ⏳ |
| `src/crypto.ts` | `src/main/core/license/crypto.ts` | ⏳ |
| `src/schema.ts` | `src/main/core/license/schema.ts` | ⏳ |
| `src/fingerprint.ts` | `src/main/core/license/fingerprint.ts` | ⏳ |
| `src/store.ts` | `src/main/core/license/store.ts` | ⏳ |
| `src/validator.ts` | `src/main/core/license/validator.ts` | ⏳ |
| `src/online-client.ts` | `src/main/core/license/online-client.ts` | ⏳ |
| `src/license-service.ts` | `src/main/core/license/license-service.ts` | ⏳ |

## 路线图

详见上游需求文档 §1.4 Phase 1–8。本仓库当前处于 Phase 1（抽取与发布）。

## License

UNLICENSED — 内部使用。
