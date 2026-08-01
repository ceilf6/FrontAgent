# FrontAgent 消融评测：filesense 目录导航对一次通过率的影响

> **口径**：两臂唯一的差异是**是否注入 filesense 导航步骤**（`filesenseEnabled`）。
> SDD、guard、RAG、模型、任务集、夹具、以及 filesense 的全部预算参数都相同且被显式钉死（已从 JSONL 校验）。
> 严格说关臂不是「filesense 不可用」而是「planner 不注入导航步骤」——工具仍在注册表里，
> 但计划 prompt 与 schema 都不暴露 filesense 动作，模型点不到它；下面的关臂零触发守卫会验证这一点。
> 2026-07-12 那轮的 full/ablation 两臂 **filesense 都是开的**，因此那份数据说明不了 filesense 的任何事情。

## 方法

- **夹具**：`benchmarks/eval/fixture-deep`（两臂一致，已从 JSONL 记录校验）。
- **任务集**：冻结的 12 条任务（`benchmarks/eval/tasks-deep.json`）。
- **模型**：`claude-haiku-4-5`，经 Claude Code CLI 作纯文本后端。
- **两臂**：
  - **filesense 开（full）**：默认配置，规划阶段按 `decideFilesense` 的触发策略注入导航步骤。
  - **filesense 关（no-filesense）**：`filesense.enabled = false`，`phase.filesense-navigate` 不注入。
- **验收（机器可判）**：文件存在性、内容正则、`tsc --noEmit`、既有单测。
- 日期：2026-08-01

## 先看触发率：filesense 在多少任务上真的被用到

**10/12** 条任务触发了导航（`filesense_navigated`）。
触发策略（`packages/core/src/filesense/trigger-policy.ts`）显式地不在所有任务上触发：
已知单文件任务直接用文件工具，query 类只在问到结构/定位/新鲜度时才触发。

**未触发的任务上两臂在架构上完全等价**，把它们算进总平均只会稀释效应。
故下表同时给出全量与「仅触发子集」两个口径。

## 主结果

| 指标 | filesense 关 | filesense 开 |
|---|---|---|
| **一次通过率（全量 12 条）** | **33.3%**（4/12） | **33.3%**（4/12） |
| **一次通过率（仅触发子集 10 条）** | **40.0%**（4/10） | **40.0%**（4/10） |
| 平均 LLM 调用 / 任务 | 6 | 6 |
| 平均输入 token / 任务 | 12172 | 15086 |
| 平均输出 token / 任务 | 21496 | 25442 |
| 平均时延 / 任务 | 224s | 251s |

**全量差值：0.0 个百分点（开 − 关）。**

## 导航的实际工作量（仅 filesense 开臂有意义）

这几个数字决定「按需预算供给」这条主张能不能拿数字说话——
若预算闸从未触发，说明夹具规模不足以让 filesense 发挥作用，
此时无论通过率是多少，都是夹具的结论而不是能力的结论。

| 指标 | 值 |
|---|---|
| 触发导航的任务数 | 10 / 12 |
| 累计扫描条目 | 422 |
| 触发任务的平均扫描条目 | 42 |
| **预算闸被触发（truncated）的任务数** | **1** |

## 分类通过率

| 类别 | filesense 关 | filesense 开 | 该类触发导航数 |
|---|---|---|---|
| query | 0/4（0.0%） | 0/4（0.0%） | 2/4 |
| create | 2/3（66.7%） | 2/3（66.7%） | 3/3 |
| bugfix | 0/3（0.0%） | 0/3（0.0%） | 3/3 |
| refactor | 2/2（100.0%） | 2/2（100.0%） | 2/2 |

## 规划降级（读数前必看）

LLM 规划抛错后会静默退到规则生成，而规则生成给 create 任务的目标路径是硬编码的
`src/new-file.ts`——表现为**步骤全绿、任务成功、文件写错地方**。降级过的任务
不能与正常任务混在同一个通过率里。

| 臂 | 发生降级的任务数 |
|---|---|
| filesense 开 | 0 / 12 |
| filesense 关 | 0 / 12 |

本轮无降级任务。

## 读数纪律

- 样本量 12（触发子集 10）。除非差值远大于抽样波动，**不得据此宣称 filesense 提升或无用**。
- 「用了 filesense 的任务通过率 vs 没用的任务通过率」这种**同臂内**对比是混杂的：
  触发与否由任务类型决定，而任务类型本身就有难度差。只有本报告的**跨臂同任务**对比才是有效对照。
- 若「预算闸被触发的任务数」为 0，说明夹具太小、三闸截断从未起作用，
  本轮结论只对该规模的项目成立，不能外推到真实仓库。

## 失败清单（复盘素材）

