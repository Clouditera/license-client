# License 管理独立模块 需求文档

> **状态**：草案 v0.7（D4 + R1 等价性回补已实现于 v1.0.0-alpha.2）
> **日期**：2026-06-09
> **作者**：lc-kendo（与 AI 协作起草）
> **范围**：原样抽取现有 License 能力为独立模块，**行为不变、形态独立**
> **目标产物**：独立仓库 `@clouditera/license-mgr`（NPM 包），供 DevAgent-App、DevAgent-CLI、DevEye、DevEyeProd 及未来产品共享

---

## 〇、关键决策（已对齐）

| # | 决策点 | 选择 |
|---|---|---|
| 1 | 抽取目标 | **原样抽取**，行为/状态机/HTTP 契约/错误码/数据格式**全部维持**与现有 `src/main/core/license/` 一致 |
| 2 | 在线能力 | **保留**：activate、refresh、14 天离线宽限、远程吊销、设备数管控、时钟防回拨 |
| 3 | 公钥分发 | **嵌入式**（主模块内置 PROD_KEY + LEGACY_KEYS） |
| 4 | 多语言绑定 | **不做**（仅 TypeScript / Node.js / Electron） |
| 5 | 仓库归属 | **独立仓库** `Clouditera/license-mgr` |
| 6 | 内部 NPM registry | **暂不可用**，走 Git URL + tag 或 GitHub Packages |
| 7 | 签发端归属 | 在 `Clouditera/devagent-cli` 仓库（与 DevAgent-CLI 同仓） |
| 8 | 消费者关系 | **同产品线内对等共享**（DevAgent-App ↔ DevAgent-CLI 共享 license；DevEye ↔ DevEyeProd 共享 license；跨产品线独立），与当前 DevAgent 系现状一致 |
| 9 | `product_codes` 字段 | **分阶段引入**：本期（仓库迁移阶段）**不引入**，行为与现状一致；DevAgent 系仓库迁移完成后（§1.4 Phase 7）引入，配合签发端协同改造 |
| 10 | 双指纹兼容期 | **不引入**（只暴露单指纹 API，与现状一致） |
| 11 | License 路径策略（R9 落地） | **产品线分组独立**：DevAgent 系沿用 `~/.cortexdev-pro/license/`；DevEye 系用各自 configDir（如 `~/.deveye/license/` 与 `~/.deveye-prod/license/`）。跨线 license 不共用 |
| 12 | DevEye / DevEyeProd 形态（R10 落地） | **CLI**（与 DevAgent-CLI 同形态，无 IPC / 渲染层适配负担） |

**核心立场**：本次是**纯重构 / 提取**，不是新功能开发。代码搬家 + 包形态独立，调用方升级后**应当感知不到任何行为差异**。

---

## 一、背景与目标

### 1.1 现状

**License 逻辑当前存在两份内嵌实现**：

| 仓库 | 路径 | 语言 |
|---|---|---|
| DevAgent-App | `src/main/core/license/` | TypeScript |
| DevAgent-CLI（`Clouditera/devagent-cli`，本仓 vendor 引用） | `packages/core/src/license/` | JavaScript |

**两份实现的关系**：

- 算法上**字节级一致**（指纹生成、canonicalize、签名校验）
- 同步靠**手工维护**：任一端改了算法/常量，另一端必须同步修改并跑回归测试
- 一旦签发端 ↔ Agents ↔ CLI 三方不一致，存量 license 立即失效

**当前能力清单**（DevAgent-App 侧）：

| 模块 | 行数 | 职责 |
|---|---|---|
| `license-service.ts` | 777 | 状态机 + 生命周期编排（initialize / activate / refresh / deactivate） |
| `validator.ts` | 151 | 7 步校验流水线 |
| `crypto.ts` | 308 | ECDSA P-256 签名校验 + 多公钥回退 |
| `fingerprint.ts` | 292 | 跨平台设备指纹采集 + 24h 缓存 |
| `online-client.ts` | 223 | `license.cloudrouter.online` HTTP 客户端（activate/refresh） |
| `store.ts` | 175 | License 文件读写（原子 + 共享 `~/.cortexdev-pro/license/`） |
| `schema.ts` | 148 | Payload 字段校验 |
| `controller.ts` | 212 | IPC `license.*` RPC 暴露 |
| `types.ts` | 266 | 判别联合类型定义 |

**已实现的全部能力**：

- ✅ 离线签名校验（ECDSA P-256，主 PROD_KEY + LEGACY_KEYS 回退）
- ✅ 设备指纹采集与匹配（macOS / Linux / Windows，24h 缓存）
- ✅ 过期检查（`expires_at`，含服务器时间防伪）
- ✅ 时钟防篡改（`issued_at` 下限 + `last_verified_at` 回拨检测）
- ✅ 在线激活（`POST /api/v1/activate`，写 `activation_id`）
- ✅ 在线刷新（`POST /api/v1/refresh`，启动 + 24h 周期 + 失败 30min 重试 + 手动触发）
- ✅ 14 天离线宽限期（剩余 ≤3 天 UI 警告，超 14 天置 `expired`）
- ✅ 远程吊销（持久化 `server_status.revoked=true`，下次启动门控）
- ✅ 设备数限制（HTTP 409 → `device_limit_exceeded`）
- ✅ 状态变更回调（向渲染层广播）
- ✅ Pro 二进制自动下载（激活 Pro 时触发，含进度回调）

### 1.2 目标

将上述能力**整体提取**为独立模块 `@clouditera/license-mgr`，做**事实统一源**（single source of truth），供 DevAgent-App、DevAgent-CLI、DevEye、DevEyeProd 及未来产品共享。

**一句话目标**：消灭两份重复实现，把 license 能力做成**一个仓库、一个包、一套测试、一套发布流程**。

