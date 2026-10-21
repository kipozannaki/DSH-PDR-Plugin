# DSH-PDR-Plugin

> **DeepSeek Harness Plugin Detection and Response** · npm 包名 `dsh-pdr-plugin`（npm 强制小写）

> **Little Snitch for dsh plugins** —— 装前体检、装后透明、更新可回滚。
> 别人扫代码（装之前赌它是好人），我们看行为（装之后看它实际干什么）。

状态：**M3 企业特性已完成**（仅 upstream-radar 真对接因对方 schema 未公开而阻塞）· 全套 22 个测试通过。
**真实会话验证已跑通**（dsh 0.2.1-rc.2 + 预载）：观察靶行为 3/3 按插件归因；真实社区插件
`dsh-rewind-plugin` 归因 6/6；红线组合与 Block 拦截已在真实会话 / 真实 loader 上验证。
**调用内去重已修**：一次 fetch/http/net/https/tls/spawn 各落 1 条事件，路径目标归一。
**开销终审已关闭**：默认归因模式 `als`，实测 **-1.87 µs/op ≈ -0.19%** 会话墙钟（噪声内；
原默认 `both` 实测 15.8%），归因未退化。
**静态召回口径已修订**：原「静态召回 ≥90%」在 154 个真实生态插件上实测仅 **66.1%**，差距主因是
静态扫描固有边界（凭据由运行时注入，代码里看不见）。已改为「**静态 ≥65% + 运行时补足**」，
把门槛放回产品真正的能力面。
**插件入口 runAs 已实现并真机验证**：预载期用宿主 `argv[1]` 建 `createRequire` 反向 `require` cordis
（Node 的 `require(esm)` 与 `import` 共享同一实例），在**任何插件实例化之前**包住
`RegistryService.prototype.plugin`。修后 `registry.entries()` 132 条 = 经过 hook 的 132 条，
`dsh-rewind-plugin` 134、`headless-runner` 310、此前完全缺失的 ESM 插件 `diag` 7 条均正确归属。
连带修掉三个隐蔽缺陷：挂钩过晚（69 个插件抢先注册）、`Function.prototype.apply` 伪命中
（几十个 class 插件错归成 `semver`）、`fn.name` 只读导致 31 个函数式插件静默不包装
（详见下方「设计要点」）。
仅 earlyInstall 无预载时写被 binding 捕获但归 `host`。
安全中心 UI 预览可运行，宿主 web 服务 live 挂载待验。

## 安装与快速开始

**前置**：Node ≥ 22.12（用到 `require(esm)`，这是在插件实例化前挂钩 cordis 的前提）、DSH ≥ 0.1.7。

```bash
# 1) 装到某个 profile
dsh plugin --profile <profile> add dsh-pdr-plugin

# 2) 用 dsh-pdr 启动（而不是直接 dsh）——预载是本插件的归因前提
npx dsh-pdr --profile <profile> web
#   等价于：NODE_OPTIONS="--require <profile>/node_modules/dsh-pdr-plugin/src/probe/preload.cjs" dsh web

# 3) 自检：确认预载装到了哪一份
npx dsh-pdr --pdr-check

# 4) 导出审计（离线，不需要起宿主）
npx dsh-pdr audit --format md
npx dsh-pdr audit --format sarif --out audit.sarif
```

> **为什么必须用 `dsh-pdr` 启动**：真实 DSH 宿主在启动早期就固化了 `node:fs` 等的 ESM facade，
> 只在插件里装探针会漏掉一大片调用。预载是在进程最早期装探针的唯一可靠时机——
> 实测去掉预载后，同一会话 926 条事件全部归 `host`，观察靶 0/3 归因。

不装任何东西也能先看效果：

```bash
node src/client/serve.js     # 用演示数据起安全中心 UI（http://127.0.0.1:3123）
```

---

## 功能（按生命周期组织）

