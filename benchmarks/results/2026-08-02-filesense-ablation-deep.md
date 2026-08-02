# filesense 消融实验（深层夹具，第二轮）

**日期**：2026-08-02
**结论**：本实验**未能证明** filesense 目录导航改善任务结果。通过率 4/12 对 4/12。
但实验定位了零效应的结构性根因（#434），该根因说明当前接线方式下效应必然为零。

---

## 一、先说这份数据不能用来说什么

- 不能说「filesense 提升了通过率」——没有。
- 不能说「filesense 没用」——本实验测的是**当前接线方式下的 filesense**，而接线方式被证明是错的（§五）。
- 不能说差异「显著」——阴性对照显示噪声量级 ≥ 观测到的差异（§三）。

口径在见数据前定死：主指标为探索质量三桶、按是否触发导航分层；通过率为副指标。
定死的原因是上一轮踩过的坑——拿到数字再挑指标，就是给结论找证据。

---

## 二、方法

| 项 | 值 |
|---|---|
| 夹具 | `benchmarks/eval/fixture-deep`，242 文件 / 188 目录 / 430 条目，深度 5 |
| 任务 | `benchmarks/eval/tasks-deep.json` 12 条（query 4 / create 3 / bugfix 3 / refactor 2）|
| 模型 | `claude-haiku-4-5`（经 Claude Code CLI 作纯文本后端，实测 `modelUsage` 回报一致）|
| 两臂 | 唯一差异 `filesenseEnabled`；SDD、guard、RAG、模型、任务、夹具全部相同 |
| 样本 | 每臂 12/12 全部跑完，单次运行 |

**有效性核验**（全部通过）：

- 关臂 12 条**无一条**触发 `filesense_navigated`，`filesenseEntries` 全为 0——消融确实生效。
- 两臂各 12 条唯一任务，**0 规划降级、0 runError、0 LLM 失败**。
- 夹具生成确定性已验证（无 `Math.random`/`Date.now`，连生两次哈希一致 `cb967975df42f677`），
  两臂跑在同一份仓库上。

> 2026-07-12 那轮的 full/ablation 两臂 **filesense 都是开的**，那份数据说明不了 filesense 的任何事情。
> 本轮新增 `no-filesense` 臂即为此。

---

## 三、主结果

### 全量 12 条

| | 通过 | 命中 | 幻觉文件名 | 脱靶 | 输出 token | 耗时 |
|---|---|---|---|---|---|---|
| filesense 开 | **4/12** | 23 | **8** | 2 | 292,726 | 52 分 |
| filesense 关 | **4/12** | 30 | **9** | 4 | 317,724 | 56 分 |

### 触发导航的 8 条（唯一能参与对照的子集）

| | 通过 | 命中 | 幻觉 | 脱靶 |
|---|---|---|---|---|
| filesense 开 | 3/8 | 17 | **7** | 1 |
| filesense 关 | 2/8 | 16 | **8** | 1 |

### 阴性对照：未触发导航的 4 条

这 4 条上两臂**架构完全等价**（关臂本就不导航，开臂也没触发），差异只能来自运行间随机性。

| | 通过 |
|---|---|
| filesense 开 | 1/4 |
| filesense 关 | 2/4 |

**噪声底线是 1 条任务。** 而触发子集上观测到的差异也是 1 条任务、1 个幻觉。
**观测量 ≤ 噪声量，本实验分辨不出效应。**

配对检验同样为空：12 条里不一致的配对各 1 条（开臂赢 `deep-query-route-source`，
关臂赢 `deep-refactor-route-title`），完全打平。

---

## 四、通过率为什么是副指标

`deep-create-shared-truncate`（开臂，触发导航）：

- 导航读了 `clamp.ts` / `pluralize.ts` / `clamp.test.ts`，**全部命中目标目录，0 幻觉**，约定学对了
- 文件建在正确位置 `src/shared/lib/truncate.ts`，`file_exists` 与 `file_contains` 均通过
- 失败在生成的测试文件：`import { truncate }` 与局部 `truncate` 声明冲突，`TS2440`

导航负责「去哪读、往哪写」，通过率被下游代码生成质量主导。
拿通过率评导航，等于用整车油耗评轮胎。

---

## 五、零效应的根因（#434）

### 结构

`packages/core/src/skills/planner-skills.ts:177`

```ts
return [navigateStep, ...steps];
```

导航步骤**前插**到一份已生成的计划上。`steps` 里每一步的 `path` 参数在导航执行前就已确定。
导航产出只写进 `collectedContext.filesenseContext`，消费方是答案生成（`answer-generation.ts:85`）
与上下文消息（`context-manager.ts:272`）——**没有任何一处回改 `steps[i].params.path`**。

扫描目标的来源更反直觉，`trigger-policy.ts:211`：

```ts
paths: mergeFocusDirs(task, collectTargetDirs(steps)),
```