### 1.3 范围

**做**：

- ✅ 整体源码抽取（含测试）到独立仓库 `Clouditera/license-mgr`
- ✅ 解耦 Electron 依赖（`electron.app` / `@main/lib/logger` / `@shared/brand` / `@shared/result` / `@shared/ipc/rpc`）→ 改为构造参数注入
- ✅ 提供 TypeScript 双产物（ESM + CJS），完整 `.d.ts`
- ✅ 提供与现有 `src/main/core/license/` 字节级等价的行为（用现有测试套件回归）
- ✅ HTTP 契约保持不变（端点、请求/响应、错误码、重试策略）
- ✅ License 数据格式保持不变（无新增字段，无字段重命名）
- ✅ 指纹算法保持不变（同一台机器上新旧实现产出相同 hash）

**不做**（明确排除）：

- ❌ 不新增功能（不引入 `product_codes`、不做双指纹、不改状态机）
- ❌ 不修复行为级 bug（只搬代码，bug 留作独立 issue 修复）
- ❌ 不改 HTTP URL、端点路径、错误码语义
- ❌ 不改 license JSON schema 字段
- ❌ 不改 `~/.cortexdev-pro/license/` 路径解析逻辑
- ❌ 不做多语言绑定（Go / Rust / Python）
- ❌ 不做浏览器 / WebCrypto 版本
- ❌ 不替换 License 签发后台（仍在 `devagent-cli` 仓库内）
- ❌ 不重写 Activation UI（渲染层零改动）

### 1.4 上线策略

**核心原则**：**抽取 → DevAgent 系基准接入 → DevEye 系新接入 → 旧实现下线**。整个过程对 DevAgent 系行为不变，对 DevEye 系是首次接入。

**接入分组**：

- **基准组（迁移）**：DevAgent-App、DevAgent-CLI — 现状已有内嵌实现，本期目标是平迁
- **扩展组（新接入）**：DevEye、DevEyeProd — 从零接入 license-mgr，不需要"双实现并存"灰度（因为没有 legacy）

```
Phase 1: 抽取与发布（Clouditera/license-mgr 仓库）
  - 从 src/main/core/license/ 整体迁移代码 + 测试到新仓库
  - 解耦 Electron 依赖（参数注入）
  - 同步从 vendor/cortexdev-pro/packages/core/src/license/ 校验算法一致性
  - 发布 @clouditera/license-mgr@1.0.0-alpha.0（Git tag / GitHub Packages）

Phase 2: DevAgent-App 接入（双实现并存）
  - 新增 src/main/core/license/adapter-core.ts 包装新模块
  - 环境变量 CORTEXDEV_LICENSE_IMPL=core|legacy 切换（默认 legacy）
  - 内部 dogfood 1-2 周
  - 监控指标: 激活成功率、刷新成功率、状态分布、错误码分布

Phase 3: DevAgent-CLI 接入（双实现并存）
  - devagent-cli 仓库内同步切换到 @clouditera/license-mgr 依赖
  - 同样保留 legacy 兜底
  - 内部 dogfood 1-2 周

Phase 4: DevAgent 系灰度全量
  - DevAgent-App 默认改为 core，观察 2 周
  - DevAgent-CLI 默认改为 core，观察 2 周

Phase 5: DevAgent 系旧代码删除
  - DevAgent-App 删除 src/main/core/license/{crypto,fingerprint,validator,schema,
    store,license-service,online-client,types}.ts
  - 保留 controller.ts 作为 IPC 适配层（~50 行）
  - DevAgent-CLI 删除 packages/core/src/license/ 整目录
  - 移除 CORTEXDEV_LICENSE_IMPL 环境变量

Phase 6: DevEye / DevEyeProd 接入（扩展组）
  - 形态: CLI（与 DevAgent-CLI 一致，无 IPC / 渲染层适配）
  - configDir: 各自独立（`~/.deveye/license/` 与 `~/.deveye-prod/license/`，最终路径由 DevEye 团队确认）
  - 各自仓库直接依赖 @clouditera/license-mgr（无 legacy 兜底，无切换灰度）
  - 跨线 license 不共用：DevEye 系无法读 DevAgent 系 license，反之亦然（路径隔离）
  - 签发端按产品线签发：用户购买时一次只授权一条产品线
  - 时间窗口与 DevAgent 系解耦，独立排期

Phase 7: 引入 product_codes 强密码学隔离（仓库迁移完成后）
  - 触发条件: Phase 5 完成（DevAgent 系全部切到 license-mgr 后）
  - 改动:
    * license-mgr 校验流水线增加 product_codes 校验（必填，调用方 productCode 必须在列表中）
    * 签发端（Clouditera/devagent-cli 仓库内）schema 加 product_codes 必填字段
    * 存量 license 批量回填工具（按现有 license 所属产品线补 product_codes）
  - 风险: 这是破坏性变更，存量 license 必须先回填才能升级客户端
  - 升级策略:
    * 客户端 license-mgr 升级到引入 product_codes 校验的版本 (≥1.x or 2.0)
    * 同时发布过渡版客户端，对缺失 product_codes 的 license 显示明确提示（"请联系管理员重新签发"）
    * 灰度: 先签发端回填 → 后客户端升级
  - 不在本期范围: 时间排期、技术细节归 license-mgr V1.x / V2.x 单独立项

Phase 8: 其他演进（不在本文档范围）
  - 指纹算法 v2、Web/WebCrypto 版本、其他语言绑定等
```

### 1.5 多消费者关系（路径策略与产品形态已对齐）

**所有消费者对等**——任意消费者都可激活、刷新、失活。**但 license 文件按产品线分组隔离**，不跨线共用。

#### 消费者矩阵

