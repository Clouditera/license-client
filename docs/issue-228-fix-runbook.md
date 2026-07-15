# Issue #228 修复 runbook

> ⛔ **DO NOT EXECUTE — HISTORICAL ONLY.** 本文档记录 2026-06 至 2026-07 期间关于
> `PROD_TOKEN_KEY` 漂移的诊断与修复方案（Path A / B / C）。**所有 wrangler /
> shell 命令块均不再适用于当前生产环境**，直接执行会破坏已在运行的密钥。
> 生产环境已于 2026-07-15 完成 Path C 全量轮换。
>
> Status: **SUPERSEDED**（2026-07-15 Path C rotation 完成，见 license-tools issue #13）
> 关联: [devagent-cli#228](https://github.com/Clouditera/DevAgent-Cli/issues/228) · [comment 2026-06-21](https://github.com/Clouditera/DevAgent-Cli/issues/228#issuecomment-4762102960)
>
> **保留原因**：以下三个指纹是历史事实，用于追溯漂移路径。
> 当前有效的 `PROD_TOKEN_KEY` 指纹为
> `010c6729dcc1e5566c851a815f875fe6572b5138d1b5618da2f6d7d1f47a3a4a`（2026-07-15
> 全新生成，client + Worker 双侧同步部署，parity workflow 通过）。

## 1. 已确认事实

| Key | SHA-256 DER fingerprint |
|---|---|
| 客户端嵌入 `PROD_TOKEN_KEY` | `b316b81c977b61ccf344207f07861b1e1e555c08e26f99ba96dcf1e34f79132d` |
| 客户端嵌入 `DEV_TOKEN_KEY` | `9d93c86dfd8f81b740109530b0cbaf3f813babc04eafc272017b8f1d43c5ab83` |
| **生产 Worker 实际签名** | **`b6fc63f6964b6089664f8c6f577e8a1e00c3d15e2844b3e73d61ab4760bcc555`** |

生产 Worker 在用**第三对密钥**签 D4 `online_check_token`。客户端永远验签 fail，落到 Path B 60-day grace 兜底。

诊断已于 2026-06-21 完成（`license-tools` 临时分支 `ops/issue-228-diagnostic`，已 revert + delete）。

## 2. 修复路径

### Path A — 把 Worker secret 换回 PROD_TOKEN_KEY 对应的私钥（**推荐**）

前提：Clouditera 1Password / 保险柜里仍持有指纹 `b316b81c...` 对应的 P-256 私钥。

操作：
```bash
cd /Users/lijunchao/cortexdev-pro/license-client
bash scripts/swap-prod-token-key.sh /path/to/prod-token-signing-priv.pem
```

脚本会：
1. **先校验** PEM 派生出的公钥 SHA-256 DER 指纹 == `b316b81c...`（不匹配直接 abort，不会污染 production）
2. 二次确认后 `wrangler secret put` + `wrangler deploy --env production`
3. 提示客户端侧用 `pnpm diagnose:token-key` 验证

成本：~5 分钟，零客户端变更，零 license-client 发版。

### Path B — 接受 `b6fc63...` 为新事实，更新 license-client 嵌入公钥

适用：找不到 PROD_TOKEN_KEY 对应私钥。

```bash
# 1. 让运维在 Worker 里 export 公钥（不是私钥）
#    重新部署 issue228Handler 改一下：导出 SPKI PEM 而不是指纹
#    或者：直接看 wrangler.toml 是否能找到当时的 prod-public.pem

# 2. 替换 license-client 嵌入公钥
#    编辑 src/token-key.ts:62 PROD_TOKEN_KEY = `..."b6fc63..." 对应的公钥 PEM`

# 3. 隔离性自检
pnpm run verify:trust-root

# 4. 发版
# 编辑 CHANGELOG.md（新增 [1.0.0-alpha.7]）
# package.json 版本号 → 1.0.0-alpha.7
# src/index.ts VERSION = '1.0.0-alpha.7'
pnpm ci
git tag v1.0.0-alpha.7
git push --tags

# 5. 所有客户端产品升级 license-client
#    DevAgent-App: pnpm add @clouditera/license-client@1.0.0-alpha.7
#    DevAgent-CLI: 同上，bump packages/license-client submodule
#    DevEye / DevEyeProd: 同上
```

成本：私钥不用找，但需要一次 license-client minor + 跨产品升级。老版本客户端 D4 永远 fail（Path B grace 兜着）。

### Path C — 彻底轮换（生成全新密钥对）

适用：怀疑 `b6fc63...` 是被泄露过 / 来源不明 / 不想沿用。

```bash
cd /Users/lijunchao/cortexdev-pro/license-client

# 1. 生成新 P-256 keypair（输出到 token-keys/，已 gitignore）
node scripts/gen-prod-token-key.mjs

# 2. 上传新私钥到 Worker
cd /Users/lijunchao/cortexdev-pro/license-tools/server
wrangler secret put TOKEN_SIGNING_PRIVATE_KEY --env production \
  < /Users/lijunchao/cortexdev-pro/license-client/token-keys/prod-token-private.pem
wrangler deploy --env production

# 3. 把新公钥写进 license-client/src/token-key.ts
# 用 prod-token-public.pem 内容替换 PROD_TOKEN_KEY

# 4. 自检
cd /Users/lijunchao/cortexdev-pro/license-client
pnpm run verify:trust-root

# 5. 发版（同 Path B step 4-5）

# 6. 销毁本地私钥
shred -u token-keys/prod-token-private.pem  # Linux
rm -P token-keys/prod-token-private.pem     # macOS
```

成本：跟 Path B 一样（一次发版 + 全产品升级）+ 多生成密钥的开销。安全姿态最干净。

## 3. 选 path 的决策树

```
有 b316b81c... 对应私钥（保险柜里翻得到 + fingerprint 校验通过）?
├── YES → Path A（5 分钟）
└── NO  → 不知道 b6fc63... 是合法生成的吗？
          ├── YES（确认来自团队）→ Path B（接受现状）
          └── NO  / 不确定        → Path C（轮换）
```

## 4. 验证（任何 path 完成后必做）

```bash
# 1. 从一个真客户端触发一次 /refresh
devagent license refresh   # 或对应产品的等价命令

# 2. 客户端本地诊断
cd /Users/lijunchao/cortexdev-pro/license-client
pnpm diagnose:token-key
# 期望: "=> Path A is healthy. checkOfflineGrace() would authorize offline."
```

如果 path A 走完后 client 端验证仍然 FAIL：
- 检查 `~/.devagent-pro/license/online-check.json` 是否被新 `/refresh` 覆盖（mtime 应 < 1 分钟）
- 检查 D4 patch 是否真的部署进生产（看 `wrangler tail --env production` 里 refresh 路由的日志）

## 5. 完成后

- close [devagent-cli#228](https://github.com/Clouditera/DevAgent-Cli/issues/228)，附 verdict + path 编号
- 在 license-client README "诊断工具"章节加一行：本 runbook 路径
- 删除本 runbook 中 `b316b81c...` / `b6fc63f6...` / `9d93c86d...` 三个指纹是公开信息（公钥派生），无需脱敏
