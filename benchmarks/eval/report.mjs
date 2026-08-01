// 汇总双臂 JSONL 为 Markdown 报告。
// 用法：node benchmarks/eval/report.mjs [outDir] > benchmarks/results/<date>-sdd-ablation.md
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'benchmarks/eval/out';
const load = (arm) =>
  readFileSync(join(dir, `${arm}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const fullAll = load('full');
const ablationAll = load('ablation');

// 只在两臂都有记录的任务上比较：中断续跑可能导致某臂缺条目，缺条目不得进入对比
const fullMap = new Map(fullAll.map((r) => [r.taskId, r]));
const ablationMap = new Map(ablationAll.map((r) => [r.taskId, r]));
const commonIds = [...fullMap.keys()].filter((id) => ablationMap.has(id));
const arms = {
  full: commonIds.map((id) => fullMap.get(id)),
  ablation: commonIds.map((id) => ablationMap.get(id)),
};

const rate = (rows) => (rows.length ? rows.filter((r) => r.pass).length / rows.length : 0);
const avg = (rows, k) => (rows.length ? Math.round(rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length) : 0);
const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const sumEvent = (rows, k) => rows.reduce((s, r) => s + (r.events?.[k] ?? 0), 0);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const count = (rows) => `${rows.filter((r) => r.pass).length}/${rows.length}`;

const categories = [...new Set(arms.full.map((r) => r.category))];
const diffPp = ((rate(arms.full) - rate(arms.ablation)) * 100).toFixed(1);

console.log(`# FrontAgent 消融评测：SDD 规格约束对一次通过率的影响

> **先读这条**：本轮原计划消融「SDD + 幻觉防控（guard）」两项，实测发现 **guard 无法通过既有配置关闭**（见「意外发现」节）。
> 因此本报告的有效结论限于 **SDD 开 / 关**；guard 在两臂中均处于启用状态。

## 方法

- **任务集**：冻结的 ${commonIds.length} 条任务（\`benchmarks/eval/tasks.json\`），两臂使用同一任务集、同一夹具工程（\`benchmarks/eval/fixture\`）、同一模型。
- **模型**：\`${process.env.EVAL_MODEL ?? 'claude-haiku-4-5'}\`，经 Claude Code CLI 作纯文本后端（禁用工具、空 cwd 防宿主上下文注入）。
- **两臂**：
  - **SDD 开（full）**：\`sddPath\` 指向夹具的 \`sdd.yaml\`，规格约束参与规划与校验。
  - **SDD 关（ablation）**：\`sddPath\` 指向不存在的文件，\`AgentConfig.sddPath\` 解析为 \`undefined\`。
- **验收（机器可判）**：文件存在性、内容正则、\`tsc --noEmit\`、既有单测（\`vitest run\`）。「一次通过」= 单轮任务结束后全部断言通过、无人工干预。
- **RAG**：两臂均关闭（默认指向与夹具无关的外部仓库，属噪音变量）。
- 日期：${new Date().toISOString().slice(0, 10)}

## 主结果

| 指标 | SDD 关 | SDD 开 |
|---|---|---|
| **一次通过率** | **${pct(rate(arms.ablation))}**（${count(arms.ablation)}） | **${pct(rate(arms.full))}**（${count(arms.full)}） |
| 平均 LLM 调用 / 任务 | ${avg(arms.ablation, 'llmCalls')} | ${avg(arms.full, 'llmCalls')} |
| 平均输出 token / 任务 | ${avg(arms.ablation, 'outputTokens')} | ${avg(arms.full, 'outputTokens')} |
| 平均时延 / 任务 | ${Math.round(avg(arms.ablation, 'elapsedMs') / 1000)}s | ${Math.round(avg(arms.full, 'elapsedMs') / 1000)}s |

**差值：${diffPp} 个百分点（SDD 开 − SDD 关）。** 在 ${commonIds.length} 条任务的样本量下，该差值不足以支持「SDD 提升一次通过率」的结论。

## 意外发现：幻觉防控层没有拦下它本应拦下的东西

本轮最有价值的产出不是通过率，而是三处经代码定位的缺陷：

1. **\`hallucinationGuard.enabledChecks\` 对执行路径无效（死配置）**
   该字段只在 \`HallucinationGuard.validate()\` 中被读取，而执行器从不调用该方法——执行器走的是 \`validateFilePath()\` / \`validateCode()\`（\`executor.ts\`），这两个方法直接调用底层 check，**完全不查 \`enabledChecks\`**（\`guard.ts\`）。
   后果：guard 无法通过公开配置关闭，本次消融实验的 guard 臂因此失效。

2. **校验发生在写盘之后，且默认不回滚**
   \`validateAfterExecution\` 在工具执行完成后才校验；失败仅将 step 标记为 \`success: false\`，回滚条件是 \`step.validation.some(v => v.required)\`——而 LLM 生成的计划中 \`validation\` 常为空数组，于是**不触发回滚，已写入的坏文件留在磁盘上**。

3. **\`validation_failed\` 事件${
     sumEvent(arms.full, 'validation_failed') + sumEvent(arms.ablation, 'validation_failed') > 0
       ? '为复合口径计数'
       : '从未触发'
   }**
   两臂合计 ${sumEvent(arms.full, 'validation_failed') + sumEvent(arms.ablation, 'validation_failed')} 次。${
     sumEvent(arms.full, 'validation_failed') + sumEvent(arms.ablation, 'validation_failed') > 0
       ? '注意这是复合值，不是拦截数——见下方分阶段分解，以及 `benchmarks/results/2026-07-31-validation-telemetry.md`。'
       : '该事件当时在全仓没有任何发射点，所以它不可能是 0 以外的值：这个 0 证明的是「事件没接线」，不是「校验没拦住」。限定见 `benchmarks/results/2026-07-31-validation-telemetry.md`。'
   }

**实证**：失败样本中出现 \`TS1127: Invalid character\`——markdown 代码围栏被原样写进 \`.tsx\` 文件并落盘，两臂皆有。这正是 \`checkSyntaxValidity\` 的目标场景，guard 在运行却未阻止其落盘，与缺陷 2 的机制一致。

## 分类通过率

| 类别 | SDD 关 | SDD 开 |
|---|---|---|`);
for (const c of categories) {
  const f = arms.full.filter((r) => r.category === c);
  const a = arms.ablation.filter((r) => r.category === c);
  console.log(`| ${c} | ${count(a)}（${pct(rate(a))}） | ${count(f)}（${pct(rate(f))}） |`);
}

console.log(`
## 结论与后续

- **不宣称 SDD 提升了一次通过率**：本任务集上差值 ${diffPp}pp，样本量 ${commonIds.length}，不构成证据。
- **不宣称多层校验拦截了幻觉**：在 ${sum(arms.full, 'llmCalls') + sum(arms.ablation, 'llmCalls')} 次 LLM 调用中零拦截记录，且语法错误文件确实落盘。**该「零」已被限定**——见 \`benchmarks/results/2026-07-31-validation-telemetry.md\`：事件当时无发射点，零是观测缺陷而非拦截结果。
- **后续（按优先级）**：
  1. 修复缺陷 1——让 \`enabledChecks\` 贯通 \`validateFilePath\`/\`validateCode\`，使 guard 可配置、可消融。
  2. 修复缺陷 2——校验前置到写盘前，或在校验失败时无条件回滚。
  3. 修复缺陷 3——在执行器校验路径上补 \`validation_failed\` 事件。
  4. 修完重跑同一冻结任务集，得到 guard 的真实前后对比。
- **评测资产可复用**：冻结任务集、夹具、双臂开关、机器验收、断点续跑均已固化，任何架构改动都可用同一口径复测。

## 失败清单（复盘素材）
`);
for (const [armName, rows] of Object.entries(arms)) {
  const label = armName === 'full' ? 'SDD 开' : 'SDD 关';
  for (const r of rows.filter((x) => !x.pass)) {
    const why =
      r.runError ??
      r.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.kind}(${String(c.detail).slice(0, 60)})`)
        .join(', ');
    console.log(`- **[${label}] ${r.taskId}**：${why}`);
  }
}

const droppedFull = fullAll.filter((r) => !commonIds.includes(r.taskId)).map((r) => r.taskId);
const droppedAblation = ablationAll.filter((r) => !commonIds.includes(r.taskId)).map((r) => r.taskId);
if (droppedFull.length || droppedAblation.length) {
  console.log(`
## 未进入对比的记录（仅单臂有数据，按方法学剔除）

- 仅 SDD 开臂：${droppedFull.join(', ') || '无'}
- 仅 SDD 关臂：${droppedAblation.join(', ') || '无'}`);
}