| 消费者 | 形态 | 产品线 | configDir | V1 接入优先级 |
|---|---|---|---|---|
| **DevAgent-App** | Electron 桌面应用 | DevAgent 系 | `~/.cortexdev-pro/license/`（现状路径，不动） | P0（迁移基准） |
| **DevAgent-CLI** | Node.js CLI（即 cortexdev-pro） | DevAgent 系 | `~/.cortexdev-pro/license/`（现状路径，不动） | P0（迁移基准） |
| **DevEye** | Node.js CLI | DevEye 系 | `~/.deveye/license/`（独立） | P1（新接入） |
| **DevEyeProd** | Node.js CLI | DevEye 系 | `~/.deveye-prod/license/`（独立） | P1（新接入） |
| **未来产品 X/Y/Z** | TBD | TBD | 独立 configDir | P2 |

**共享内核**：`@clouditera/license-mgr` 提供 `LicenseService` 类与全部纯函数。所有消费者消费**同一个完整 API**，**不拆 verifier / activator 角色**。

#### License 文件路径策略（R9 已决策：产品线分组）

| 产品线 | 默认 configDir | 现状继承 |
|---|---|---|
| DevAgent 系 | `~/.cortexdev-pro/license/` | 沿用现状，**存量 license 零失效** |
| DevEye 系 | `~/.deveye/license/` 与 `~/.deveye-prod/license/`（同产品线内 DevEye 与 DevEyeProd 是否进一步细分由 DevEye 团队决定） | 新接入，无存量 |
| 未来新产品 | 各自独立 configDir | 新接入 |

**跨线 license 不共用**：

- DevAgent-CLI 激活的 license **不会**被 DevEye 自动识别
- 用户购买 license 时，签发端按产品线签发（一次只授权一条产品线）
- 同一用户购买多个产品线，需要分别激活

**同线内继续共享**：

- 用户在 DevAgent-CLI 激活后，DevAgent-App 自动可用
- 用户在 DevEye 激活后，DevEyeProd 自动可用（若 DevEye 团队选择共享 configDir）

**`product_codes` 的引入时机（关键）**：

- **本期（DevAgent 系仓库迁移 Phase 1-5）**：不引入 `product_codes`，license 通过**路径隔离**实现产品线区分（DevAgent license 放在 DevAgent 目录，DevEye license 放在 DevEye 目录）
- **后续（Phase 7 之后）**：引入 `product_codes` 提供"密码学级"隔离 —— 即便用户把 DevEye license 文件 cp 到 DevAgent 目录也不能用（payload 内含产品线声明，签名覆盖）
- 在 `product_codes` 引入之前，路径隔离是**唯一**的产品线边界，运维上要避免文档/工具引导用户跨线复制 license

#### 冲突场景

- 用户在 DevAgent-CLI 激活 → DevAgent-App 启动时读到 license → 直接 `active`（同线共享）
- 用户在 DevEye 激活 → DevAgent-App **完全不受影响**（跨线隔离）
- DevAgent-CLI `deactivate` → 仅清空 DevAgent 系 license，DevEye 系不受影响
- 同线多消费者同时活跃**不会写冲突**（tmp + rename 原子；activation_id 复用）
- 跨线消费者并存**无任何交互**（目录无关，行为完全独立）



---

## 二、功能需求

### F1. 全量复刻现有 LicenseService

**对应现有**：`src/main/core/license/license-service.ts`（777 行）

完整保留：

- 状态机：`unlicensed` / `validating` / `active` / `expired` / `revoked` / `error`
- 生命周期：`initialize / getStatus / activate / activateFromFile / doRefreshNow / deactivate / dispose`
- 监听回调：`setStatusChangeListener / setDownloadProgressListener / emitDownloadProgress`
- 14 天离线宽限期逻辑（含剩余天数计算与 UI 警告字段）
- 在线 refresh 调度（启动立即触发 + 24h 周期 + 30min 失败重试）
- 远程吊销持久化（`server_status.revoked=true` → 下次启动门控）
- 错误分类（`classifyRefreshRejection`：可用性故障 vs 服务器拒绝）

**调整点（仅解耦 Electron）**：

| 现状 | 抽取后 |
|---|---|
| `import { app } from 'electron'` | 构造参数 `isProductionBuild: boolean`（替代 `app.isPackaged`） |
| `app.getPath('userData')` | 由调用方传入（用于 `cleanupStaleTmp` 等场景） |
| `import { log } from '@main/lib/logger'` | 构造参数 `logger: Logger`（默认 noop） |
| `downloadPro` 直接调用 | 仍直接调用，但 `downloadPro` 模块同步抽取或保留为可选 callback（**待设计阶段决策**） |

### F2. 全量复刻现有 validator

**对应现有**：`src/main/core/license/validator.ts`（151 行）

完整保留 7 步流水线：

```
1. 结构: { payload, signature } 存在
2. Schema: validatePayload(payload)
3. 时钟 A: now ≥ issued_at - 60s
4. 时钟 B: now ≥ lastVerifiedAt - 60s
5. 签名: ECDSA-P256，PROD_KEY → LEGACY_KEYS 回退
6. 指纹: pro 版且 payload.fingerprint 存在时校验
7. 过期: max(serverTime, localTime) ≥ expires_at
```

**不增加步骤**（无 `product_codes` 校验，无 D4 步）。

**D4 决策点不在 validator**：v1.0.0-alpha.2 引入的 D4 `online_check_token` 校验由 `LicenseService.checkOfflineGrace()` 在 state 层承载，与 7 步 validator 解耦，详见 §F1.2 与 `docs/d4-design.md` §3.1。

### F3. 全量复刻现有 crypto

**对应现有**：`src/main/core/license/crypto.ts`（308 行）

完整保留：