`collectTargetDirs(steps)` 从**计划步骤**取目录。计划的猜测决定导航去哪扫，而非相反。

### 实证：四例全中

开臂每一条产生幻觉文件名的任务，导航都覆盖了真实文件所在目录且 `truncated: false`
（真实文件名确实在输出里），计划仍然写了一个不存在的同义词：

| 任务 | 导航覆盖 | 真实文件 | 计划却读了 |
|---|---|---|---|
| deep-bugfix-checkout-total | `src/features/checkout/lib` entries=18 | `computeTotal.ts` | `calculateTotal.ts` |
| deep-bugfix-cart-merge | `src/features/cart/lib` entries=18 | `mergeLines.ts` | `mergeCartItem.ts` |
| deep-bugfix-shipping-eta | `src/features/shipping/lib` entries=18 | `estimateEta.ts` | `estimateDeliveryDays.ts` |
| deep-create-entity-guard | `src/entities/coupon/model` entries=43 | `coupon.ts` | `types.ts` |

`deep-create-entity-guard` 还暴露了箭头方向：导航路径里有 `src/entities/file/model`，
而 `src/entities/file` **根本不存在**（实际实体为 address/category/coupon/invoice/order/
product/refund/review/session/shipment/subscription/user）。
计划先幻觉出该目录，导航被指挥去扫它，模型随后又去读了 `src/entities/file/model/guards.ts`。

### 两臂幻觉同型

关臂 9 个、开臂 8 个幻觉文件名，**全部是语义猜名**：

```
computeTotal   → calculateTotal
mergeLines     → mergeCartItem / mergeCart
estimateEta    → estimateDeliveryDays / estimateDeliveryTime
routeTable.ts  → routes.ts
coupon.ts      → types.ts
```

导航拿到了正确答案却不参与这个决策，所以开不开它，猜错的方式一模一样。
**在当前接线方式下，零效应是结构决定的，不是样本量问题。**

---

## 六、本轮暴露的其他缺陷

| Issue | 内容 | 对本实验的影响 |
|---|---|---|
| #434 | 导航结果不回改计划（本文 §五）| 根因 |
| #433 | `search_code` 把模型给的 glob 编译成正则，非法即整次搜索硬失败 | 两臂相同，非混淆；压低两臂绝对通过率 |
| #432 | `run-eval` 的 `exploredGhost` 恒为 0 | 已改由分析器探文件系统重算 |
| #425 | 导航触发对 query/modify 类由关键词正则决定 | 最该导航的 `deep-query-structure` 不触发 |

---

## 七、方法学：本轮自己犯的两个错

写在这里不是免责，是这份数据可信的理由——**两个错都是靠检查工具而非检查结论发现的**。

### 1. 两臂用了两套指标定义

关臂在改指标的分支上跑（新口径），开臂在 develop 上跑（旧口径）。
逐行检查记录是否含 `exploredGhost` 字段才发现。
处理：合入新口径后**重跑开臂**，而不是丢掉关臂数据。

### 2. 新口径的前提是假的

新口径判据为「读不存在的文件会让步骤失败」。
实测 **36/36 个探索步骤全部 `ok=true`**，其中三条指向不存在的路径——
读文件失败不会让步骤失败，工具照常返回，错误在返回内容里。

而分析器写成「只要 `ok` 是布尔就信它」，于是用一个恒真信号**短路掉了本来能工作的文件系统探测**，
把主指标打成恒零。**零和「没测出来」在表里长得一模一样**，差点据此得出「导航没能减少幻觉」的反向结论。

修法：文件系统探测为唯一权威，`ok` 只在工作区缺失时作为辅证，且 `ok=true` 记为不可判定而非命中。

**能事后修正的唯一原因是记录存的是完整轨迹而不是计数。**
口径错了可以重算，计数错了只能重跑。

---

## 八、下一步

1. **修 #434 后重跑**——这是唯一可能改变结论的改动。两种修法：
   导航前置于规划、或导航后加一道路径校正（拿导航结果核对每步 `path`，不存在则替换）。
2. 修 #433，消除与被测能力无关的失败噪声。
3. 提高分辨率：当前 12 任务 × 单次运行分辨不出 1 条任务量级的差异。
   要么增加任务数，要么每臂多次运行取分布。
4. 把 model 落进 JSONL 记录——现在报告里的模型名来自与后端**各自独立**的同值硬编码，
   两处不同步时会静默写错实验条件。

---

## 附：原始数据

- `benchmarks/eval/out-final/full-deep.jsonl`（12 条）
- `benchmarks/eval/out-final/no-filesense-deep.jsonl`（12 条）

复现：

```bash
node benchmarks/eval/run-eval.mjs --arm full --fixture deep --tasks all --out <dir>
node benchmarks/eval/run-eval.mjs --arm no-filesense --fixture deep --tasks all --out <dir>
node benchmarks/eval/analyze-exploration.mjs <dir> deep
```
