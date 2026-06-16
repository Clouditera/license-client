# D4 (online_check_token) + R1 等价性回补设计

> **状态**：草案 v0.3（基于 CLI legacy ground truth 修正 Q-1 / 补 5 件套 / 锁定 env 名）
> **日期**：2026-06-16
> **作者**：lc-kendo（与 AI 协作起草）
> **范围**：license-mgr v1.0.0-alpha.2 / beta.1 的实现规划
> **关联**：[License-Mgr#2](https://github.com/Clouditera/License-Mgr/issues/2)，requirements.md §F2 / F5 / F8 / M1 / N4

---

## 0. v0.3 变更摘要（必读）

v0.2 → v0.3 在编码起步前回看 CLI legacy 现状，发现三处与 v0.2 设计不符，按 ground truth 修正：

| Q | v0.2 决策 | v0.3 修正 | 原因 |
|---|---|---|---|
| **Q-1** PROD_TOKEN_KEY 嵌入 | (a) tsup `define` 替换 PLACEHOLDER | **撤回。改为字节嵌入真实 PEM** | CLI 现行做法是直接嵌入 PEM（不再用 PLACEHOLDER）。license-mgr 已有的 PROD_KEY 也是直接嵌入。三方对齐 + R1 字节等价要求。tsup `define` 会让 license-mgr 跟 CLI 在 build 工艺分叉，无对称收益 |
| **trust-root 隔离范围** | 仅 publicKeysEqual 运行时防御 | **扩展为 5 件套** | CLI 实际有：(1) `token-key.js` 含 publicKeysEqual + (2) `online-check.js` + (3) gate 持久化层 + (4) `scripts/gen-prod-token-key.mjs` 轮换脚本 + (5) **CI gate** `Verify token trust-root isolation`。R1 要求等价，5 件缺一不可 |
| **env 名** | `CORTEXDEV_TOKEN_PUBLIC_KEY` | **`DEVAGENT_TOKEN_PUBLIC_KEY`** | 跟随 CLI 品牌重命名后的字节实况。R1 字节级等价 > 内部命名美学 |

注：env 名同步发现 license-mgr 仓库内 `CORTEXDEV_*` 命名（如 `CORTEXDEV_LICENSE_API_URL` / `CORTEXDEV_PUBLIC_KEY`）也面临同样问题。本设计**仅**修正与 D4 直接相关的 token env 名；其它 env 命名一致化属于独立 scope（参 §7 Q-5）。

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
import { createPublicKey } from 'node:crypto';
import { isProductionBuild } from './crypto.js';  // 复用现有 build-mode plumbing，不另开

// CLI legacy DEV_TOKEN_KEY 字节复用 — dev-keys/token-private.pem 的公钥半部
const DEV_TOKEN_KEY: string = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
-----END PUBLIC KEY-----`;

// CLI legacy PROD_TOKEN_KEY 字节复用 — 私钥半部在 Workers Secret + GitHub Secret
const PROD_TOKEN_KEY: string = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
-----END PUBLIC KEY-----`;

/** DER-byte comparison (not PEM text) — re-wrapped same key must not slip past. */
export function publicKeysEqual(a: string, b: string): boolean;

/**
 * Startup-time resolution. Throws FATAL in prod build if:
 *   - PROD_TOKEN_KEY still equals PLACEHOLDER (defensive, even byte-embedded mode)
 *   - PROD_TOKEN_KEY equals DEV_TOKEN_KEY (trust-root downgrade detection)
 *
 * Env override `DEVAGENT_TOKEN_PUBLIC_KEY`:
 *   - dev build: honoured if non-empty
 *   - prod build: refused (mirrors crypto.ts CORTEXDEV_PUBLIC_KEY behaviour)
 */
export const EMBEDDED_TOKEN_PUBLIC_KEY: string;

export { DEV_TOKEN_KEY, PROD_TOKEN_KEY };
```

**对应 CLI**：`packages/core/src/license/token-key.js`

**字节级等价要求**：
- DEV_TOKEN_KEY PEM 内容与 CLI 完全相同
- PROD_TOKEN_KEY PEM 内容与 CLI 完全相同（字节嵌入，不是 PLACEHOLDER）
- env 名 `DEVAGENT_TOKEN_PUBLIC_KEY`（**修正**：与 CLI 品牌重命名后字节一致）
- prod build 拒绝 env override 的逻辑路径与 CLI 一致
- `publicKeysEqual()` 用 SPKI DER bytes 比较（防 PEM 文本格式攻击）

**实现锚点**：build-mode 检测**复用** `crypto.ts` 的 `isProductionBuild()`，不在 token-key 里另开一份 resolver。这与 CLI 现状（`token-key.js` import `isProductionBuild` from `crypto.js`）字节同构。

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

#### 3.2.4 `scripts/gen-prod-token-key.mjs`（5 件套 #4 — 轮换工具）

**对应 CLI**：`scripts/gen-prod-token-key.mjs`

**职责**：生成 ECDSA P-256 keypair，输出：
- `token-keys/prod-token-private.pem`（PKCS8, mode 0600）→ 手动推 Workers Secret + GitHub Secret
- `token-keys/prod-token-public.pem`（SPKI）→ 手动 paste 到 `src/token-key.ts` PROD_TOKEN_KEY 常量

**强制约束**：
- `.gitignore` 必须含 `token-keys/` —— private 半部永不进 git
- 脚本结束打印操作清单（下一步：paste、push Secret、删除本地 PEM）
- 字节复用 CLI 现有脚本，仅必要的路径调整（license-mgr 仓库内 `src/token-key.ts` vs CLI 的 `packages/core/src/license/token-key.js`）

#### 3.2.5 CI gate `Verify token trust-root isolation`（5 件套 #5 — 防御纵深）

**对应 CLI**：`.github/workflows/ci.yml: Verify token trust-root isolation` step + `.github/actions/verify-key/action.yml` composite action

**职责**：在 PR / push CI 上跑两层断言，阻止 trust-root downgrade：

1. **PLACEHOLDER 检测**（composite action `.github/actions/verify-key`）：sed 抠出 `PROD_TOKEN_KEY` PEM block，grep `PLACEHOLDER` → fail。同时检 `crypto.ts: PROD_KEY` PEM block 同样断言。
2. **`publicKeysEqual` 运行时断言**（ci.yml inline node 调用）：
   - `publicKeysEqual(PROD_TOKEN_KEY, DEV_TOKEN_KEY) === false` —— 否则 prod build 信任公开 dev 私钥签的 token（吊销可被绕过）
   - `publicKeysEqual(PROD_TOKEN_KEY, PROD_KEY) === false` —— 否则两层信任根坍缩为一层，§N4 安全前提失效

**触发条件**：每次 push / PR 必须跑。release tag workflow 在 publish 之前再跑一次（双重保险）。

任一断言 fail → CI 红，PR 不可 merge / tag 不可发布。

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

## 7. Resolved questions

### Q-1：PROD_TOKEN_KEY release pipeline 注入流程 — **已撤回 v0.2 决策**

**v0.2 决策**（已撤回）：(a) tsup `define` 替换源码 PLACEHOLDER。

**v0.3 修正决策**：**字节嵌入真实 PEM**（与 CLI legacy / license-mgr 现有 PROD_KEY 三方对齐）。

**撤回原因**（详见 §0 变更摘要）：
- CLI 现行做法是源码直接嵌入真实 PEM（不再用 PLACEHOLDER）
- license-mgr 已有的 `crypto.ts: PROD_KEY` 也是直接嵌入真实 PEM
- 用 tsup `define` 会让 license-mgr 跟 CLI 在 build 工艺上分叉——无对称收益，破坏 R1 字节等价
- 公钥不是机密；进 git 历史完全合规

**新流程**：
1. `scripts/gen-prod-token-key.mjs` 生成 keypair
2. private 半部手动推到 Cloudflare Workers Secret + GitHub Secret（命名约定与 CLI 一致：`TOKEN_SIGNING_PRIVATE_KEY` env / `PROD_TOKEN_PRIVATE_KEY_PEM` GitHub Secret）
3. public 半部手动 paste 到 `src/token-key.ts` PROD_TOKEN_KEY 常量，正常 commit
4. CI gate `Verify token trust-root isolation`（§3.2.5）作为最后防线，捕获 PLACEHOLDER 残留 / DEV≡PROD / PROD_TOKEN_KEY≡PROD_KEY 三种 trust-root downgrade
5. Release 流程无需特殊 build env

**轮换流程**：每次轮换重跑 step 1-3，旧版本客户端 7 天 token TTL 内自然过期重签发，不需要 legacyTokenKeys（详见 Q-2）。轮换 SOP 写入 `docs/SECURITY.md`，参考 CLI `docs/security/prod-token-key.md`。

### Q-2：`legacyTokenKeys` 构造参数 — **不引入**

**决策**：本期不引入 token key 的 legacy 兼容机制。

**理由**：
- Token 是 7 天 TTL 的短期凭据，过期就重签发
- 新 client 拿到旧 token → token 过期 → 重新 /refresh → 拿到新 token
- 攻击面比 license payload key 小得多（license payload key 必须支持 legacy 是因为 license 寿命跨年）
- 未来 server 团队若真的要做 token key 平滑轮换，独立立项

**与 license payload `legacyKeys` 的对称性差异**：明确文档化在 `docs/SECURITY.md`，让读者理解为什么 token-key 和 payload-key 的对称性不同。

### Q-3：`online-check.json` 路径产品线隔离 — **靠 configDir 参数即可**

**决策**：不在 `online-check-store.ts` 内部做产品线判断，路径完全由 `configDir` 参数决定（与 §R9 路径策略一致）。

**实现规范**：
- `readOnlineCheck(configDir)` / `writeOnlineCheck(configDir, ...)` 接受 configDir 字符串
- 内部组装：`join(configDir, 'license', 'online-check.json')`
- 调用方（CLI / App / DevEye 等）按各自产品线路径解析后传入

**这与 §R9 完全协同**：产品线隔离是路径层的事，store 层只是按路径读写。

### Q-4：`clock_anomaly` 状态机归属 — **(c) `OfflineGraceResult.reason` 透传，不污染主状态机**

**决策**：`LicenseService` 状态机（unlicensed / validating / active / expired / revoked / error）保持不变。`clock_anomaly` 仅作为 `checkOfflineGrace()` 返回值的 `reason` 字段出现。

**实现规范**：

```typescript
export type OfflineGraceReason =
  | 'offline_expired'
  | 'clock_anomaly';

export interface OfflineGraceResult {
  authorized: boolean;
  reason?: OfflineGraceReason;
  daysLeft?: number;
  lastCheck?: string;
  tokenFailure?: 'id_mismatch' | 'expired' | 'invalid_signature';
  source?: 'signed_token' | 'last_online_check';
}
```

**Adapter 层职责**：
- CLI 现状：gate.js 读到 `clock_anomaly` 后向用户显示 "本机时钟疑似回拨，请校准系统时间" 的错误
- license-mgr 新 adapter：同样行为，但调用 `service.checkOfflineGrace()` 拿 result
- LicenseService 在用户主流程上层依然是 `active`（如果 license payload 本身校验通过）——adapter 决定要不要把 `clock_anomaly` 当 fatal

**理由**：clock anomaly 是辅助决策，不是 license 本身的状态变化。状态机里加这个值会让所有现有状态机消费方（DevAgent-App IPC layer / future DevEye）被迫处理一个跟自己无关的状态。adapter 隔离更干净。

### Q-5：license-mgr 内部 `CORTEXDEV_*` env 命名是否一致化为 `DEVAGENT_*` — **本设计不处理**

**背景**：CLI 已经完成 `cortexdev → devagent` 品牌重命名，env 名变成 `DEVAGENT_LICENSE_SERVER` / `DEVAGENT_TOKEN_PUBLIC_KEY` / `DEVAGENT_PRO_BUILD` 等。license-mgr 仓内 alpha.1 还在用 `CORTEXDEV_LICENSE_API_URL` / `CORTEXDEV_PUBLIC_KEY` / `CORTEXDEV_CONFIG_DIR`。

**决策**：本设计**仅修正与 D4 直接相关的 token env 名**（`DEVAGENT_TOKEN_PUBLIC_KEY`，因为 R1 要求字节等价）。其它 env 命名一致化（`CORTEXDEV_LICENSE_API_URL` → `DEVAGENT_LICENSE_API_URL` 等）属于独立 scope。

**理由**：
- D4 token env 命名是 R1 硬约束（CLI 已 ship，client 端要字节读相同 env 才能拿到 user override）
- 其它 env 名（如 `CORTEXDEV_LICENSE_API_URL`）alpha.1 还没有下游接入，没有用户在用
- 但全仓重命名涉及 §3.3.2 现有的双名兼容设计（Q-2=B）—— 已经在为 `CORTEXDEV_LICENSE_SERVER → CORTEXDEV_LICENSE_API_URL` 跑 deprecation，再叠加品牌重命名会让 alias 矩阵变 N×M 复杂

**Follow-up**：独立开 issue 跟踪 license-mgr 全仓 env 命名一致化（建议在 alpha.2 ship 之后做，避免 D4 工作被拖入命名争论）。本设计落地时只动 token env 名，其它保持现状。

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
- [ ] §3.2.4 `scripts/gen-prod-token-key.mjs` 落地，`.gitignore` 含 `token-keys/`
- [ ] §3.2.5 CI gate `Verify token trust-root isolation` 在主 CI workflow 跑且对 PR 必过
- [ ] §3.2.5 release workflow 二次跑 trust-root 校验（双重保险）
- [ ] PROD_TOKEN_KEY 字节嵌入完成（从 CLI legacy 复用同 PEM），CI gate 验证 ≢ DEV_TOKEN_KEY 且 ≢ PROD_KEY
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