- `canonicalize()` 字节级一致（与 CLI 共用算法）
- ECDSA P-256 签名校验
- DEV_KEY / PROD_KEY / LEGACY_KEYS 三层公钥
- `LEGACY_KEY_SUNSET` 日期与 `setLegacyKeyHitListener` 钩子
- 环境变量公钥覆盖**仅在 `isProductionBuild === false` 时生效**

**嵌入式公钥**：

- 内置 DEV_KEY、PROD_KEY、LEGACY_KEYS 三者（与现状完全一致）
- 调用方可通过 `legacyKeys: string[]` 追加更多 legacy 公钥
- 主公钥（PROD_KEY）轮换 → 模块发新版本，调用方升级

### F4. 全量复刻现有 fingerprint

**对应现有**：`src/main/core/license/fingerprint.ts`（292 行）

完整保留：

- 跨平台采集逻辑（macOS `ioreg` / Linux `machine-id` / Windows `wmic`）
- 单组件失败降级
- 24h 缓存（路径与 TTL 不变）
- `skipCache: true` 强制重算

**API 不变**：`collectFingerprint(configDir, opts)` 返回 `string | null`，不引入 v1/v2 双算法。

### F5. 全量复刻现有 online-client

**对应现有**：`src/main/core/license/online-client.ts`（223 行）

完整保留：

- **URL**：`https://license.clouditera.online/api/v1`（生产；base 含 `/api/v1`，与 CLI legacy 字节对齐）
- 环境变量覆盖：`CORTEXDEV_LICENSE_API_URL`（canonical）+ `CORTEXDEV_LICENSE_SERVER`（legacy，**v1.0.x 双名兼容 + warn，v1.1 移除** — 详见 d4-design §4.2）
- 端点（base 之下相对路径）：`POST /activate` 与 `POST /refresh`
- 请求/响应 schema（与现状字节一致）
- 错误码映射：
  - HTTP 409 `DEVICE_LIMIT_EXCEEDED` → `device_limit_exceeded`
  - HTTP 403 `LICENSE_REVOKED` → `license_revoked`
  - HTTP 404 → `not_found`
  - 其他非 2xx → `api_error`
  - 网络/超时 → `network_error`
- 10 秒超时
- 永不抛异常，全部 `Result` 包装

**v1.0.0-alpha.2 新增（R1 等价性回补）**：

- `ALLOWED_LICENSE_HOSTS` 域名 allowlist（与 CLI `server-url.js` 字节对齐）。post() 内部 assert，非 allowlist host 在 fetch 之前同步 throw（misconfig 是启动时错误，不是运行时错误）。
- HTTPS 强制；localhost / 127.0.0.1 例外允许 http。
- `ActivateResponse` / `RefreshResponse` 加可选字段 `online_check_token?: SignedToken`（D4 — server 签发的离线宽限期凭据）；server omit 时 client 不报错（向后兼容 pre-D4 server）。
- `setOnlineClientLogger()` 注入 logger，供 deprecation warn 走宿主日志。

### F6. 全量复刻现有 store

**对应现有**：`src/main/core/license/store.ts`（175 行）

完整保留：

- 路径解析：`CORTEXDEV_CONFIG_DIR` → `CORTEXDEV_PRO_CONFIG_DIR` → `~/.cortexdev-pro/`
- 文件结构：`license/license.json` + `license/activation.json`
- 原子写入（tmp + rename）
- 路径校验（绝对路径 + 拒绝 `..` 穿越）

### F7. 全量复刻现有 schema

**对应现有**：`src/main/core/license/schema.ts`（148 行）

完整保留所有字段校验规则（无新增字段，无字段重命名）。

### F8. 全量复刻现有 types

**对应现有**：`src/main/core/license/types.ts`（266 行）

完整保留所有判别联合类型：

- `LicenseStatus`、`LicenseFile`、`LicensePayload`、`ActivationMeta`
- `LicenseErrorReason`、`RefreshOutcome`、`RefreshRejectionReason`、`ActivationResult`

**新增导出**：原本依赖 `@shared/result` 的 `Result<T, E>` 类型，需要内置：

```typescript
export type Result<T, E> =
  | { success: true; data: T }
  | { success: false; error: E };
export function ok<T>(data: T): Result<T, never>;
export function err<E>(error: E): Result<never, E>;
```

**v1.0.0-alpha.2 新增（D4）**：

- `SignedToken` — D4 `online_check_token` 线协议形态（`{ payload: { license_id, server_time, expires_at }, signature }`）
- `OnlineCheckVerdict` — `verifyOnlineCheckToken` 4 verdict 判别联合（`valid` / `malformed` / `id_mismatch` / `expired` / `invalid_signature`）
- `OnlineCheckFile` — `online-check.json` 磁盘 schema
- `OfflineGraceResult` — `LicenseService.checkOfflineGrace()` 返回结构（含 `authorized`、`reason`、`daysLeft`、`tokenFailure`、`source` 等）

### F9. IPC controller（DevAgent-App 侧适配）

**对应现有**：`src/main/core/license/controller.ts`（212 行）

**保留在 DevAgent-App 仓库**（不抽取），作为 `LicenseService` 与 Electron IPC 之间的薄适配层。

CLI 没有 IPC 概念，直接调用 `LicenseService` API。

---

## 三、非功能需求

### N1. 包形态

| 项 | 规格 |
|---|---|
| 包名 | `@clouditera/license-mgr` |
| 仓库 | 独立 `Clouditera/license-mgr`（新建） |
| 语言 | TypeScript 5.x |
| 产物 | ESM + CJS 双包，`.d.ts` 完整 |
| Node 版本 | ≥ 18 |
| 依赖 | **零运行时第三方依赖**，仅 `node:crypto` / `node:fs` / `node:path` / `node:os` / `globalThis.fetch` |
| 包大小 | ≤ 150 KB（minified） |
| Tree-shaking | 支持，全部命名导出 |

