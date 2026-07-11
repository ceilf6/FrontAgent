// 汇总双臂 JSONL 为 Markdown 报告。
// 用法：node benchmarks/eval/report.mjs [outDir] > benchmarks/results/<date>-architecture-ablation.md
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'benchmarks/eval/out';
const load = (arm) =>
  readFileSync(join(dir, `${arm}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const arms = { full: load('full'), ablation: load('ablation') };
const rate = (rows) => rows.filter((r) => r.pass).length / rows.length;
const avg = (rows, k) => Math.round(rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const categories = [...new Set(arms.full.map((r) => r.category))];
const guardEvents = arms.full.reduce((s, r) => s + (r.events?.validation_failed ?? 0), 0);
const validations = arms.full.reduce((s, r) => s + (r.validationCount ?? 0), 0);

console.log(`# FrontAgent 架构消融评测（guard + SDD on/off）

- 任务集：${arms.full.length} 条冻结任务（benchmarks/eval/tasks.json）
- 模型：${process.env.EVAL_MODEL ?? 'claude-haiku-4-5'}（两臂同模型、同任务集、同夹具）
- 日期：${new Date().toISOString().slice(0, 10)}

## 总表

| 指标 | 消融臂（关 guard+SDD） | 全开臂 |
|---|---|---|
| 一次通过率 | ${pct(rate(arms.ablation))} | ${pct(rate(arms.full))} |
| 平均 LLM 调用/任务 | ${avg(arms.ablation, 'llmCalls')} | ${avg(arms.full, 'llmCalls')} |
| 平均输出 token/任务 | ${avg(arms.ablation, 'outputTokens')} | ${avg(arms.full, 'outputTokens')} |
| 平均时延 ms/任务 | ${avg(arms.ablation, 'elapsedMs')} | ${avg(arms.full, 'elapsedMs')} |

全开臂校验活动：validation_failed 事件 ${guardEvents} 次；结果内 validations 记录合计 ${validations} 条。

## 分类通过率

| 类别 | 消融臂 | 全开臂 |
|---|---|---|`);
for (const c of categories) {
  const f = arms.full.filter((r) => r.category === c);
  const a = arms.ablation.filter((r) => r.category === c);
  console.log(`| ${c} | ${pct(rate(a))} | ${pct(rate(f))} |`);
}
console.log(`
## 失败清单（复盘素材）
`);
for (const [arm, rows] of Object.entries(arms)) {
  for (const r of rows.filter((x) => !x.pass)) {
    console.log(
      `- [${arm}] ${r.taskId}: ${r.runError ?? r.checks.filter((c) => !c.ok).map((c) => `${c.kind}(${c.detail})`).join(', ')}`,
    );
  }
}
