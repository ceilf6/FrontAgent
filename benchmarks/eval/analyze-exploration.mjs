#!/usr/bin/env node
/**
 * Recompute exploration metrics from observations saved with each event.
 * Usage: node benchmarks/eval/analyze-exploration.mjs <outDir> [deep]
 * Legacy events without existence observations remain unknown after replay.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyExploration } from './exploration.mjs';

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dir = argv[0] ?? 'benchmarks/eval/out-final';
const suffix = argv[1] === 'deep' || argv[0]?.includes('deep') ? '-deep' : '';

/**
 * 加载 0 条记录时**报错退出**，不打印空表。
 *
 * 空表和「两臂都没有探索」在视觉上无法区分——本会话已经有两次分析器
 * 因为读不到数据而报出全零，被当成真实结果读了一轮。一个不能区分
 * 「没数据」和「数据是零」的工具，产出的每个零都不可信。
 */
function requireRecords(arms) {
  const total = arms.reduce((n, [, rows]) => n + rows.length, 0);
  if (total > 0) {
    const missing = arms.flatMap(([arm, rows]) => rows
      .filter(row => !Array.isArray(row.eventDetails?.explored))
      .map(row => `${arm}/${row.taskId}`));
    if (missing.length > 0) {
      console.error(`缺少 eventDetails.explored，无法重算探索指标：${missing.slice(0, 5).join(', ')}（共 ${missing.length} 条）`);
      process.exit(1);
    }
    return;
  }
  const names = arms.map(([a]) => join(dir, `${a}${suffix}.jsonl`)).join('\n  ');
  console.error(`未从以下路径读到任何记录：\n  ${names}\n`);
  console.error('注意参数是位置参数：analyze-exploration.mjs <outDir> [deep]');
  process.exit(1);
}

function load(arm) {
  const p = join(dir, `${arm}${suffix}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function bucket(record) {
  const targets = record.targetDirs ?? TARGETS.get(record.taskId);
  const out = { hit: 0, ghost: 0, offTarget: 0, glob: 0, miss: 0, unknown: 0 };
  for (const step of record.eventDetails?.explored ?? []) out[classifyExploration(step, targets)]++;
  return out;
}

// Legacy records may omit targetDirs; missing filesystem observations still remain unknown.
const TASKS = JSON.parse(readFileSync('benchmarks/eval/tasks-deep.json', 'utf8'));
const TARGETS = new Map(TASKS.map((t) => [t.id, t.targetDirs ?? []]));

const arms = { full: load('full'), 'no-filesense': load('no-filesense') };
requireRecords(Object.entries(arms));

console.log('# 探索质量重算\n');
console.log('| 臂 | 任务数 | 命中(目录对+操作成功) | 路径缺失 | 脱靶 | 搜索（含 glob / 文件筛选） | 失败或未读到内容 | 不可判定 |');
console.log('|---|---|---|---|---|---|---|---|');

for (const [arm, rows] of Object.entries(arms)) {
  if (rows.length === 0) continue;
  const t = { hit: 0, ghost: 0, offTarget: 0, glob: 0, miss: 0, unknown: 0 };
  for (const r of rows) {
    const b = bucket(r);
    for (const k of Object.keys(t)) t[k] += b[k];
  }
  console.log(
    `| ${arm} | ${rows.length} | ${t.hit} | **${t.ghost}** | ${t.offTarget} | ${t.glob} | ${t.miss} | ${t.unknown} |`,
  );
}

console.log('\n## 仅统计 full 臂真正触发了导航的任务\n');
console.log('> 未触发导航的任务上两臂**架构上完全等价**，把它们算进平均只会把差异摊平——');
console.log('> 第一轮的零差异就是这么来的。触发与否由 `decideFilesense` 的关键词正则决定（#425），');
console.log('> 所以这一层分组本身也是一个发现：能参与对照的任务比设计时以为的少。\n');

const navigated = new Set(
  (arms.full ?? []).filter((r) => r.events?.filesense_navigated).map((r) => r.taskId),
);
console.log(`触发导航的任务：${navigated.size} / ${(arms.full ?? []).length}\n`);
console.log('| 臂 | 任务数 | 命中 | 路径缺失 | 脱靶 | 搜索（含 glob / 文件筛选） | 失败或未读到内容 | 不可判定 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [arm, rows] of Object.entries(arms)) {
  const subset = rows.filter((r) => navigated.has(r.taskId));
  if (subset.length === 0) continue;
  const t = { hit: 0, ghost: 0, offTarget: 0, glob: 0, miss: 0, unknown: 0 };
  for (const r of subset) {
    const b = bucket(r);
    for (const k of Object.keys(t)) t[k] += b[k];
  }
  console.log(`| ${arm} | ${subset.length} | ${t.hit} | **${t.ghost}** | ${t.offTarget} | ${t.glob} | ${t.miss} | ${t.unknown} |`);
}

console.log('\n> 路径存在性取自事件发生时的记录；旧记录缺少这份证据时计为不可判定。');

console.log('## 逐任务明细\n');
for (const [arm, rows] of Object.entries(arms)) {
  for (const r of rows) {
    const b = bucket(r);
    if (b.ghost === 0 && b.offTarget === 0) continue;
    console.log(`- **[${arm}] ${r.taskId}** ${r.pass ? 'PASS' : 'FAIL'} — 命中 ${b.hit} / 幻觉 ${b.ghost} / 脱靶 ${b.offTarget}`);
    for (const s of r.eventDetails?.explored ?? []) {
      const category = classifyExploration(s, r.targetDirs ?? TARGETS.get(r.taskId));
      if (category === 'ghost') console.log(`  - 路径缺失：\`${s.path}\``);
      else if (category === 'offTarget') console.log(`  - 脱靶：\`${s.path}\``);
    }
  }
}