### N2. 跨运行时兼容

| 运行时 | 支持级别 |
|---|---|
| Node.js 18+ | 一等公民，CI 全量测试 |
| Electron 主进程 | 一等公民 |
| 浏览器 / Renderer | **不支持**（涉及 fs / node:crypto），文档明确声明 |

### N3. 性能

| 操作 | 目标（不劣化于现状） |
|---|---|
| `validateLicense`（不含指纹采集） | < 50ms |
| `collectFingerprint`（冷启动） | < 500ms |
| `collectFingerprint`（缓存命中） | < 5ms |
| `LicenseService.initialize`（冷启动，含指纹采集） | < 1s（不含 refresh，refresh 异步） |
| 模块导入时间 | < 100ms |

### N4. 安全

- 公钥嵌入：PROD_KEY、LEGACY_KEYS 编译进产物
- 环境变量公钥覆盖（`CORTEXDEV_PUBLIC_KEY`）仅 dev 模式生效
- JSON 反序列化：限制深度、限制字符串长度、拒绝原型污染
- 错误日志：禁止包含完整 license 内容、签名、私钥相关信息
- 路径校验：configDir 必须绝对路径，禁止 `..` 穿越
- 文件权限：写入 license 后 `0600`（与现状一致）
- 依赖审计：CI 集成 `npm audit`，0 高危依赖

**v1.0.0-alpha.2 D4 trust-root 隔离（5 件套）**：

- **独立信任根**：`PROD_TOKEN_KEY`（D4 token 验签）与 `PROD_KEY`（license payload 验签）物理隔离，私钥分别在 Workers Secret 的 `TOKEN_SIGNING_PRIVATE_KEY` 与 license 签发管线中，互不污染。
- **运行时防御**：`token-key.ts: loadEmbeddedTokenPublicKey()` 在 prod build 启动时检查 PLACEHOLDER + `publicKeysEqual(PROD_TOKEN_KEY, DEV_TOKEN_KEY)`，命中则 FATAL throw。
- **`publicKeysEqual()` DER 比较**：用 SPKI DER 字节比较而非 PEM 文本，防 PEM 重新格式化绕过 collision guard。
- **CI gate `Verify token trust-root isolation`**：`scripts/verify-trust-root.mjs` 两层断言（文本 PLACEHOLDER 检测 + DER 比较 `PROD_TOKEN_KEY ≢ DEV_TOKEN_KEY` 且 `PROD_TOKEN_KEY ≢ PROD_KEY`），在 ci.yml + release.yml 双层执行。
- **轮换工具**：`scripts/gen-prod-token-key.mjs` 生成 ECDSA P-256 keypair，private 0600 + `.gitignore` 守护 `token-keys/`，SOP 见生成时控制台输出。
- **域名 allowlist**：`online-client.ts: ALLOWED_LICENSE_HOSTS` 拒绝非授权 host，防止 env 篡改把激活流量引到 evil.attacker.com。

### N5. 测试

**核心原则**：**用现有测试套件作为回归基准，行为不变**。

| 类型 | 覆盖率 / 数量 |
|---|---|
| 单元测试覆盖率 | ≥ 现有水平（90%+） |
| 行为等价：`validator.test.ts`（303 行） | 100% 通过 |
| 行为等价：`crypto.test.ts`（612 行） | 100% 通过 |
| 行为等价：`fingerprint.test.ts`（363 行） | 100% 通过 |
| 行为等价：`schema.test.ts`（253 行） | 100% 通过 |
| 行为等价：`store.test.ts`（248 行） | 100% 通过 |
| 行为等价：`online-client.test.ts`（429 行） | 100% 通过 |
| 行为等价：`license-service.test.ts`（899 行） | 100% 通过（含在线 refresh / 宽限期 / 吊销全部场景） |
| 行为等价：`controller.test.ts`（548 行） | 留在 DevAgent-App 仓库 |
| 跨平台 CI | macOS / Linux / Windows 三套 |
| 指纹一致性回归 | 同机新旧实现 hash 字节相等 |

### N6. 文档

| 文档 | 内容 |
|---|---|
| `README.md` | 5 分钟接入示例 + 状态机图 |
| `docs/API.md` | 完整接口文档 |
| `docs/MIGRATION.md` | 从内嵌版迁移指南（含 adapter 模板） |
| `docs/SECURITY.md` | 安全模型 + 密钥轮换流程 |
| `docs/HTTP-API.md` | License 后端 HTTP 契约文档 |
| `CHANGELOG.md` | Keep a Changelog |
| `CONTRIBUTING.md` | 开发 / 签名 / 发布流程 |

### N7. 版本与发布

- 遵循 **SemVer**
- V1.0.0 = 当前内嵌版的等价物，**API/行为完全一致**
- V1.x = 后续修复（不增加新能力） + **Phase 7 引入 `product_codes`**（详见 §1.4 Phase 7）
- V2.x = 引入更多新能力（指纹 v2、Web 版、多语言绑定等）

**分发**（R5 已决策：内部 registry 不可用）：

| 方案 | 使用 |
|---|---|
| **Git URL + tag**（`git+ssh://git@github.com/Clouditera/license-mgr.git#v1.0.0`） | 首选，沿用 `vendor/cortexdev-pro` 模式 |
| **GitHub Packages** | 备选，调用方 `.npmrc` 配置 GITHUB_TOKEN |

**迁移**：内部 registry 就绪后补 publish 步骤，调用方平滑切换（`package.json` 替换依赖来源）。

---

## 四、API 草案

