# 校验遥测修复后的观测报告（smoke 规模）

> **先读这条**：本轮**不是**对 2026-07-12 消融结论的重跑，样本量也不足以支持任何通过率结论。
> 本轮要回答的是一个前置问题：**「多层校验零拦截」这个结论本身是否可信**。
> 结论是：**部分不可信——它有相当成分是观测缺陷造成的假象**，证据见下。
> 全量 30 条双臂**未跑**，成本与阻塞见文末。

- 日期：2026-07-31
- 代码：`develop` @ `db42301` + PR #402（`543b791`）
- 模型：`claude-haiku-4-5`，经 Claude Code CLI 作纯文本后端
- 夹具：`benchmarks/eval/fixture`（与 7 月同一份）
- 原始数据：`benchmarks/results/2026-07-31-smoke/{full,ablation}.jsonl`

---

## 一、方法学限定（比数字重要，请先读）

### 1. `validation_failed` 在本轮口径下**不是**纯拦截信号

本轮 smoke 运行使用的是 PR #402 的初版实现（`543b791`）。该版本的
`validation_failed` 复合了三个来源：

| 来源 | 是否「真拦截」 |
|---|---|
| ① 执行前结构性检查失败（如 `apply_patch` 目标文件读不到） | 是（结构性），但**不是内容拦截** |
| ② 写盘前内容校验失败（guard 判定） | **是，真拦截** |
| ③ 写盘后校验失败 | **含纯工具失败**——`validateAfterExecution` 在 `resultObj.success === false` 时返回 `results: []` 的失败结果 |

即：**旧口径下把工具失败也计入了「校验失败」**。任何人拿这个计数当拦截数都会被误导。

该缺陷已在 `1a54e25`（PR #402 后续提交）修复：仅当 `results` 中存在
`pass: false` 项时才 emit，纯工具失败不再计入，并补了断言测试。
**但本报告的数字产生于修复之前**，因此下面所有 `validation_failed` 计数
都必须按上表逐条归类后才能解读。本轮的归类结果见 §三。

### 2. 样本量

每臂 5 条（smoke 子集），非 30 条冻结集。**通过率差值在 n=5 上不构成任何结论**，
本报告不给出通过率结论，只列原始数字。

### 3. 未跑任务

全量 30 条未跑（含 7 月因额度中断遗留的 `refactor-extract-listitem`、
`refactor-app-title`、`refactor-button-memo`）。原因见 §六。

### 4. 已知失效变量（两臂与 7 月同等受影响，不构成臂间偏倚）

- **代码质量子代理的 LLM 评审从未真正运行**（issue #407）。进程隔离 worker 经
  JSON 收参，注入的 `llm.backend` 是函数、必然丢失，worker 转而 provider 直连，
  失败被 `enableRuleFallback` 吞掉并返回「规则评审通过」。已核对 7 月基线提交
  `51fd4bb`：`enabled ?? true`、`isolationMode ?? 'process'`、worker 的
  `JSON.parse`、默认模型**四处完全相同**，故 7 月同样是纯规则评审。
  修复见 PR #409——**该 PR 若合并，会改变被测系统，下一轮需在报告中标注与 7 月的配置差异**。
- **`hallucinationGuard.enabled` 是死配置**（issue #400）。#392 之后 `checks` 生效而
  `enabled` 仍不生效，故 **#392 前后的 `ablation` 臂不可直接比较**——这与本次改动无关，
  但影响任何跨 7 月的对比。

---

## 二、核心证据：修复前 / 修复后确定性对照

这是本轮最可靠的一组数据：**零 LLM 消耗、输入完全相同、走真实
`runFrontAgentTask` 路径**（与评测 harness 同一入口、同一事件采集方式）。
用一段确定性坏代码（未闭合 `{`，必然触发 guard 的括号匹配检查）。

探针脚本已随本报告提交：`2026-07-31-smoke/probe-prewrite-validation.mjs`。
在待测提交上 `pnpm build` 后各跑一次即可复现下表——它不依赖任何模型行为，
两次运行之间唯一的变量就是被测代码本身。

| | 修复前（`develop` @ `db42301`） | 修复后（PR #402） |
|---|---|---|
| `validation_failed` 事件 | **0** | **1**（`syntax_validity`） |
| 坏文件是否落盘 | **是**（40 B，内容原样写入） | **否** |
| 任务错误信息 | `Syntax errors found in src/components/Probe.tsx` | `Pre-write validation failed: Syntax errors found in ...` |
| 步骤结果 | `step_failed: 1` | `step_failed: 1` |

**关键读法**：修复前 `step_failed` 同样是 1，错误信息里同样写着
`Syntax errors found` ——**校验一直在跑、也一直判失败了**，只是
①不发事件、②坏文件仍留在磁盘上。

