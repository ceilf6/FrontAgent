# FrontAgent 消融评测：SDD 规格约束对一次通过率的影响

> **⚠ 本报告的「零拦截」结论已被后续工作限定，读数前请先看：[`2026-07-31-validation-telemetry.md`](2026-07-31-validation-telemetry.md)。**
> 当时 `validation_failed` 在全仓**没有任何发射点**，所以它不可能是 0 以外的值——
> 那个计数测得准，但它证明的是「事件没接线」，不是「校验没拦住」。
> 一个零 LLM 消耗的确定性探针显示：校验一直在跑、也一直判失败了，
> 它只是既不阻断也不上报。

> **先读这条**：本轮原计划消融「SDD + 幻觉防控（guard）」两项，实测发现 **guard 无法通过既有配置关闭**（见「意外发现」节）。
> 因此本报告的有效结论限于 **SDD 开 / 关**；guard 在两臂中均处于启用状态。

## 方法

- **任务集**：冻结的 27 条任务（`benchmarks/eval/tasks.json`），两臂使用同一任务集、同一夹具工程（`benchmarks/eval/fixture`）、同一模型。
- **模型**：`claude-haiku-4-5`，经 Claude Code CLI 作纯文本后端（禁用工具、空 cwd 防宿主上下文注入）。
- **两臂**：
  - **SDD 开（full）**：`sddPath` 指向夹具的 `sdd.yaml`，规格约束参与规划与校验。
  - **SDD 关（ablation）**：`sddPath` 指向不存在的文件，`AgentConfig.sddPath` 解析为 `undefined`。
- **验收（机器可判）**：文件存在性、内容正则、`tsc --noEmit`、既有单测（`vitest run`）。「一次通过」= 单轮任务结束后全部断言通过、无人工干预。
- **RAG**：两臂均关闭（默认指向与夹具无关的外部仓库，属噪音变量）。
- 日期：2026-07-12

## 主结果

| 指标 | SDD 关 | SDD 开 |
|---|---|---|
| **一次通过率** | **70.4%**（19/27） | **66.7%**（18/27） |
| 平均 LLM 调用 / 任务 | 6 | 6 |
| 平均输出 token / 任务 | 21766 | 22605 |
| 平均时延 / 任务 | 257s | 243s |

**差值：-3.7 个百分点（SDD 开 − SDD 关）。** 在 27 条任务的样本量下，该差值不足以支持「SDD 提升一次通过率」的结论。

## 意外发现：幻觉防控层没有拦下它本应拦下的东西

本轮最有价值的产出不是通过率，而是三处经代码定位的缺陷：

1. **`hallucinationGuard.enabledChecks` 对执行路径无效（死配置）**
   该字段只在 `HallucinationGuard.validate()` 中被读取，而执行器从不调用该方法——执行器走的是 `validateFilePath()` / `validateCode()`（`executor.ts`），这两个方法直接调用底层 check，**完全不查 `enabledChecks`**（`guard.ts`）。
   后果：guard 无法通过公开配置关闭，本次消融实验的 guard 臂因此失效。

2. **校验发生在写盘之后，且默认不回滚**
   `validateAfterExecution` 在工具执行完成后才校验；失败仅将 step 标记为 `success: false`，回滚条件是 `step.validation.some(v => v.required)`——而 LLM 生成的计划中 `validation` 常为空数组，于是**不触发回滚，已写入的坏文件留在磁盘上**。

3. **`validation_failed` 事件从未触发**
   两臂合计 0 次。该事件挂在执行器不走的那条校验路径上，导致「校验是否起作用」在遥测层面不可观测。

**实证**：失败样本中出现 `TS1127: Invalid character`——markdown 代码围栏被原样写进 `.tsx` 文件并落盘，两臂皆有。这正是 `checkSyntaxValidity` 的目标场景，guard 在运行却未阻止其落盘，与缺陷 2 的机制一致。

## 分类通过率

| 类别 | SDD 关 | SDD 开 |
|---|---|---|
| query | 8/10（80.0%） | 8/10（80.0%） |
| create | 8/10（80.0%） | 7/10（70.0%） |
| bugfix | 3/5（60.0%） | 3/5（60.0%） |
| refactor | 0/2（0.0%） | 0/2（0.0%） |

## 结论与后续

- **不宣称 SDD 提升了一次通过率**：本任务集上差值 -3.7pp，样本量 27，不构成证据。
- **不宣称多层校验拦截了幻觉**：在 303 次 LLM 调用中零拦截记录，且语法错误文件确实落盘。
- **后续（按优先级）**：
  1. 修复缺陷 1——让 `enabledChecks` 贯通 `validateFilePath`/`validateCode`，使 guard 可配置、可消融。
  2. 修复缺陷 2——校验前置到写盘前，或在校验失败时无条件回滚。
  3. 修复缺陷 3——在执行器校验路径上补 `validation_failed` 事件。
  4. 修完重跑同一冻结任务集，得到 guard 的真实前后对比。
- **评测资产可复用**：冻结任务集、夹具、双臂开关、机器验收、断点续跑均已固化，任何架构改动都可用同一口径复测。

## 失败清单（复盘素材）

- **[SDD 开] query-structure**：result_contains(components), result_contains(hooks), result_contains(utils)
- **[SDD 开] query-test-files**：result_contains(formatDate), result_contains(clamp)
- **[SDD 开] create-card**：typecheck(src/components/Card.tsx(24,3): error TS1109: Expression expe)
- **[SDD 开] create-formatcurrency**：file_contains(export function formatCurrency)
- **[SDD 开] create-spinner**：file_contains(export function Spinner), typecheck(src/components/Spinner.tsx(14,27): error TS1005: ';' expecte)
- **[SDD 开] bugfix-pluralize**：cmd(npx vitest run src/utils/pluralize.test.ts)
- **[SDD 开] bugfix-truncate**：cmd(npx vitest run src/utils/truncate.test.ts)
- **[SDD 开] refactor-todolist-empty**：file_contains(暂无待办)
- **[SDD 开] refactor-button-disabled**：typecheck(src/components/Button.tsx(1,1): error TS1127: Invalid charac)
- **[SDD 关] query-structure**：result_contains(components), result_contains(hooks), result_contains(utils)
- **[SDD 关] query-test-files**：result_contains(formatDate), result_contains(clamp)
- **[SDD 关] create-card**：file_contains(export function Card)
- **[SDD 关] create-spinner**：file_contains(export function Spinner)
- **[SDD 关] bugfix-pluralize**：cmd(npx vitest run src/utils/pluralize.test.ts), typecheck(src/utils/pluralize.ts(1,13): error TS1127: Invalid characte)
- **[SDD 关] bugfix-truncate**：cmd(npx vitest run src/utils/truncate.test.ts)
- **[SDD 关] refactor-todolist-empty**：file_contains(暂无待办)
- **[SDD 关] refactor-button-disabled**：typecheck(src/components/Button.tsx(1,3): error TS1127: Invalid charac)

## 样本完整性声明

冻结任务集共 30 条；因评测账号额度限制，`refactor-extract-listitem`、`refactor-app-title`、`refactor-button-memo` 三条在两臂中**均未执行**，对称剔除，不引入组间偏差。本报告的一切结论基于两臂共有的 27 条。补跑命令见 README「Architecture Ablation Benchmark」。