```typescript
// =============================================================================
// 完整 API（与现有 LicenseService 一致）
// =============================================================================
import { LicenseService } from '@clouditera/license-mgr';

const service = new LicenseService({
  configDir: '/Users/foo/.cortexdev-pro',          // 必填
  isProductionBuild: app.isPackaged,               // 替代 app.isPackaged
  userDataPath: app.getPath('userData'),           // 用于 cleanupStaleTmp
  legacyKeys: [LEGACY_KEY_EXTRA],                  // 可选，追加额外 legacy 公钥
  logger: {                                        // 可选，默认 noop
    warn: (msg, ctx) => log.warn(msg, ctx),
    error: (msg, ctx) => log.error(msg, ctx),
    info: (msg, ctx) => log.info(msg, ctx),
  },
});

await service.initialize();
const status = service.getStatus();

// 全部现有 API 都保留
const result = await service.activate(licenseJson);
const result2 = await service.activateFromFile(filePath);
const refreshResult = await service.doRefreshNow();
await service.deactivate();
service.dispose();

// 状态变更回调（与现状一致）
service.setStatusChangeListener((s) => {
  window.webContents.send('license.status', s);
});

// 下载进度回调（与现状一致）
service.setDownloadProgressListener((event) => {
  window.webContents.send('license.downloadProgress', event);
});

// =============================================================================
// 低阶纯函数（测试 / 高级场景）
// =============================================================================
import {
  validateLicense,
  collectFingerprint,
  readLicense,
  writeLicense,
  onlineActivate,
  onlineRefresh,
} from '@clouditera/license-mgr';

const licenseFile = readLicense('/path/to/configDir');
const fingerprint = await collectFingerprint('/path/to/configDir', { skipCache: true });
const result = validateLicense(licenseFile, fingerprint, {
  lastVerifiedAt: meta?.last_verified_at,
});

// =============================================================================
// 类型导出
// =============================================================================
import type {
  LicenseStatus,
  LicenseFile,
  LicensePayload,
  ActivationMeta,
  ActivationResult,
  LicenseErrorReason,
  RefreshOutcome,
  Result,
} from '@clouditera/license-mgr';
```

---

## 五、迁移与兼容性

### M1. License 文件格式：**完全不变**

- `license.json` schema 不变
- `activation.json` schema 不变
- 路径 `~/.cortexdev-pro/license/` 不变
- 存量 license **全部继续可用**，无需重新签发

### M2. 指纹算法：**完全不变**

- 同一台机器上新模块产出的指纹 = 旧实现产出的指纹（字节相等）
- 不引入 v1/v2 双算法 API
- 历史 license 全部兼容

### M3. HTTP 契约：**线协议字节不变（base + path 拆分有调整）**

- **Wire URL**：`https://license.clouditera.online/api/v1/{activate,refresh}`（与 alpha.1 / CLI legacy 字节一致）
- v1.0.0-alpha.2 内部把 base URL（含 `/api/v1`）与 path（`/activate` / `/refresh`）拆分，**对外 wire 请求无变化**——CLI 用户把 `DEVAGENT_LICENSE_SERVER=.../api/v1` 直接抄成 `CORTEXDEV_LICENSE_API_URL` 不会产生 `/api/v1/api/v1` 双拼问题。
- 请求/响应 schema：**完全不变**，加可选 `online_check_token` 字段（D4，详见 §F5）。pre-D4 server 不带该字段，client 静默兼容。
- 错误码、超时全部维持。
- 签发端（`devagent-cli` 仓库内）**无需任何改造**——D4 server 已就绪（`server/license-api/`），本期是 client 半边补齐。

**域名 allowlist**：v1.0.0-alpha.2 起，`CORTEXDEV_LICENSE_API_URL` 必须指向 `ALLOWED_LICENSE_HOSTS` 内的 host，否则 client 同步 throw（§N4 安全增强）。

### M4. DevAgent-App IPC：**完全不变**

- `license.*` RPC 通道签名不变
- 渲染层（`activation.store.ts` / `ActivationScreen.tsx`）**零改动**

### M5. 切换流程（详细）

```
Phase 1: license-mgr 独立仓库建立 + 模块开发
  仓库: Clouditera/license-mgr
  - 从 src/main/core/license/ 复制源码（保留所有逻辑）
  - 解耦 Electron 依赖（参数注入 isProductionBuild / userDataPath / logger）
  - 移除 @shared/* 依赖，内置 Result<T, E>
  - 复制测试套件，所有现有测试通过
  - 三平台 CI 全绿
  - 发布 @clouditera/license-mgr@1.0.0-alpha.0

Phase 2: DevAgent-App 接入（双实现并存）
  - 新增 src/main/core/license/adapter-core.ts
    构造 LicenseService 时传入 app.isPackaged / app.getPath('userData') / log
    桥接 setStatusChangeListener → BrowserWindow.webContents.send
    桥接 setDownloadProgressListener → BrowserWindow.webContents.send
  - controller.ts 内部读环境变量 CORTEXDEV_LICENSE_IMPL 切换 legacy / core
  - 内部 dogfood 1-2 周

Phase 3: DevAgent-CLI（devagent-cli 仓库）接入
  - 与 Agents 类似，提供 adapter
  - 内部 dogfood 1-2 周
  - 两端同时跑 core 时，验证 license 文件读写不冲突

Phase 4: 灰度全量切换
  - Agents 默认 core，观察 2 周（监控激活成功率、刷新成功率、错误码分布）
  - CLI 默认 core，观察 2 周

Phase 5: 旧代码删除
  Agents 仓库:
    - 删除 src/main/core/license/{crypto,fingerprint,validator,schema,
      store,license-service,online-client,types}.ts
    - 保留 controller.ts（IPC 适配层）
    - 移除 CORTEXDEV_LICENSE_IMPL 环境变量
  CLI 仓库:
    - 删除 packages/core/src/license/

Phase 6: DevEye / DevEyeProd 接入
  各 CLI 仓库:
    - 添加依赖 @clouditera/license-mgr
    - configDir 解析: 环境变量优先 + 默认 ~/.deveye/license/ 或 ~/.deveye-prod/license/
    - 直接消费 LicenseService 公共 API（无 IPC / 渲染层桥接）
  签发端:
    - 支持按产品线签发 DevEye 系 license（无需 product_codes，按 license_id 区分）
  时间窗口: 与 DevAgent 系解耦，独立排期

Phase 7: 引入 product_codes 强密码学隔离
  license-mgr:
    - 校验流水线增加 product_codes 校验
    - 主版本号 bump（视为破坏性变更）
  签发端:
    - schema 加 product_codes 必填字段
    - 存量 license 批量回填工具
  各客户端:
    - 升级到含 product_codes 校验的 license-mgr 版本
    - 过渡版客户端对缺失 product_codes 的 license 显示明确提示
  时间窗口: 仅在 Phase 5 完成后启动；签发端回填先于客户端升级

Phase 8: 进入功能演进期
  - 指纹 v2、Web 版、多语言绑定等
  - 不在本需求文档范围
```