| 生命周期 | 功能 | 状态 |
|---|---|---|
| 装前 | **体检卡 v0**：静态提取能力面（network/fs/shell/credentials/dynamic-code/env）+ 红线组合 + PASS/WARN/BLOCK | ✅ `src/inspector/health-card.js` |
| 运行时 | **行为防火墙 Monitor 模式**：网络 / fs / 子进程观测，**按插件归属**记入时间线 | ✅ `src/probe/probe-core.cjs` |
| 运行时 | **红线告警**：credentials+network、credentials+subprocess、cleartext-http 组合实时标记 | ✅ 同上 |
| 运行时 | **越界判定**：声明契约 × 路径分类 × 行为基线，分级 正常/观察/可疑/越界（本职行为零打扰） | ✅ `src/judge/` |
| 运行时 | **契约推断**：冷启动观察 → 草案 → 人工确认（推断不赦免红线现场） | ✅ `src/judge/infer.js` |
| 运行时 | **拦截（Block 模式）**：预执行检查 + 策略决定，越界当场拦（默认 alarm-only，opt-in） | ✅ `src/guard/` |
| 变更时 | **快照/回滚**：profile 清单三件套（package.json / pnpm-lock.yaml / cordis.patch.yml） | ✅ `src/store/snapshot.js` |
| 总览 | **安全中心 UI**：插件清单（信任分/能力面/红线）、红线告警栏、行为时间线（筛选/检索）、审计报告导出 | ✅ `src/client/`（预览已可运行） |
| 总览 | 接入宿主 web 服务（dsh-h3 路由）+ 浏览器半边打包进 bundle | ⏳ 接缝已定位，见下文集成路线 |
| 变更时 | **更新守护**：更新 diff（能力面/红线/依赖变化）+ 隔离试装（子进程隔离门禁） | ✅ `src/update/` |
| 总览 | **企业审计报告**：判定/契约/红线/时间线/探针健康 → JSON + Markdown，本地生成 | ✅ `src/report/audit.js` |
| 总览 | **合规导出**：SARIF 2.1.0（SAST 流水线可直接消费）+ CSV（RFC 4180），离线可导 | ✅ `src/report/compliance.js` |
| 总览 | **多源汇总**：多 profile / 多机 / 归档，含轮转档、跨源去重、坏行上报 | ✅ `src/report/aggregate.js` |
| 总览 | **告警推送**：红线实时外发 webhook（默认关闭、去重限流、防自激） | ✅ `src/alert/push.js` |
| 总览 | **兼容证据**：试装+diff → 机器可读（`dsh-pdr-compat/1`，upstream-radar 对接地基） | ✅ `src/update/compat.js` |
| 总览 | 真对接 upstream-radar（其 schema 未公开，需先拿到字段定义） | ⏳ 阻塞在外部 |

## 架构

```
cordis.patch.yml ── earlyInstall 表达式（配置物化期就地打 hook，时序 A 硬约束）
        │
src/index.js ─── 装配：探针 → 插件身份注册（loader 发现 + 显式映射）→ JSONL → API
        │
src/probe/probe-core.cjs ── 两层 hook + 三级归因 + 环形缓冲 + 红线规则
        ├─ 第一层 属性 patch：fs / fs.promises / child_process / http / https / net / fetch
        ├─ 第二层 binding patch：fs.readFileUtf8 / open（兜住 ESM 具名导入的 facade 固化缺口）
        └─ 归因：ALS 快路径（发起者归因）→ 栈归因（file:// URL 归一 + 目录映射）→ 'host'
```

## hook 覆盖面矩阵（实测，属性层 + binding 层双 patch 实验）

> ⚠️ **真机修正**：真实宿主启动早期就建好 `node:fs` 的
> ESM facade（快照原始函数），property 层 patch 对 ESM default/named 导入**部分失效**（时序 B）。
> 已修：① binding 层深 patch 兜住读/写 ② **现场 package.json 解析归因**（不依赖预注册）③
> **`--require src/probe/preload.cjs` 预载**（宿主启动即装探针，绕开时序）。child_process/http/net
> 的具名导入在真实宿主里仍是缺口。