因此 2026-07-12 报告中「`validation_failed` 两臂合计 0 次 → 多层校验零拦截」
这一推断，**至少在事件维度上是观测缺陷造成的假象**：事件在全仓根本没有
发射点（当时 `validation_failed` 只存在于 `types.ts` 的类型联合，
以及 `apps/desktop` 里一个永远不会被触发的 `case` 分支）。

---

## 三、本轮 smoke 双臂原始数据

两臂同一冻结子集（5 条）、同一模型、同一夹具。

| 指标 | full（SDD 开） | ablation（SDD 关 + guard checks 关） |
|---|---|---|
| 一次通过 | 3/5 | 2/5 |
| `validation_failed`（旧复合口径） | **0** | **2** |
| ├ 其中真·内容拦截 | **0** | **0** |
| └ 其中归类未定（结构性拦截 或 纯工具失败，见下） | 0 | **2** |
| `rollback_started` | 0 | 0 |
| 耗时 | 27.2 min | 28.6 min |
| LLM 调用（失败数） | 34（0） | 39（0） |
| 输入 / 输出 token | 112,648 / 137,363 | 98,101 / 160,163 |

逐条：

| 任务 | full | ablation |
|---|---|---|
| `query-button-props` | PASS | PASS |
| `create-usedebounce` | PASS | FAIL（vf=1） |
| `create-checkbox` | PASS | FAIL（vf=1） |
| `bugfix-formatdate` | FAIL | PASS |
| `refactor-todolist-empty` | FAIL | FAIL |

### 两个 `validation_failed` 的归类：**无法从已提交数据判定**

可以确定的只有一条：均出现在 ablation 臂，且该臂 guard 四项检查全关，
**因此不可能是内容拦截**。

本报告初版进一步把它们归为 `validateBeforeExecution` 的 `apply_patch`
结构性前置拦截。**该归因站不住**：§七 与 issue #408 引用的真实错误串是
`Cannot apply patch: file not found in context: …`，而这个字符串在全仓只有一处
产生点——`packages/core/src/skills/executor-skills.ts:242` 的 `prepareToolParams`，
抛于**步骤执行期**，不是执行前校验。`validateBeforeExecution` 的 `apply_patch`
分支产生的是另外三种文案（`executor.ts` 的 "file … does not exist (confirmed by
previous directory listing)"、"failed to auto-read file …" 与 "error reading file …"）。

两种归类会给出**相反**的结论：

| 若实为 | 在 `1a54e25` 新口径下 | 本轮该行应记 |
|---|---|---|
| 执行前结构性拦截（`results` 有判失败项） | 仍会上报 | 结构性拦截 2 |
| 纯工具失败（`validateAfterExecution` 返回 `results: []`） | **不会**上报 | 纯工具失败 2 |

本轮 JSONL 只保存了事件计数，没有保存 `ValidationResult` 负载，
**因此无法在已提交数据内判定属于哪一类**，此处不下结论。
下一轮跑之前应先让 harness 落盘事件负载（至少 `type` 与 `message`），
否则「拦截数」这个指标仍然不可直接使用。

无论属于哪一类，都不是「guard 拦下了坏代码」——真·内容拦截两臂均为 0 这一点不受影响。

### 写盘前拦截 vs 写盘后回滚

- 写盘前内容拦截：**0 次**（两臂）
- 写盘后回滚：**0 次**（两臂，`rollback_started` 均为 0）

---

## 四、坏文件是否仍留在磁盘上：**是，仍然会**

full 臂两条失败（`bugfix-formatdate`、`refactor-todolist-empty`）都是
`TS1127: Invalid character`，且 **guard 没有拦下、文件留在磁盘上**。

原因不在执行器，而在检查器本身。这两个文件的内容是**模型的中文澄清/拒绝话术
被原样当作代码写进了 `.ts`/`.tsx`**：

```
src/utils/formatDate.ts        "我需要先澄清一下：您提供的代码中没有具体说明要做什么修改。..."
src/components/TodoList.tsx    "无法完成。您提供了原始代码和一般性的修改要求..."
```

直接把这两份真实产物喂给 guard：

```
formatDate.ts   guard.validateCode pass = true | blockedBy = null
TodoList.tsx    guard.validateCode pass = true | blockedBy = null
```

`checkJavaScriptSyntax` 是**括号匹配 + 少量正则模式**，散文的括号天然平衡、
也不匹配任何错误模式，于是判定通过。已单独立 issue #406。

**这改变了本 PR 序列的读法**：PR #402 让执行器能拦住「guard 判失败的写入」，
并且确实做到了（§二）；但当检查器自己返回 `pass: true` 时，写入照样落盘。
**当前拦截率的瓶颈是检查器强度，不是执行器管线。**

