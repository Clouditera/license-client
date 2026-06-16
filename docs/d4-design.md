# D4 (online_check_token) + R1 等价性回补设计

> **状态**：草案 v0.1
> **日期**：2026-06-16
> **作者**：lc-kendo（与 AI 协作起草）
> **范围**：license-mgr v1.0.0-alpha.2 / beta.1 的实现规划
> **关联**：[License-Mgr#2](https://github.com/Clouditera/License-Mgr/issues/2)，requirements.md §F2 / F5 / F8 / M1 / N4

---

## 1. 背景与现状

### 1.1 一句话问题

license-mgr alpha.1 是 DevAgent-App 的副本，**不是** App + CLI 的并集。CLI legacy 已在生产实现的 D4 (`online_check_token`) 与 hostname allowlist 完全缺失，使 §一.2 "single source of truth" 的核心目标失败、§N5 R1 "字节级行为等价" 的硬约束被违反、Phase 3 CLI 接入会直接触发功能 + 安全降级。

### 1.2 R1 违反清单（按 CLI legacy 实现编排）

| 维度 | CLI legacy | license-mgr alpha.1 | 缺口性质 |
|---|---|---|---|
| D4 token 公钥嵌入 | `core/src/license/token-key.js`：DEV/PROD 双 key + env 覆盖在 prod 拒绝 | ❌ 无 | 安全：D4 完全缺失 |
| D4 token 离线验证 | `cortexdev-pro/src/license/online-check.js`：`verifyOnlineCheckToken()` | ❌ 无 | 功能：用户离线长窗口能力丢失 |
| D4 token 持久化 | `online-check.json` 含 `signed_token` 字段 | ❌ 无 store 接口 | 功能：activate / refresh 拿到 token 无处可写 |
| D4 token response 解析 | `activate.js:127` / `refresh.js:231` 读 `data.online_check_token` | ❌ `ActivateResponse` / `RefreshResponse` 类型无字段 | 静默丢弃 server 已签发的 token |
| Gate offline grace | `gate.js: checkOfflineGrace()` Path A + Path B + `clock_anomaly` 检测 | ❌ `LicenseService` 无对应方法 | 功能：宽限期判定逻辑缺失 |
| Hostname allowlist | `core/src/license/server-url.js: ALLOWED_LICENSE_HOSTS` 强制校验 | ❌ 仅 https scheme 校验 | 安全：可任意指向 evil.attacker.com |
| Env 名 | `CORTEXDEV_LICENSE_SERVER`（含 `/api/v1` path） | `CORTEXDEV_LICENSE_API_URL`（base only） | 运营：脚本/文档失配 |
| `LICENSE_REQUIRE_SIGNED_TOKEN` env | ✅ 可强制禁用 Path B | ❌ | 配置：合规客户失去硬化开关 |
| Default URL | `https://license.cloudrouter.online/api/v1` | `https://license.clouditera.online` | 部署：CLI 接入需对齐 |

### 1.3 范围声明

**做（v1.0.0-alpha.2 ship 前必须完成）**：
- 在 license-mgr 内补齐上表所有缺口，**行为字节级对齐 CLI legacy**
- 新增/修改测试，含 CLI 测试套件移植 + 跨实现对照测试
- 同步 `docs/requirements.md` 相关章节

**不做（本期排除）**：
- ❌ 改 D4 server schema / 改签发流程（server `server/license-api/` 已就绪，不动）
- ❌ 引入 `product_codes`（属 Phase 7）
- ❌ 重新设计 LicenseService 状态机（CLI gate.js 与 LicenseService 的语义映射靠 adapter 层做，不改 license-mgr 状态机）
- ❌ 替换签名算法 / 改 canonicalize（沿用 ECDSA P-256 + 现有 canonicalize）

---

## 2. D4 完整契约模型（基于源码核实）

### 2.1 Server 端（`devagent-cli/server/license-api/`）

**签发条件矩阵**：

| Endpoint | 状态 | 签发 token? | 失败处理 |
|---|---|---|---|
| `/activate` 200 | 任意 | ✅ 必尝试 | 失败仅 warn，response 不带字段 |
| `/refresh` 200 + 非 revoked | active | ✅ 必尝试 | 同上 |
| `/refresh` revoked | revoked | ❌ 不签发 | 拒绝继续给离线使用授权 |
| 任何 4xx/5xx | 错误 | ❌ 不签发 | — |

**Token payload schema**：
```json
{
  "license_id": "<from request, server 透传>",
  "server_time": "<server-controlled ISO>",
  "expires_at": "<server_time + 7d (DEFAULT_TTL_MS), server-controlled>"
}
```

**关键安全细节**（来自 `server/license-api/src/lib/token.js`）：
- `expires_at` 在签发前**强制覆盖**——caller 注入的 `expires_at` 被 destructure strip 掉
- 签名算法：ECDSA P-256 / SHA-256，使用 client 同款 `canonicalize()`
- 签名格式：subtle.sign 输出 IEEE-P1363（r||s, 64B），server 端 P1363→DER 转换后 base64，让 node:crypto `verify('SHA256', ...)` 直接接收
- Key 来源：`env.TOKEN_SIGNING_PRIVATE_KEY`（PEM PKCS8），dev 在 `dev-keys/token-private.pem`，prod 在 Workers Secret

### 2.2 Wire-level 响应形态

**`POST /api/v1/activate` 200**：
```json
{
  "ok": true,
  "data": {
    "status": "activated",
    "server_time": "<ISO>",
    "activation_id": "<uuid>",
    "online_check_token": {                 // optional - 旧 server 不签
      "payload": { "license_id", "server_time", "expires_at" },
      "signature": "<base64 DER>"
    }
  }
}
```

**`POST /api/v1/refresh` 200**：
```json
{
  "ok": true,
  "data": {
    "revoked": false,
    "server_time": "<ISO>",
    "revoked_at": null,
    "reason": null,
    "license": null,
    "online_check_token": { ... }           // optional, 同上；revoked=true 时省略
  }
}
```

### 2.3 Client 端持久化 schema

**`{configDir}/license/online-check.json`**（atomic write, 0600）：
```json
{
  "last_online_check": "<ISO, 客户端本地时钟>",
  "server_time": "<ISO, 从 response 透传>",
  "signed_token": {                         // optional
    "payload": { "license_id", "server_time", "expires_at" },
    "signature": "<base64 DER>"
  }
}
```

设计要点（来自 CLI `refresh.js: writeOnlineCheck`）：
- `signed_token` 为可选字段——旧 server 不签发时整段省略，让文件保持向后兼容
- `server_time` 也是可选——server response 缺失时不写
- `last_online_check` 总是本地时间，用于 Path B 60 天宽限期计算

### 2.4 Gate offline grace 决策树（`gate.js: checkOfflineGrace`）

```
读 online-check.json
  ├─ 不存在 / JSON 解析失败 → offline_expired
  └─ 存在
     ├─ data.signed_token 存在 + license_id 可读
     │  └─ verifyOnlineCheckToken(token, licenseId)
     │     ├─ valid: true       → authorized, daysLeft = (token.expires_at - now) / 1d
     │     ├─ reason: 'malformed' → fall through Path B  ← 兼容老文件
     │     └─ reason: 其它       → offline_expired + tokenFailure
     └─ Path B (legacy)
        ├─ env LICENSE_REQUIRE_SIGNED_TOKEN=true → offline_expired (绕过 Path B)
        ├─ daysSince < 0           → clock_anomaly  ← clock rollback 检测
        ├─ daysSince > 60 (OFFLINE_GRACE_DAYS) → offline_expired
        └─ else                    → authorized, daysLeft = 60 - daysSince
```

`verifyOnlineCheckToken()` 四种 reason 的语义（来自 `online-check.js`）：
- `malformed`：token 结构损坏 / 缺字段 — 视为老格式，fall through
- `id_mismatch`：token.license_id ≠ 本地 license.license_id — 防 token 跨号
- `expired`：token.expires_at < now — token TTL 到期
- `invalid_signature`：DER 验签失败 — tamper 风险

非 `malformed` 的失败必须 hard fail——否则 attacker 把签名破坏后让 client 退回 lax Path B 就绕过了 D4。

---

## 3. license-mgr 改造方案

### 3.1 层归属：state 层 `checkOfflineGrace()`（**已决策**）

| 层 | 职责 | 含 D4 吗？ |
|---|---|---|
| `validator.ts` | 7 步 pure 校验：结构 / schema / 时钟 / 时钟 / 签名 / 指纹 / 过期 | ❌ 不含 D4 |
| `crypto.ts` | ECDSA 验签（license payload + D4 token 共用 verify 入口） | 核心算法层 |
| `token-key.ts` 🆕 | D4 token 公钥嵌入 + env 覆盖策略 | 核心 |
| `online-check.ts` 🆕 | `verifyOnlineCheckToken()` 纯函数 | 核心 |
| `online-check-store.ts` 🆕 | `readOnlineCheck` / `writeOnlineCheck` atomic I/O | I/O 层 |
| `license-service.ts` | 状态机 + `checkOfflineGrace()` 方法 + activate/refresh 时持久化 token | **state 层承载 D4 决策** |

**理由**：保持 validator 是 pure 7 步（与 §F2 现有契约对齐，CLI 接入 adapter 通过 `service.checkOfflineGrace()` 拿决策结果，不污染 validator）。CLI gate.js 的 `checkOfflineGrace` 在 license-mgr 里就是 `LicenseService.checkOfflineGrace()`，签名同构，迁移成本最低。

### 3.2 新增模块清单

#### 3.2.1 `src/token-key.ts`

```typescript
const DEV_TOKEN_KEY: string = `-----BEGIN PUBLIC KEY-----...`;  // 与 CLI 字节相同
const PROD_TOKEN_KEY: string = `-----BEGIN PUBLIC KEY-----PLACEHOLDER...`;  // release pipeline 替换

export interface TokenKeyConfig {
  /** 替代 isProductionBuild()，由 LicenseService 透传 */
  isProductionBuild: boolean;
  /** dev 模式下的 env 覆盖；prod 模式下忽略 */
  envOverride?: string;
}

/** 启动期一次性解析。prod build + PLACEHOLDER → throw FATAL，与 CLI 行为一致。 */
export function loadEmbeddedTokenPublicKey(config: TokenKeyConfig): string;

export { DEV_TOKEN_KEY, PROD_TOKEN_KEY };
```

**对应 CLI**：`packages/core/src/license/token-key.js`

**字节级等价要求**：
- DEV_TOKEN_KEY 内容与 CLI 完全相同
- PROD_TOKEN_KEY PLACEHOLDER 与 CLI 完全相同
- env 名 `CORTEXDEV_TOKEN_PUBLIC_KEY`（与 CLI 一致）
- prod build 拒绝 env override 的逻辑路径与 CLI 一致

#### 3.2.2 `src/online-check.ts`

```typescript
export interface SignedToken {
  payload: {
    license_id: string;
    server_time: string;
    expires_at: string;
  };
  signature: string;  // base64 DER
}

export type OnlineCheckVerdict =
  | { valid: true }
  | { valid: false; reason: 'malformed' | 'id_mismatch' | 'expired' | 'invalid_signature' };

/** 纯函数 — 不读盘、不调网络、不抛异常。 */
export function verifyOnlineCheckToken(
  token: unknown,
  licenseId: string,
  embeddedTokenPublicKey: string,
): OnlineCheckVerdict;
```

**对应 CLI**：`packages/cortexdev-pro/src/license/online-check.js`

**关键细节**：
- 四种 reason 与 CLI 完全一致
- 用 `crypto.verifySignature` 调同款 ECDSA 验签
- token public key 通过参数注入而非 `import` 常量——便于测试

#### 3.2.3 `src/online-check-store.ts`

```typescript
export interface OnlineCheckFile {
  last_online_check: string;
  server_time?: string;
  signed_token?: SignedToken;
}

export function readOnlineCheck(configDir: string): OnlineCheckFile | null;

export function writeOnlineCheck(
  configDir: string,
  serverTime: string | undefined,
  signedToken: SignedToken | undefined,
): void;
```

**对应 CLI**：`activate.js: writeOnlineCheckOnActivate` + `refresh.js: writeOnlineCheck`（两份逻辑合并，CLI 是历史拆开）

**字节级等价要求**：
- 文件路径：`{configDir}/license/online-check.json`
- mode 0600
- atomic write (tmp + rename，`tmp.${pid}` 后缀与 CLI 一致)
- 可选字段省略策略与 CLI `writeOnlineCheck` 字节相同

### 3.3 修改模块清单

#### 3.3.1 `src/types.ts`

`ActivateResponse` / `RefreshResponse` 加可选字段：

```typescript
export interface ActivateResponse {
  status: 'activated';
  server_time: string;
  activation_id: string;
  online_check_token?: SignedToken;  // 🆕
}

export interface RefreshResponse {
  revoked: boolean;
  server_time: string;
  revoked_at?: string | null;
  reason?: string | null;
  license: null;
  online_check_token?: SignedToken;  // 🆕
}
```

新增 export：`SignedToken`, `OnlineCheckVerdict`, `OnlineCheckFile`, `OfflineGraceResult`。

#### 3.3.2 `src/online-client.ts`

**改 1：default URL**

```typescript
// 与 CLI legacy 字节一致（含 /api/v1）
const PRODUCTION_BASE_URL = 'https://license.clouditera.online/api/v1';
```

⚠️ 这是行为变更！见 §6.3 风险评估。如果不能字节对齐，alpha.2 改成 `https://license.clouditera.online` + 文档明确路径策略；目前选择**对齐 CLI**以满足 R1。

**改 2：env 名兼容（Q2=B 决策）**

```typescript
function getBaseUrl(logger: Logger): string {
  // v1.0：双名兼容；v1.1：移除 CORTEXDEV_LICENSE_SERVER
  const newName = process.env['CORTEXDEV_LICENSE_API_URL'];
  if (newName) return newName;

  const legacyName = process.env['CORTEXDEV_LICENSE_SERVER'];
  if (legacyName) {
    logger.warn(
      '[license/online-client] CORTEXDEV_LICENSE_SERVER is deprecated, ' +
      'will be removed in v1.1. Use CORTEXDEV_LICENSE_API_URL.',
    );
    return legacyName;
  }
  return PRODUCTION_BASE_URL;
}
```

**改 3：hostname allowlist**

```typescript
export const ALLOWED_LICENSE_HOSTS = new Set([
  'license.cortexdev.io',
  'license.clouditera.com',
  'license.clouditera.online',
  'cortexdev-license-api.clouditera2026.workers.dev',
  'cortexdev-license-api-staging.clouditera2026.workers.dev',
  'cortexdev-license-api-staging.kangkangli.workers.dev',
  'license.cloudrouter.online',
  'license-staging.cloudrouter.online',
  'localhost',
  '127.0.0.1',
]);

// post() 内部第一步:
const { hostname } = new URL(url);
if (!ALLOWED_LICENSE_HOSTS.has(hostname)) {
  // 行为：throw 同步异常（与 CLI resolveLicenseServerURL 一致）
  // 而非 Result.err — 因为这属于配置错误，非运行时
}
```

**保留**：现有 envelope 解析、超时、Result 包装、错误码映射。

#### 3.3.3 `src/license-service.ts`

**新增方法**：

```typescript
export interface OfflineGraceResult {
  authorized: boolean;
  reason?: 'offline_expired' | 'clock_anomaly';
  daysLeft?: number;
  lastCheck?: string;
  tokenFailure?: 'id_mismatch' | 'expired' | 'invalid_signature';
  source?: 'signed_token' | 'last_online_check';
}

class LicenseService {
  // ... 现有 API 不动 ...

  /** 与 CLI gate.js: checkOfflineGrace() 字节级等价。 */
  checkOfflineGrace(): OfflineGraceResult;
}
```

**修改 activate / refresh 内部逻辑**：

- `activate(licenseJson)` 成功后调 `writeOnlineCheck(configDir, server_time, online_check_token)`
- `doRefreshNow()` 成功后同上
- `online_check_token` undefined 时不写 `signed_token`，文件向后兼容

**新增构造参数**：

```typescript
new LicenseService({
  configDir: ...,
  isProductionBuild: ...,
  // 🆕：D4 相关
  tokenPublicKeyOverride?: string,  // 仅 dev 模式生效，对应 env CORTEXDEV_TOKEN_PUBLIC_KEY
  requireSignedToken?: boolean,     // 对应 env LICENSE_REQUIRE_SIGNED_TOKEN（构造时由调用方读 env）
  // ...
});
```

**理由**：env 读取尽量收敛在调用方（adapter 层），让 LicenseService 接口纯化便于测试。

### 3.4 不动的模块（重要的"不做"声明）

| 模块 | 不动原因 |
|---|---|
| `validator.ts` | 保持 7 步纯函数；D4 决策归 state 层 |
| `crypto.ts` | ECDSA verify 算法不变；D4 token 用同一个 `verifySignature` 入口 |
| `schema.ts` | license payload schema 不变（D4 只影响 response，不影响 payload） |
| `fingerprint.ts` | 与 D4 无关 |
| `store.ts` | `license.json` + `activation.json` 不变；D4 单独走 `online-check-store.ts` |

---

## 4. 非 D4 但同步要做的等价性回补

### 4.1 hostname allowlist（已含在 §3.3.2 改 3）

### 4.2 env 名兼容（已含在 §3.3.2 改 2）

策略 Q2=B：v1.0 双名 + warn，v1.1 移除 `CORTEXDEV_LICENSE_SERVER`。

CHANGELOG 在 v1.0.0-alpha.2 增 Deprecated 段：
```
- `CORTEXDEV_LICENSE_SERVER` env variable is deprecated in favour of
  `CORTEXDEV_LICENSE_API_URL`. Both work in v1.0.x; the old name will be
  removed in v1.1.0.
```

### 4.3 default URL 含 `/api/v1` path

CLI legacy `DEFAULT_LICENSE_SERVER = 'https://license.cloudrouter.online/api/v1'`。
license-mgr alpha.1 现在是 `https://license.clouditera.online`（无 path）。

R1 要求字节对齐 → alpha.2 改成 `https://license.clouditera.online/api/v1`。

后果：现有 license-mgr alpha.1 调用方（无）会感知到 base URL 变化，但因为 alpha.1 还没有任何下游接入，无回归风险。

### 4.4 `LICENSE_REQUIRE_SIGNED_TOKEN` env 开关

通过 `LicenseService` 的 `requireSignedToken?: boolean` 构造参数注入；adapter 层读 env：

```typescript
new LicenseService({
  requireSignedToken: process.env['LICENSE_REQUIRE_SIGNED_TOKEN'] === 'true',
  // ...
});
```

`checkOfflineGrace()` 内部判断此值，行为与 CLI `gate.js` 完全一致：true 时绕过 Path B。

---

## 5. 测试策略

### 5.1 移植 CLI 测试套件

| CLI 测试文件 | 移植目标 | 转换 |
|---|---|---|
| `packages/core/tests/license-token-key.test.js` | `src/token-key.test.ts` | JS → TS，断言不变 |
| `packages/cortexdev-pro/tests/license-server-url.test.js` | `src/online-client.test.ts` 扩展（hostname allowlist 部分） | JS → TS |
| `packages/cortexdev-pro/tests/license-online-check.test.js`（如有） | `src/online-check.test.ts` | JS → TS |
| `packages/cortexdev-pro/tests/license-gate.test.js` 中 `checkOfflineGrace` 部分 | `src/license-service.test.ts` 新增 describe block | JS → TS，调用入口从 `checkOfflineGrace(configDir)` 变 `service.checkOfflineGrace()` |

**禁止**：等价语义改写。R1 是字节级要求，断言不能"差不多对就行"。

### 5.2 跨实现对照测试（新增）

新建 `src/__cross-impl__/` 目录，跑两组 fixture：

1. **同一 mock /activate response** 喂给 license-mgr core 与 CLI legacy（通过 spawn child process 调 CLI），断言两边：
   - 写出的 `license.json` byte-identical
   - 写出的 `activation.json` byte-identical
   - 写出的 `online-check.json` byte-identical（除了 `last_online_check` 是本地时钟，断言时只比 server_time / signed_token）
   - 错误码映射相同

2. **同一签名 D4 token 喂给 license-mgr 与 CLI legacy verifyOnlineCheckToken**，断言 verdict 完全相同。

CI 阶段：alpha.2 之前必须 100% 通过；GA 之前作为强制 gate。

### 5.3 单元测试覆盖率目标

按 §N5：≥ 90%，与现状持平。新增模块（token-key / online-check / online-check-store）单独 ≥ 95%（因为是 D4 信任根）。

### 5.4 三平台 CI

仍按 §N5：macOS / Linux / Windows × Node 18/20/22 全量跑。

---

## 6. Migration & rollout

### 6.1 版本号

| 版本 | 范围 |
|---|---|
| v1.0.0-alpha.1（已发布） | App 副本，缺 D4 / allowlist — Phase 3 不能用 |
| **v1.0.0-alpha.2**（本设计 ship） | D4 + allowlist + env 名兼容 — Phase 3 baseline |
| v1.0.0-beta.1 | alpha.2 在 CLI dogfood 2-4 周后发 beta |
| v1.0.0 | beta 灰度结束、跨实现对照测试通过、文档齐全 → GA |

### 6.2 Phase 3 接入路径

1. license-mgr ship v1.0.0-alpha.2
2. CLI 仓库新分支 `feat/license-mgr-adapter`，依赖切到 `git+ssh://...#v1.0.0-alpha.2`
3. CLI 新增 `packages/cortexdev-pro/src/license/adapter-core.js`：
   - 调用方读 env、build mode 注入 LicenseService 构造参数
   - 把 CLI gate.js 现有调用 `checkOfflineGrace(configDir)` 换成 `service.checkOfflineGrace()`
   - 把 `activate.js` / `refresh.js` 现有持久化逻辑换成 service 内部完成
4. CLI 保留 legacy `packages/core/src/license/` 作为兜底，env `CORTEXDEV_LICENSE_IMPL=core|legacy` 切换（与 §1.4 Phase 2 策略一致）
5. CLI dogfood 1-2 周观察激活/刷新成功率、错误码分布
6. 默认 `core`，观察 2 周
7. 删 CLI 旧代码 + 移除 `CORTEXDEV_LICENSE_IMPL` env

### 6.3 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Default URL 字节级对齐导致 alpha.2 调用方 base URL 变化 | 低 | 无（alpha.1 无下游接入） | 直接对齐，不留过渡期 |
| Env `CORTEXDEV_LICENSE_SERVER` 读取被遗漏，CLI dogfood 期间报错 | 中 | 中 | 单元测试覆盖双名读取顺序，跨实现对照测试验证 |
| D4 token 签名 P1363↔DER 转换实现细节差异 | 中 | 高（验签失败 → 全量 D4 用户离线宽限期断裂） | 跨实现对照测试用 server 真实签发的 token 验证 |
| `online-check.json` schema 与 CLI 写出顺序差异 | 低 | 中（破坏跨实现对照测试） | 用 canonical JSON 序列化或 byte-identical 测试 fixture |
| PROD_TOKEN_KEY release pipeline 注入流程缺失 | 高 | 高（prod build 启动 throw FATAL） | §7 Open Q-1 解决 |

---

## 7. Open questions

### Q-1：PROD_TOKEN_KEY release pipeline 注入流程

CLI 现在的做法：`token-key.js` 含 PLACEHOLDER，release pipeline 在打包前 sed 替换。

license-mgr 是 NPM 包，build artifact 是 `dist/`。Pipeline 怎么注入？

**候选方案**：
- (a) tsup build 时通过 env 注入：`PROD_TOKEN_KEY=$(cat keys/prod.pem) pnpm build`，tsup config 用 `define` 替换源码常量
- (b) release workflow 在 build 前 sed 替换 `src/token-key.ts` 的 PLACEHOLDER
- (c) 分离两份发布产物：`@clouditera/license-mgr`（含 PLACEHOLDER，调用方注入）+ `@clouditera/license-mgr-prod`（含真实 key）

**待 release pipeline owner 决策**。建议 (a)，最干净，但需要在 tsup config 加 `replaceNodeEnv` 类逻辑。

### Q-2：`legacyTokenKeys` 构造参数是否需要

CLI legacy 没有 legacyTokenKeys 概念（PROD_TOKEN_KEY 单一）。但 license-mgr 已经在 license payload signing 上有 `legacyKeys: string[]` 参数（与现状一致）。

**对称性问题**：token key 是否也该有 legacy 兼容期？

**建议**：本期**不引入**。理由：token 是 7 天 TTL 的短期凭据，过期就重签发，不需要 legacy 公钥回退。即便未来 token key 轮换，新 client 拿到旧 token → token 过期 → 重新 /refresh → 拿到新 token。攻击面更小。

如果 server 团队需要 token key 平滑轮换，再独立立项。

### Q-3：`online-check.json` 路径是否随 product line 隔离（§R9）

CLI legacy 路径：`{configDir}/license/online-check.json`。
按 §R9 决策：DevAgent 系沿用 `~/.cortexdev-pro/license/`，DevEye 系独立 configDir。

license-mgr 实现：`online-check-store.ts` 接受 `configDir` 参数（与 CLI legacy 一致），调用方决定路径。无需特殊处理——本来就靠 configDir 隔离。

**结论**：不阻塞设计，按 CLI legacy 实现即可。

### Q-4：`clock_anomaly` 是否触发状态机迁移

CLI gate.js 在 `daysSince < 0` 时返回 `clock_anomaly`，但 license-mgr 状态机里没有对应状态。

**候选**：
- (a) `clock_anomaly` 折叠进 `error` 状态
- (b) 新增 `clock_anomaly` 状态
- (c) `checkOfflineGrace()` 返回 `OfflineGraceResult.reason: 'clock_anomaly'`，但 LicenseService 状态保持 `validating`

**建议** (c)：grace check 是辅助决策，不应污染主状态机。adapter 层根据 result 决定怎么向上层呈现。

---

## 8. 实施排期估算

| 阶段 | 工作 | 估时 |
|---|---|---|
| Design review | 本文档评审 + Q1-Q4 决策 | 0.5 天 |
| Implementation | token-key + online-check + online-check-store 三新模块 + types + online-client 改造 + license-service 改造 | 2 天 |
| Tests | 移植 CLI 测试 + 跨实现对照测试搭建 | 1 天 |
| Docs | requirements.md §F2/F5/F8/N4/M3 同步、CHANGELOG、新 docs/D4-API.md | 0.5 天 |
| Release | v1.0.0-alpha.2 build + tag + GitHub Packages publish | 0.5 天 |
| **总计** | | **~4.5 天** |

不含 Q-1 PROD_TOKEN_KEY pipeline 决策时间（依赖 release pipeline owner）。

---

## 9. 验收标准（DoD）

license-mgr v1.0.0-alpha.2 发布前必须满足：

- [ ] §3 新增/修改模块全部实现，TypeScript ESM + CJS 双产物
- [ ] §5.1 移植测试 100% 通过
- [ ] §5.2 跨实现对照测试用真实 D4 token fixture 通过
- [ ] §5.3 覆盖率达标
- [ ] §5.4 三平台 CI 全绿
- [ ] §3.3.2 `CORTEXDEV_LICENSE_SERVER` deprecation warning 在测试中被触发并通过断言验证
- [ ] §3.3.2 hostname allowlist 拒绝非 allowlist host 的单元测试通过
- [ ] §4.4 `LICENSE_REQUIRE_SIGNED_TOKEN=true` 行为单元测试通过
- [ ] §7 Q-1 PROD_TOKEN_KEY 注入流程已落地（不能再是 PLACEHOLDER）
- [ ] `docs/requirements.md` 同步更新 §F2 / F5 / F8 / N4 / M3
- [ ] `CHANGELOG.md` `[1.0.0-alpha.2]` 段含 Added / Changed / Deprecated 三类
- [ ] Issue License-Mgr#2 关闭

CLI 仓库 Phase 3 接入前必须满足（不在本设计范围，仅作记录）：

- [ ] CLI legacy 在 `CORTEXDEV_LICENSE_IMPL=core` 下 dogfood ≥ 2 周
- [ ] 激活成功率、刷新成功率、错误码分布与 legacy 无显著偏移
- [ ] D4 用户的 `online-check.json` byte-identical 跨实现验证

---

## 10. 参考资料

- License-Mgr#2: license-mgr missing D4 + hostname allowlist (CLI legacy already ships them)
- CLI legacy 源码：`/Users/lijunchao/cortexdev-pro/devagent-cli/packages/`
- CLI legacy server：`/Users/lijunchao/cortexdev-pro/devagent-cli/server/license-api/`
- requirements.md §F2 / F5 / F8 / N4 / N5 / M1 / M3
- CHANGELOG.md `[1.0.0-alpha.1]`

---

**下一步**：本设计评审通过后，编码起点见 §3 模块清单，按 token-key → online-check → online-check-store → types → online-client → license-service 的顺序推进；测试与代码同步写，跨实现对照测试在 license-service 完成后接入。