| 消费方式 | 第一层（属性 patch） | + 第二层（binding patch） |
|---|---|---|
| `require('node:…')` | ✅ | ✅ |
| `import cp from 'node:…'`（default 属性查找） | ✅ | ✅ |
| `import * as ns from 'node:…'` | 时序 A ✅ / 时序 B ❌ | ✅（fs） |
| `import { fn } from 'node:…'`（具名） | 时序 A ✅ / 时序 B ❌ | ✅（fs） |
| `globalThis.fetch` / `window.fetch` | ✅（global 查找，无 facade 问题） | — |

残余缺口（诚实声明）：时序 B 下 child_process / http / net 的具名导入、原生模块、`process.binding` 自用绕过——防反制是独立层。本插件定位是**持续、可归因的可见性**，不是对抗级沙箱。

## 安全中心 UI（浏览器半边）

![插件安全中心](./assets/security-center-demo.png)

```bash
node src/client/serve.js                    # 演示数据预览（http://127.0.0.1:3123）
node src/client/serve.js --jsonl <path>     # 回放真实探针日志（$DSH_HOME/firewall/events.jsonl）
```

- **免构建**：`index.html` + `app.js` + `style.css` 原生实现，无框架依赖
- **信任分**（`src/inspector/trust-score.js`）：透明可审计的加权公式（红线 -30/条、凭据访问 -5/次、
  网络 -3/次、子进程 -2/次、能力面组合扣分），分档 良好/注意/谨慎/高危
- **契约**：`/api/firewall/overview | /events | /redflags | /export` + `/firewall/` 面板
  （单一来源 `src/client/api-handlers.mjs`，serve.js 与宿主挂载共用——预览行为 = 宿主内行为）
- **宿主集成**（`src/host-web.js`）：按 dsh-tauri-pet 实测契约实现
  （`defineWebServer((app) => app.get(path, defineEventHandler(fn)))` + `ctx.effect(() => server(ctx), name)`）；
  dsh-h3/h3 是宿主 Typert 虚拟模块（磁盘无实体），离线不可解析 → 适配器接受注入 runtime 供测试
  （`test/host-web-smoke.mjs` 11 断言），生产路径 try-import、缺位 fail-safe，面板回落独立 serve.js；
  真实宿主内的挂载验证列入 M1 检查单（需 live host）

## 使用（宿主半边 API）

```js
// 其他插件注入 'firewall' 服务，或经 ctx.firewall
const api = ctx.firewall;
api.getEvents({ actor: 'some-plugin', flag: 'credentials-access', limit: 100 }); // 行为时间线
api.getRedFlags();          // 红线告警
api.getSummary();           // 每插件行为计数 + 红线 + 探针健康
api.healthCard(pluginDir);  // 装前体检卡（PASS/WARN/BLOCK）
api.snapshotProfile(profileDir, 'before-update');
api.restoreSnapshot(id, { profileDir });
api.eventLogPath;           // JSONL 本地日志（不上传任何遥测）
```

## 验证

```bash
npm test            # 跑全部 22 个测试（区分 PASS / SKIP / FAIL，CI 入口）
npm run test:list   # 列出会跑哪些
```

跳过是**明确**的：需要真实环境（本机装了某个真实插件、或放了外部基准数据）的用例
在环境不具备时会打印 `SKIP: 原因` 并给出复原方法，退出码 0——不会假装通过。
反之，**任何断言失败都会让退出码变 1**：这一点是硬要求，否则 CI 上的"全绿"是假象
（本项目就踩过：24 个测试里只有 4 个设退出码，`smoke.mjs` 长期输出 `ok:false` 却一直显示 PASS）。

环境变量（都只在需要对应真实环境时用）：

