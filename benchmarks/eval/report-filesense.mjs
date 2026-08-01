// 汇总 filesense 消融（full vs no-filesense）为 Markdown 报告。
// 用法：node benchmarks/eval/report-filesense.mjs [outDir] > benchmarks/results/<date>-filesense-ablation.md
//
// 与 report.mjs 的分工：report.mjs 是 2026-07-12 那轮 SDD 消融的报告器，叙事写死；
// 本文件只回答一个问题——**关掉 filesense 会怎样**。两臂除 filesense 外配置完全相同。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'benchmarks/eval/out';
const load = (arm) =>
  readFileSync(join(dir, `${arm}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const withMap = (rows) => new Map(rows.map((r) => [r.taskId, r]));
const fullAll = load('full');
const offAll = load('no-filesense');
const fullMap = withMap(fullAll);
const offMap = withMap(offAll);

// 只在两臂都有记录的任务上比较：断点续跑可能导致某臂缺条目，缺条目不得进入对比
const commonIds = [...fullMap.keys()].filter((id) => offMap.has(id));
const arms = {
  full: commonIds.map((id) => fullMap.get(id)),
  off: commonIds.map((id) => offMap.get(id)),
};

const rate = (rows) => (rows.length ? rows.filter((r) => r.pass).length / rows.length : 0);
const avg = (rows, k) =>
  rows.length ? Math.round(rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length) : 0;
const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const count = (rows) => `${rows.filter((r) => r.pass).length}/${rows.length}`;
const navTasks = (rows) => rows.filter((r) => (r.events?.filesense_navigated ?? 0) > 0);
const truncTasks = (rows) => rows.filter((r) => r.filesenseTruncated);

const categories = [...new Set(arms.full.map((r) => r.category))];
const diffPp = ((rate(arms.full) - rate(arms.off)) * 100).toFixed(1);

// 触发率是本报告的第一读数：filesense 只在触发的任务上可能起作用，
// 不触发的任务被算进平均值只会把效应稀释成噪音。
const triggered = navTasks(arms.full);
const triggeredIds = new Set(triggered.map((r) => r.taskId));
const pairedTriggered = {
  full: triggered,
  off: arms.off.filter((r) => triggeredIds.has(r.taskId)),
};

console.log(`# FrontAgent 消融评测：filesense 目录导航对一次通过率的影响

> **口径**：两臂唯一的差异是 \`filesense.enabled\`。SDD、guard、RAG、模型、任务集、夹具全部相同。
> 2026-07-12 那轮的 full/ablation 两臂 **filesense 都是开的**，因此那份数据说明不了 filesense 的任何事情。

## 方法

- **任务集**：冻结的 ${commonIds.length} 条任务（\`benchmarks/eval/tasks.json\`）。
- **模型**：\`${process.env.EVAL_MODEL ?? 'claude-haiku-4-5'}\`，经 Claude Code CLI 作纯文本后端。
- **两臂**：
  - **filesense 开（full）**：默认配置，规划阶段按 \`decideFilesense\` 的触发策略注入导航步骤。
  - **filesense 关（no-filesense）**：\`filesense.enabled = false\`，\`phase.filesense-navigate\` 不注入。
- **验收（机器可判）**：文件存在性、内容正则、\`tsc --noEmit\`、既有单测。
- 日期：${new Date().toISOString().slice(0, 10)}

## 先看触发率：filesense 在多少任务上真的被用到

**${triggered.length}/${commonIds.length}** 条任务触发了导航（\`filesense_navigated\`）。
触发策略（\`packages/core/src/filesense/trigger-policy.ts\`）显式地不在所有任务上触发：
已知单文件任务直接用文件工具，query 类只在问到结构/定位/新鲜度时才触发。

**未触发的任务上两臂在架构上完全等价**，把它们算进总平均只会稀释效应。
故下表同时给出全量与「仅触发子集」两个口径。

## 主结果

| 指标 | filesense 关 | filesense 开 |
|---|---|---|
| **一次通过率（全量 ${commonIds.length} 条）** | **${pct(rate(arms.off))}**（${count(arms.off)}） | **${pct(rate(arms.full))}**（${count(arms.full)}） |
| **一次通过率（仅触发子集 ${triggered.length} 条）** | **${pct(rate(pairedTriggered.off))}**（${count(pairedTriggered.off)}） | **${pct(rate(pairedTriggered.full))}**（${count(pairedTriggered.full)}） |
| 平均 LLM 调用 / 任务 | ${avg(arms.off, 'llmCalls')} | ${avg(arms.full, 'llmCalls')} |
| 平均输入 token / 任务 | ${avg(arms.off, 'inputTokens')} | ${avg(arms.full, 'inputTokens')} |
| 平均输出 token / 任务 | ${avg(arms.off, 'outputTokens')} | ${avg(arms.full, 'outputTokens')} |
| 平均时延 / 任务 | ${Math.round(avg(arms.off, 'elapsedMs') / 1000)}s | ${Math.round(avg(arms.full, 'elapsedMs') / 1000)}s |

**全量差值：${diffPp} 个百分点（开 − 关）。**

## 导航的实际工作量（仅 filesense 开臂有意义）

这几个数字决定「按需预算供给」这条主张能不能拿数字说话——
若预算闸从未触发，说明夹具规模不足以让 filesense 发挥作用，
此时无论通过率是多少，都是夹具的结论而不是能力的结论。

| 指标 | 值 |
|---|---|
| 触发导航的任务数 | ${triggered.length} / ${commonIds.length} |
| 累计扫描条目 | ${sum(arms.full, 'filesenseEntries')} |
| 触发任务的平均扫描条目 | ${avg(triggered, 'filesenseEntries')} |
| **预算闸被触发（truncated）的任务数** | **${truncTasks(arms.full).length}** |

## 分类通过率

| 类别 | filesense 关 | filesense 开 | 该类触发导航数 |
|---|---|---|---|`);
for (const c of categories) {
  const f = arms.full.filter((r) => r.category === c);
  const o = arms.off.filter((r) => r.category === c);
  console.log(
    `| ${c} | ${count(o)}（${pct(rate(o))}） | ${count(f)}（${pct(rate(f))}） | ${navTasks(f).length}/${f.length} |`,
  );
}

console.log(`
## 读数纪律

- 样本量 ${commonIds.length}（触发子集 ${triggered.length}）。除非差值远大于抽样波动，**不得据此宣称 filesense 提升或无用**。
- 「用了 filesense 的任务通过率 vs 没用的任务通过率」这种**同臂内**对比是混杂的：
  触发与否由任务类型决定，而任务类型本身就有难度差。只有本报告的**跨臂同任务**对比才是有效对照。
- 若「预算闸被触发的任务数」为 0，说明夹具太小、三闸截断从未起作用，
  本轮结论只对该规模的项目成立，不能外推到真实仓库。

## 失败清单（复盘素材）
`);
for (const [armName, rows] of Object.entries(arms)) {
  const label = armName === 'full' ? 'filesense 开' : 'filesense 关';
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
const droppedOff = offAll.filter((r) => !commonIds.includes(r.taskId)).map((r) => r.taskId);
if (droppedFull.length || droppedOff.length) {
  console.log(`
## 未进入对比的记录（仅单臂有数据，按方法学剔除）

- 仅 filesense 开臂：${droppedFull.join(', ') || '无'}
- 仅 filesense 关臂：${droppedOff.join(', ') || '无'}`);
}