- **[filesense 开] deep-query-route-source**：result_contains(routeTable), result_contains(/checkout), result_contains(/catalog)
- **[filesense 开] deep-query-structure**：result_contains(shared)
- **[filesense 开] deep-query-format-convention**：result_contains(checkout:), result_contains(toFixed)
- **[filesense 开] deep-query-shared-lib**：result_contains(clamp), result_contains(formatDate), result_contains(pluralize)
- **[filesense 开] deep-create-entity-guard**：file_contains(isExpired)
- **[filesense 开] deep-bugfix-checkout-total**：cmd(npx vitest run src/features/checkout/lib/computeTotal.test.t)
- **[filesense 开] deep-bugfix-cart-merge**：cmd(npx vitest run src/features/cart/lib/mergeLines.test.ts)
- **[filesense 开] deep-bugfix-shipping-eta**：cmd(npx vitest run src/features/shipping/lib/estimateEta.test.ts)
- **[filesense 关] deep-query-route-source**：result_contains(routeTable), result_contains(/checkout), result_contains(/catalog)
- **[filesense 关] deep-query-structure**：result_contains(features), result_contains(shared), result_contains(entities)
- **[filesense 关] deep-query-format-convention**：result_contains(checkout:), result_contains(toFixed)
- **[filesense 关] deep-query-shared-lib**：result_contains(clamp), result_contains(formatDate), result_contains(pluralize)
- **[filesense 关] deep-create-entity-guard**：file_contains(isExpired)
- **[filesense 关] deep-bugfix-checkout-total**：cmd(npx vitest run src/features/checkout/lib/computeTotal.test.t)
- **[filesense 关] deep-bugfix-cart-merge**：cmd(npx vitest run src/features/cart/lib/mergeLines.test.ts)
- **[filesense 关] deep-bugfix-shipping-eta**：cmd(npx vitest run src/features/shipping/lib/estimateEta.test.ts)

---

## 结论（人工撰写，非生成器输出）

**在这个夹具与这批任务上，开关 filesense 导航没有产生任何通过率差异**：全量 4/12 vs 4/12，逐条 12/12 结果完全一致，分类通过率也逐类相同。代价是 full 臂多花约 **35K 输入 / 47K 输出 token**、每任务平均多 27 秒。

### 这不等于「filesense 无用」，也不构成「它有用」的证据

三条限制必须与上面的数字一起读：

1. **有效对照样本只有 8 条。** query 4 条两臂全败，且败因与 filesense 无关——`planner.ts:151` 让 query 任务永不走 LLM 规划（issue #419），导航产出无人消费。这 4 条对本次消融零判别力。
2. **两个已知缺陷在压低可测贡献，且均未修。** #419（同上）与 #420（`trigger-policy` 把任务文本里的裸目录名当扫描根，实测一次扫描因此返回 0 条）。在它们修复前，这个零差异只能读作「当前状态下不可测」。
3. **单次运行，无重复。** n=12 且每臂只跑一遍，不足以分辨小效应与抽样波动。

### 唯一可归因的观察：省一步摸索，代价是输入 token

导航精度最高的一条（`deep-refactor-route-title`，430 条目仓库里只扫 1 条即锁定 `src/app/routes`）：

| | full | off |
|---|---|---|
| 结果 | PASS | **PASS** |
| 步骤 | 6 | **7** |
| 耗时 | 251s | **340s** |
| 输入 token | 20,421 | 14,921 |
| 输出 token | 22,524 | **25,865** |

关掉导航仍然通过，但多走一步、多 89 秒、多产出 3.3K token；开着则多耗 5.5K 输入。**这是一笔可量化的交易——在这个规模的任务上并不划算。**

反方向的样本同样记录在案：`deep-create-checkout-hook` 上 full 臂输入与输出**都更高**，没有换来任何收益。所以「导航是用输入换输出」这个说法在本轮数据上**不成立**，只在个别任务上偶然成立。

### 按类别拆解零差异的成因

| 类别 | 两臂 | 瓶颈 |
|---|---|---|
| query 0/4 | 相同 | #419——不走 LLM 规划，导航结果无人消费 |
| create 2/3 | 相同 | 目标位置在任务描述里线索较强，不导航也能猜对 |
| bugfix 0/3 | 相同 | 代码生成质量，与定位无关（三条都触发了导航、也读到了源文件） |
| refactor 2/2 | 相同 | 任务本身足够简单，一步摸索即可 |

**零差异是可拆解的，不是「测不出所以没用」。** 下一步是修 #419 / #420 后重测，并设计目标位置无文本线索的任务——本轮 create 类的线索强度是本次设计的缺陷。

### 与 2026-07-12 那轮的关系

那轮的 `full` / `ablation` 两臂 **filesense 都是开的**（消融的是 SDD + guard），因此它对 filesense 不构成任何证据。本轮是第一次真正把 filesense 作为唯一变量。