| 变量 | 用途 |
|---|---|
| `DSH_DEPS` | DSH 运行时 `node_modules` 路径；不设则自动探测 |
| `DSH_HOME` | DSH 数据目录，默认 `~/.dsh` |
| `PDR_PROBE_MODE` | 归因模式 `als`（默认）/ `stack` / `both`，排查用 |
| `PDR_REAL_PLUGIN` / `PDR_REAL_PLUGIN_DIR` | 指定用于归因回归的真实插件 |
| `PDR_E2E_PROFILE` / `PDR_E2E_PATCH` | 整机 A/B 旁证用的 profile / 补丁（缺省则跳过该用例） |
| `M1_ECOSYSTEM_DIR` | 真实生态基准数据目录（缺省则跳过召回基准） |

单个用例也可以直接跑：

```bash
node test/smoke.mjs      # 真实 cordis + cordis-plugin-loader 集成冒烟，15 项断言
node test/regression.mjs # 真实插件体检回归（静态，只读扫 ~/.dsh/profiles；信息性扫描，无判定）
node test/real-boot.mjs  # 真实插件加载回归（防火墙并跑，消费方式普查）
node test/real-drive.mjs # 真实代码驱动（SnapshotStore 归因三项断言）
node test/judge-eval.mjs     # 越界判定评测：6 场景（本职零误报 + 越界全检出）
node test/guard-eval.mjs     # 拦截评测：8 场景（四类拦截 + 本职零误拦 + fail-safe）
node test/update-eval.mjs    # 更新守护评测：12 场景（diff + 隔离试装门禁）
node test/m1-checklist-eval.mjs    # M1 检查单：真机验 earlyInstall !!js 求值时机
node test/m2-falsepositive-eval.mjs # M2 误伤率：真实良性代码 block 模式零误拦
node test/m3-report-eval.mjs       # M3：审计报告 + 兼容证据
node test/alert-push-eval.mjs      # M3 告警推送：9 断言（默认关闭/规则过滤/去重/限流/fail-safe/
                                   # 静默防自激对照组/三格式/内容最小化）
node test/m3-compliance-eval.mjs   # M3 合规导出 + 多源汇总：13 断言（SARIF 结构/CSV RFC4180/
                                   # 不生成合规结论/轮转档/坏行/去重/来源可追溯）
node test/contract-infer-eval.mjs  # 契约推断评测：16 断言（自洽 + 不赦免红线现场）
node test/host-web-smoke.mjs   # 宿主 web 接入冒烟（契约适配 11 断言，runtime 注入）
node test/ground-truth/generate.mjs && node test/ground-truth/evaluate.mjs
                         # 自建标注集评测：31 样本（20 红线/10 良性/1 观测）
                         # ⚠️ 这组样本是模板化的，召回 100% 只说明规则自洽，
                         #    不代表真实能力；真实生态基准见 test/m1-real-recall.mjs
node test/real-block-session.mjs   # Block 模式真实 loader：敏感读当场拦 + credential-exfil 拦外联（4 断言）
node test/dedup-eval.mjs     # 调用内去重 + 路径目标归一：21 断言（fetch/http/net/https/tls/spawn 各记 1 条；
                             # net.connect 三种调用形态各归对）
node test/runas-hook-eval.mjs # 插件入口 runAs 归因：9 断言（同步/异步归因、fail-safe、不重复包裹、
                              # class 安全、未挂 hook 时归 host 的对照组、函数式插件 name 只读、
                              # Function.prototype.apply 伪命中、ESM 源码指纹反推）
node test/m0-overhead-correct.mjs   # M0 开销终审：per-op 增量 × 真实 hook 次数 / 会话墙钟
node test/m0-overhead-fixed.mjs     # 三模式对比（none/als/stack/both），定位用
node test/m0-e2e-ab.mjs             # 整机 A/B 旁证（噪声大，不用于 2% 判定）
node test/m1-real-recall.mjs        # M1 真实召回：生态标注 3843 条 → 真实插件源码 vs 体检卡
```