### M6. 环境变量与配置：**完全不变**

| 环境变量 | 说明 |
|---|---|
| `CORTEXDEV_CONFIG_DIR` | 保留，行为不变 |
| `CORTEXDEV_PRO_CONFIG_DIR` | 保留，行为不变 |
| `CORTEXDEV_LICENSE_API_URL` | 保留，行为不变（本地调试覆盖生产 URL） |
| `CORTEXDEV_PUBLIC_KEY` | 保留，仅 dev 模式生效 |
| `CORTEXDEV_LICENSE_IMPL`（新增，临时） | Phase 2-5 期间使用，灰度结束后移除 |

---

## 六、明确不做

| 项 | 推迟到 |
|---|---|
| `product_codes` 多产品授权 | **Phase 7**（DevAgent 系仓库迁移完成后），详见 §1.4 Phase 7 |
| 指纹算法 v2 / 双算法兼容期 | V1.x 或 V2.x |
| License 签发 CLI / 后台改造 | 不动（签发端在 `devagent-cli` 仓库内） |
| 浏览器 / WebCrypto 版本 | 不规划 |
| Go / Rust / Python 多语言绑定 | 不规划 |
| 任何行为级 bug 修复 | 抽取过程中如发现 bug，独立 issue 修复，不混在本期 |
| License 后端服务变更 | 不涉及（HTTP 契约不变） |
| DevAgent-App IPC 通道变更 | 不涉及 |
| Activation UI 改动 | 不涉及 |
| Pro 二进制下载流程 | 视设计阶段决定是否同步抽取（详见 F1 调整点） |

---

## 七、风险与开放问题

### R1. 字节级行为等价是硬约束（核心风险）

- **风险**：抽取过程中任何不察觉的语义偏移都会导致存量 license 失效或激活失败
- **缓解**：
  - 完整搬运现有测试套件作为回归
  - 三平台 CI 跑全套测试
  - 同机指纹/canonicalize 一致性测试
  - Phase 2/3 双实现并存，对比指标
  - 任何不能通过现有测试的"优化"一律拒绝合入

### R2. Pro 二进制下载耦合（待设计阶段决策）

- **现状**：`src/main/core/license/license-service.ts` 在 `activate` 成功后直接 `void downloadPro(...)`，触发 `src/main/core/cortexdev-pro/binary-downloader.ts`
- **问题**：`binary-downloader` 是 DevAgent-App 内的模块，与 license 概念无关，跟着 license-mgr 抽取会扩大范围
- **选项 A**：把 `downloadPro` 作为可选 callback 注入 LicenseService（解耦）
- **选项 B**：license-mgr 完全不管下载，由调用方在 `onStatusChange` 回调里自己判断 license type 后触发
- **选项 C**：连同 binary-downloader 一起抽取到另一个独立模块
- **决策时机**：留给设计阶段（`license-standalone-design.md`）

### R3. 两个仓库的 CI 双实现期成本（已接受）

- Phase 2-4 期间 Agents 与 CLI 同时维护 legacy / core 两套代码
- 任何紧急 bug 要 patch 两遍（legacy 一遍 + core 一遍）
- 缓解：Phase 时长压缩到 4 周以内，避免长期双线

### R4. license-mgr 独立仓库的基础设施搭建（已接受）

- CI（macOS / Linux / Windows）
- 发布流程（Git tag 自动 build + publish 到 GitHub Packages）
- 依赖审计 / 安全扫描
- 评估：~1 周（参考 Agents 现有模板）

### R5. NPM 内部 registry 暂不可用（已对齐）

- V1 分发走 Git URL + tag 或 GitHub Packages
- 后续 registry 就绪后切换，调用方零代码改动

### R6. 签发端协作（已对齐）

- **本次重构不涉及签发端**：HTTP 契约和 license 数据格式都不变，签发端无需动
- 签发端代码位置：`Clouditera/devagent-cli` 仓库内

### R7. 多消费者同时活跃时的写冲突（低风险）

- **场景**：用户同时在 DevAgent-CLI / DevAgent-App / DevEye / DevEyeProd 内做 activate / deactivate
- **现状**：write 是 tmp + rename 原子操作；activation_id 通过 `readActivationMeta` 复用
- **极端情况**：多端几乎同时 activate 同一个 license → activation_id 可能不一致 → 在线 refresh 失败一次后修正
- **缓解**：与现状一致，不在本次重构改进
- **范围扩展提醒**：随着接入方从 2 个扩到 4+ 个，竞争窗口理论上变大；如果实际运营中出现明显冲突，需要在 V1.x 引入文件锁（不在本期）