> 补充：`cleanGeneratedCode` 的围栏剥离是 `/^```[\w]*\n/m`，**无 `g` 标志**，
> 只去掉第一处围栏。模型输出多代码块时内层围栏仍会留在文件里，是另一条
> TS1127 来源，同样逃过括号匹配。

---

## 五、本轮与 7 月基线的配置差异

| 项 | 7 月基线 `51fd4bb` | 本轮 |
|---|---|---|
| 任务集 / 夹具 / 模型 | 冻结集、`fixture`、`claude-haiku-4-5` | **相同**（子集为 smoke 5 条） |
| 子代理 LLM 评审 | 实际未运行（纯规则） | **相同**（PR #409 尚未合并） |
| `hallucinationGuard.checks` 是否生效 | 否（#392 之前） | **是**（#392 之后）→ ablation 臂语义已变 |
| 执行器写前校验 / 回滚 / 事件 | 无 | 有（PR #402） |

**因此本轮 ablation 臂与 7 月 ablation 臂不可直接比较**（第三行）。full 臂之间
也因 PR #402 引入了写前拦截而不完全同构。这也是本报告不给通过率结论的第二个原因。

---

## 六、全量未跑：成本与阻塞

**未跑**。不是因为额度耗尽，而是耗时超出可完成范围，按纪律不硬跑。

外推口径（本报告初版此处算错，已修正）：估算 = 7 月该臂 27 条实测总量
× **任务数缩放 30/27** × **该指标自己的实测比值**（本轮 smoke ÷ 7 月同 5 条任务）。
初版对耗时乘了两个因子、对 token 只乘了一个，且把 full 臂的耗时比值 1.11
当成了两臂通用的 token 比值——两者都不成立。

各比值按臂、按指标分别实测（本轮 smoke ÷ 7 月同 5 条任务）：

| 臂 | 耗时 | 输入 token | 输出 token |
|---|---|---|---|
| full | 1.109 | 1.251 | 0.988 |
| ablation | **0.886** | 1.372 | 1.162 |

据此的全量估算：

| 项 | full | ablation | 双臂合计 |
|---|---|---|---|
| 30 条耗时 | ≈ 135 min | ≈ 114 min | **≈ 4.2 小时** |
| 输入 token | ≈ 547K | ≈ 440K | ≈ 987K |
| 输出 token | ≈ 670K | ≈ 759K | ≈ 1.43M |
| 费用（haiku-4-5 + cache creation） | | | **≈ $10 量级** |

口径修正后输入 token 比初版高约 30%，但耗时与费用的量级结论不变。
所有输入数字均可从 `benchmarks/results/{full,ablation}.jsonl`（7 月）与
`2026-07-31-smoke/{full,ablation}.jsonl`（本轮）逐条累加复算。

后端可用性已验证：`claude` CLI v2.1.220 可用，探针调用
`is_error: false`、`total_cost_usd: 0.0145`，额度未见受限；本轮 73 次调用
0 失败。

**建议的前置条件**（否则跑完仍拿不到干净数字）：

1. 合并 `1a54e25` 的口径修复（已在 PR #402 内），否则拦截数仍是复合值。
2. 先处理 #406（检查器强度）。当前最主要的坏内容形态 guard 根本判不出来，
   此时跑全量测到的「拦截率」主要反映的是检查器盲区，而非架构效果。
3. 决定 PR #409 是否先合并，并在报告中标注与 7 月的配置差异。

---

## 七、本轮新发现（均已立 issue）

| # | 内容 | 状态 |
|---|---|---|
| #406 | guard 语法检查放行散文，TS1127 坏文件照样落盘 | 本轮实测两例 |
| #407 | 进程隔离子代理丢弃注入的 LLM backend，静默退化为规则评审 | 探针验证；PR #409 |
| #408 | `formatRunError` 把任何含 "not found" 的错误改写成伪造的 LLM 404 | 见下 |
| #400 | `hallucinationGuard.enabled` 是死配置（已存在，非本轮新发现） | 已补充评测影响 |

### 关于 #408 的一次自我纠错（记录在案）

本轮 ablation 臂两条失败的 `agentError` 显示
`LLM 请求失败：404 ... model=claude-3-5-sonnet-20241022`。我据此一度判定
是 #407 导致的真实 API 调用，并**据此写了一份错误的根因 issue**。

该判断是错的：

- `formatRunError` 只是**按子串匹配**改写错误文案，其中的 `provider`/`model`/`baseURL`
  取自解析后的默认配置，**与实际失败点无关**；
- 子代理的失败被 `enableRuleFallback` 吞掉，**根本不会冒泡成任务级错误**（探针已证）；
- 这两条任务的遥测是 `llmCalls: 10, llmFailures: 0`，注入后端全程正常。

真实错误是 `Cannot apply patch: file not found in context: ...`——一个文件系统层面的
前置失败，被文案层伪装成了 LLM 配置错误。#407 已发布更正说明，真实根因另立 #408。

记录这次纠错的原因：**伪造的 `provider`/`model`/`baseURL` 三元组让错误结论看起来
证据充分**，这正是 #408 的危害本身。