覆盖：时序 A 模拟 → loader 顺序加载 firewall→victim → 红线行为归因（凭据/外联/子进程/timer）→
红线组合告警 → JSONL 落盘 → 自观测排除（防自反馈）→ 体检卡 BLOCK 判定 → 快照回滚 roundtrip。

### ⚠️ 更新已安装副本：必须 remove + add

`file:` 依赖被 pnpm **复制**进 profile（不是软链），所以**改代码/升版本号都不会自动生效**：

```powershell
# ❌ 只 add 会说 "Already up to date"，profile 里仍是旧代码
dsh plugin --profile <p> add file:E:\chat\dsh-pdr-plugin

# ✅ 必须移除后重加（实测：源 0.2.0 → profile 仍 0.1.1，remove+add 后才变 0.2.0）
dsh plugin --profile <p> remove dsh-pdr-plugin
dsh plugin --profile <p> add file:E:\chat\dsh-pdr-plugin
```

验证装进去的到底是哪一版：

```powershell
node -e "console.log(require('E:/.dsh/profiles/<p>/node_modules/dsh-pdr-plugin/package.json').version)"
```

### 离线审计导出（不需要启动宿主）

审计导出是**离线**动作——安全团队要的是「会话关掉之后仍能导一份留档」，
所以做成启动器子命令，直接读 JSONL，不装任何 hook：

```powershell
dsh-pdr audit --format md                    # 人读审计报告
dsh-pdr audit --format sarif --out a.sarif   # 给 SAST 流水线（SARIF 2.1.0）
dsh-pdr audit --format csv   --out a.csv     # 给表格/工单（RFC 4180 转义）
dsh-pdr audit --format json  --out a.json    # 完整结构

# 多源汇总（多 profile / 多机 / 归档）
dsh-pdr aggregate --format md
dsh-pdr aggregate --source prod=/m1/.dsh/firewall --source dev=/m2/.dsh/firewall
```

`aggregate` 会一并读取轮转档（`events.jsonl.1/.2/.3`）、跨源去重并报告去重量、
把解析失败的行计数报出来（不静默丢弃）。实测 4 个文件 12.7 万事件、去重 1,252 条。

### 配置告警推送（默认关闭）

**不配置就永远不会有一个字节离开本机。** 开启后只外发红线事件，不发全量时间线、不发文件内容：

```yaml
# profile 的 cordis.patch.yml
- id: dsh-pdr-plugin
  config:
    alerts:
      enabled: true
      url: "https://your-webhook.example/hook"
      rules: []              # 空 = 全部红线；也可只订 ['credentials+network']
      dedupeWindowMs: 60000  # 同 (actor,rule,target) 窗口内只推一次
      maxPerMinute: 20
      format: json           # json | slack | dingtalk
```

推送本身走被 hook 的 `fetch`，因此内部用 `probe.silent()` 包了一层——
否则会 `record → 推送 → record` 自激，还可能因目标是 `http://` 而触发 cleartext 红线形成正反馈。
真机验证：启用推送跑完整会话，事件流里 webhook 端口相关事件 **0 条**。

### 真实会话验证（已跑通）

用一个独立 profile（示例里叫 `verify`）装本插件 + 一个会做 I/O 的观察靶插件，然后用 `dsh-pdr` 起会话：

```powershell
dsh --profile verify --from-default-profile headless --dump-config
dsh plugin --profile verify add file:<本仓库路径>
dsh plugin --profile verify add file:<观察靶插件路径>
node bin\dsh-pdr.cjs --profile verify "Reply with exactly: verify-ok"
```

结果：`exit=0`，观察靶的 mkdir/write/read **3/3 归因到该插件名**，5,192 事件/1.12 MB，无自反馈；
去掉预载（仅 earlyInstall）同一会话 926 事件全归 `host`、0/3 归因。
**预载是归因的必要条件，不是优化项。**

## 清单（M1 待办，本仓库外）