### R8. 多消费者的 cleanupStaleTmp 职责（待设计阶段决策）

- **现状**：`license-service.ts initialize finally` 中调用 `cleanupStaleTmp(app.getPath('userData'))`，清理 Pro 二进制下载的临时文件
- **问题**：DevAgent-CLI / DevEye / DevEyeProd 没有 `app.getPath('userData')`，路径概念不同
- **选项**：把 `cleanupStaleTmp` 抽离出 license-mgr，由调用方在自己的启动流程中调用
- **决策时机**：设计阶段

### R9. License 文件路径策略（已对齐：产品线分组独立）

**结论**：

- **DevAgent 系**（DevAgent-App + DevAgent-CLI）继续共享 `~/.cortexdev-pro/license/`，沿用现状，存量 license 零失效
- **DevEye 系**（DevEye + DevEyeProd）使用独立 configDir：`~/.deveye/license/` 与 `~/.deveye-prod/license/`（最终路径由 DevEye 团队确认；同线内是否共享路径由 DevEye 团队决定）
- **跨线 license 不共用**：路径隔离是 Phase 1-6 期间唯一的产品线边界
- **Phase 7 引入 `product_codes`** 提供密码学级隔离（详见 §1.4 Phase 7）

**Phase 1-6 期间的过渡风险**：

- 用户/支持人员**不得**手工把 DevEye license 文件 cp 到 DevAgent 目录尝试激活（虽然技术上能跑通，但属于授权违规，且 Phase 7 引入 `product_codes` 后立即失效）
- 各产品的文档/激活引导必须明确"本产品 license 不能用于其他产品"

### R10. DevEye / DevEyeProd 形态（已对齐：CLI）

**结论**：DevEye 与 DevEyeProd 都是 **Node.js CLI**，与 DevAgent-CLI 同形态。

**对设计的影响**：

- 无 Electron / IPC 适配负担（不像 DevAgent-App）
- 无渲染层（不需要 `setStatusChangeListener` 桥接 webContents）
- 直接消费 `LicenseService` 公共 API 即可
- `configDir` 由各 CLI 自己解析（环境变量优先，回退到产品默认路径）
- 错误处理：CLI 直接输出到 stderr / exit code，不需要"状态广播"机制



---

## 八、验收标准（DoD）

### license-mgr 模块发布（v1.0.0）前必须满足

- [ ] 单元测试覆盖率 ≥ 现有水平
- [ ] 三平台（macOS / Linux / Windows）CI 全绿
- [ ] 所有现有测试套件搬运后 100% 通过
- [ ] 指纹算法在同一台机器上新旧实现 hash 字节相等
- [ ] HTTP 契约对照测试通过（请求/响应/错误码与现有 mock 一致）
- [ ] license JSON 格式对照测试通过（同一个 license 文件，新旧实现校验结果一致）
- [ ] 包大小 ≤ 150 KB（minified）
- [ ] 零运行时第三方依赖
- [ ] 安全审计：JSON 反序列化、路径校验、错误日志脱敏
- [ ] 完整文档（README / API / MIGRATION / SECURITY / HTTP-API）

### DevAgent-App Phase 5 删除旧代码前必须满足

- [ ] core 实现在 Phase 4 灰度期间激活/刷新成功率 ≥ legacy 实现
- [ ] 状态分布、错误码分布无显著偏移
- [ ] 监控埋点完备（激活成功率、刷新成功率、各状态分布、错误码分布）
- [ ] 至少 2 周稳定运行
- [ ] 渲染层无任何回归

### DevAgent-CLI Phase 5 删除旧代码前必须满足

- [ ] 同上，外加：多消费者并存场景下 license 文件读写无冲突回归

### DevEye / DevEyeProd Phase 6 接入前必须满足

- [ ] 各 CLI 仓库已就绪 configDir 解析方式（环境变量优先 + 默认 `~/.deveye/license/` / `~/.deveye-prod/license/`）
- [ ] 签发端已支持按产品线签发 DevEye 系 license（无需 `product_codes`，按 license_id 区分）
- [ ] 用户文档已说明"DevEye license 不能用于 DevAgent，反之亦然"
- [ ] 各 CLI 独立监控埋点就绪（激活成功率、刷新成功率、错误码分布）

### Phase 7 引入 product_codes 前必须满足（不在本期范围，仅作记录）

- [ ] DevAgent 系 Phase 5 完成（旧代码已删除）
- [ ] 签发端 schema 已加 `product_codes` 必填字段
- [ ] 存量 license 批量回填工具就绪
- [ ] 客户端发布过渡版本，对缺失 `product_codes` 的 license 显示明确提示

---

## 九、参考资料

- 现有实现：`src/main/core/license/`（DevAgent-App 仓库）
- 现有 CLI 实现：`vendor/cortexdev-pro/packages/core/src/license/`（git submodule）
- 现有 IPC controller：`src/main/core/license/controller.ts`
- 现有渲染层：`src/renderer/features/activation/`
- License API：`https://license.clouditera.online`（生产 URL，2026-06-14 由 `license.cloudrouter.online` 切换；同 Cloudflare 账号下新注册域名 `clouditera.online`，继续 Cloudflare Workers 承载，全球边缘访问不变；变更需走评审）
- 现有需求初稿（V1 离线版，已废弃）：本文件历史版本 v0.1
- 主项目 CLAUDE.md：`/CLAUDE.md`

---

**下一步**：

1. 本需求评审通过后，转 `license-standalone-design.md`（架构设计：模块划分、接口签名、文件结构、Pro 二进制下载耦合方案、cleanupStaleTmp 归属）
2. 创建 `Clouditera/license-mgr` 仓库，搭建 CI / 发布流程
3. 与 DevAgent-CLI 维护者对齐接入时间窗口（任意顺序，无依赖）