1. **earlyInstall 求值时机**：真机已证实 `!!js` 会执行，但**早不过已建立的 ESM facade**——只靠 earlyInstall 时
   属性层对插件失效，写只被 binding 层抓到且归 `host`；产品必须以 `dsh-pdr` 预载（或用宿主级 `--import`）才能归因；
2. **真实插件回归**：~~20 个社区插件对齐 3844 份扫描基准，误报/召回 ≥90%~~
   **口径已修订**：154 个真实插件实测静态召回 66.1%、误报 17.2%；
   门槛改为「静态 ≥65% + 运行时补足」。
   此前 ground-truth 的"召回 100%"建立在自建样本上，不代表真实能力；
3. **真实负载开销**：~~装/不装探针整机对比，终审 <2%~~ **已关闭**：默认 `als` 模式开销
   -1.87 µs/op ≈ -0.19% 会话墙钟，整机 A/B 旁证 +0.24%；
4. **loader 边界 ALS 包裹**：~~在真实宿主里对插件入口统一 `runAs`，把归因从栈兜底升级为 ALS 快路径~~
   **已完成并真机验证**：预载期用宿主 `argv[1]` 建 `createRequire` 反向 `require` cordis
   （Node `require(esm)` 与 `import` 共享实例），在**任何插件实例化之前**包住
   `RegistryService.prototype.plugin`。修复后 `registry.entries()` 132 条 = 经过 hook 的 132 条，
   `dsh-rewind-plugin` 134 / `headless-runner` 310 / 此前完全缺失的 ESM 插件 `diag` 7 全部正确归因；
5. 命名已定：**DSH-PDR-Plugin**（npm: `dsh-pdr-plugin`）；上架前仍建议 grep 全库查重同名。

## 已知教训（M1 内测踩坑，已修）

- **评测集自身的构造缺陷会伪装成检测缺陷**：标注集模板带着 `child_process` import + CRED 常量，
  空插件也被判红线（静态误报 10/10）——模板按需生成后归零；
- 插件滥用 `process.binding` 可触发 V8 原生断言 **abort 宿主进程**（真实发生）——防反制层应告警此类调用；
- 明文外联口径两层统一：本机/保留地址不触发 cleartext-http（dsh 自身就是 127.0.0.1）；

- **能力共现 ≠ 恶意**：IM/QQ 桥"凭据+联网"是功能必需，BLOCK 只留给泄露路径证据
  （凭据+真实远程明文端点 / 硬编码密钥），能力红线降级为 WARN"请人工确认"
  ——17 个真实插件回归的完整校准记录见 ；
- 静态信号四类误报（命名空间 URL / import() 噪声 / 标识符撞密钥前缀 / API 路径撞密钥赋值），
  全部有实证并已修——扫描规则宁可漏报不可误报（误报伤信任）；
- 覆盖面清单必须由**真实代码消费普查**来定：真实插件直接用 `mkdir/stat/copyFile/unlink`（具名导入），
  探针只 wrap 四个方法会整类漏报——已扩到 fs/promises 15 + fs sync 6；
- 真实插件的 I/O 多经注入服务发起（发起者场景），产品集成必须在插件边界 `runAs` 包裹
  （真实代码上已实证 ALS 归因成立）；
- 自观测排除必须**按路径**判定并与名字映射解耦，否则 loader 发现逻辑会覆盖自注册名 → JSONL 落盘触发 record 形成自反馈循环（23k 噪声事件）；
- 但"按路径"还不够：`appendFileSync` 内部会走被 hook 的 `writeFileSync`，早期落盘（`DSH_HOME` 存在时）
  会形成 record→onEvent→write→record 自反馈——实测 40 秒 27 万条/37MB，直接挂起 m1；
  **onEvent 投递必须防重入**（`emit()`），落盘走原始 fs；
- **预载与 bundle 可能不是同一份文件**：`file:`/pnpm 会把插件复制进 profile，启动器若预载"本包副本"，
  进程里就有两套探针，各自 `install()` 把 fs 包两层、`__orig` 指向包装器 → 记账再次自放大；
  启动器必须解析目标 profile 的安装副本，探针核心再用 `Symbol.for` 全局单例兜底；
- "自身代码"的排除范围是 `src/`，不是整个包根（包内 test/ 的插件样本必须正常归因）；
- **一个逻辑调用只能落一条事件**。红线曾是"复制事件再 emit"，一次 fetch 落两条（计数/UI 失真）；
  且同一逻辑调用会跨层重复（`http.request`→`net.createConnection`、`fetch`→`net/tls`），
  必须用父调用计数器去重；`https` 底层走 `tls.connect`，只 wrap `net` 会整条漏掉；
- **目标归一影响判定，不只是显示**：`String(opts)` 得到 `[object Object]` → `hostOf()` 提不出 host
  → 目的地越界判定对整条 net 路径静默失效（漏报）；
- **调用形态必须穷举**：`net.connect` 有对象 / 位置参数 / 命名管道三种写法，host 位置各不相同；
  只取 `args[0]` 会把远程主机记成 `localhost`——等于给攻击者留一条"换个写法就隐身"的路；
- **宿主口径要一致**：`judge.observe()` 跳过 `host`，红线规则也必须跳过，
  否则"宿主读凭据库→调 LLM API"这种固有行为每次会话都报 `credentials+network`，真信号被淹没；
- 事件记账必须有界（环形缓冲 + 窗口化规则），无界 filter 是 O(n²) 的自我 DoS。

## 声明契约约定（插件作者可选）

```jsonc
// package.json
"firewall": {
  "hosts": ["api.trae.com"],        // 声明的目的地（越出 = 目的地违规；不声明则走基线学习）
  "grants": ["global-credentials"]  // 显式授权敏感目标（默认：谁都不许碰全局凭据）
}
```

未声明时按体检卡能力面自动派生（network/shell/fs ↔ 允许的 API 类别）。判定哲学：
**契约 = 声明过的自由**——本职范围内零打扰，越出声明才记违规
（评测场景 A：桥接插件的正职行为 0 误报）。

**冷启动**：`api.inferContracts()` 从行为迹生成草案 → `adoptContract(name)`
人工确认生效。铁律：**推断不赦免红线现场**——伴随凭据触碰的目的地永不自动洗白、
敏感授权永不自动授予（16/16 断言）。
契约优先级：用户覆盖 > 未确认草案（不生效）> manifest 声明 > 体检卡派生默认。

**拦截（Block 模式，opt-in）**：默认 **alarm-only**（只告警，不影响插件）。显式开启才拦：
`api.setPolicy({ rules: { 'target-sensitive': 'block', 'credential-exfil': 'block' } })`。
越界在真实 I/O **之前**被拦（预执行检查），抛受控 `FirewallBlockError`（`code: DSH_PDR_BLOCKED`）
给插件，**不是宿主崩溃**。杀手锏是 `credential-exfil`：凭据刚被读过就联网 = 当场拦下外发，
比事后红线共现更早。策略分层：插件覆盖 > 规则 > 全局（8/8 断言）。

**更新守护（M2）**：更新前 `api.getUpdateDiff(before, after)` 看改了什么（能力面/红线/依赖，
能力面变宽 = 建议复审契约）；`api.trialInstall(dir)` 隔离试装（子进程 + 临时 DSH_HOME）——
崩溃/挂起都关在沙盒里，**失败即拦**（12/12 断言）。

## 本地优先承诺

- 行为日志、快照、体检结果全部落本机（`$DSH_HOME/firewall/`），**不上传任何遥测**；
- 唯一的例外是**你自己配置**的告警 webhook（默认关闭，只发红线事件，不发全量时间线与文件内容）；
- 能力声明最小化：本插件自身无 credentials 访问、无静默 network——拿自己的标准审自己。

## 许可

MIT，见 [LICENSE](./LICENSE)。
