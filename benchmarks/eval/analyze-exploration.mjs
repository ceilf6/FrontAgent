#!/usr/bin/env node
/**
 * 按三桶口径重算探索质量，覆盖 run-eval 里 `offTargetExplored` 的二分口径。
 *
 * 用法：node benchmarks/eval/analyze-exploration.mjs <outDir> [deep]
 *
 * 为什么需要它：`offTargetExplored` 只判目录前缀，于是「目录对但文件根本不存在」
 * 被记成命中——而那正是导航该防的幻觉（模型猜 `src/app/router.ts`，
 * 真实文件是 `src/app/routes/routeTable.ts`）。盲区方向是**低估导航价值、
 * 把对照偏向零差异**（issue #429）。
 *
 * 这个重算不需要重跑：`eventDetails.explored` 存了完整轨迹，工作区还在。
 * 这正是当初坚持「存载荷而不只存计数」的价值——**口径错了可以事后重算，
 * 计数错了只能重跑。**
 *
 * 存在性判定依赖 /tmp 下的任务工作区。工作区已被清理时该条计入 `unknown`
 * 而不是静默算作命中——宁可标注不可判定，也不要给出一个偏向某一方的数。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  if (total > 0) return;
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

function bucket(record, arm) {
  const ws = join('/tmp/frontagent-eval', arm, record.taskId);
  const wsAvailable = existsSync(ws);
  const targets = record.targetDirs ?? TARGETS.get(record.taskId) ?? [];
  const out = { hit: 0, ghost: 0, offTarget: 0, glob: 0, unknown: 0 };

  for (const step of record.eventDetails?.explored ?? []) {
    const path = step.path;
    if (path.includes('*')) {
      out.glob += 1;
      continue;
    }
    const onTarget = targets.some((d) => path.startsWith(d));

    // 文件系统探测是**唯一**权威判据，`ok` 只能加不能减。
    //
    // 曾经反过来写过：先信 `step.ok`，读不存在的文件应当发 step_failed。
    // 实测 36/36 个探索步骤全是 ok=true，其中三条指向根本不存在的路径
    // （`src/features/billing/lib/formatAmount.ts`、`src/app/routes.ts`、
    // 以及一条模板占位符没替换的 `src/features/{selectedFeatureName}/index.ts`）。
    // 读文件失败不会让步骤失败——工具照常返回，错误在返回内容里。
    //
    // 于是那版实现用一个恒真的信号短路掉了本来能工作的探测，把主指标
    // 打成恒零。零和「没测出来」在表里长得一模一样，这是本次评测最危险
    // 的一种错误：它不会报错，只会让人得出反向结论。
    if (wsAvailable) {
      if (!existsSync(join(ws, path))) out.ghost += 1;
      else if (onTarget) out.hit += 1;
      else out.offTarget += 1;
      continue;
    }

    // 工作区已清理时才退回 `ok`，且只认它报告的失败——ok=true 不能证明
    // 文件存在（上面刚证明的），所以此时只能记为不可判定。
    if (step.ok === false) out.ghost += 1;
    else out.unknown += 1;
  }
  return out;
}

// targetDirs 目前不在记录里（harness 从任务文件读，但没落盘），
// 所以这里也从任务文件读。记录自包含才是对的——已在 issue #429 里一并提出。
const TASKS = JSON.parse(readFileSync('benchmarks/eval/tasks-deep.json', 'utf8'));
const TARGETS = new Map(TASKS.map((t) => [t.id, t.targetDirs ?? []]));

const arms = { full: load('full'), 'no-filesense': load('no-filesense') };
requireRecords(Object.entries(arms));

console.log('# 探索质量三桶重算\n');
console.log('| 臂 | 任务数 | 命中(目录对+文件在) | 幻觉文件名 | 脱靶(文件在+目录错) | glob | 不可判定 |');
console.log('|---|---|---|---|---|---|---|');

for (const [arm, rows] of Object.entries(arms)) {
  if (rows.length === 0) continue;
  const t = { hit: 0, ghost: 0, offTarget: 0, glob: 0, unknown: 0 };
  for (const r of rows) {
    const b = bucket(r, arm);
    for (const k of Object.keys(t)) t[k] += b[k];
  }
  console.log(
    `| ${arm} | ${rows.length} | ${t.hit} | **${t.ghost}** | ${t.offTarget} | ${t.glob} | ${t.unknown} |`,
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
console.log('| 臂 | 任务数 | 命中 | 幻觉文件名 | 脱靶 | glob |');
console.log('|---|---|---|---|---|---|');
for (const [arm, rows] of Object.entries(arms)) {
  const subset = rows.filter((r) => navigated.has(r.taskId));
  if (subset.length === 0) continue;
  const t = { hit: 0, ghost: 0, offTarget: 0, glob: 0, unknown: 0 };
  for (const r of subset) {
    const b = bucket(r, arm);
    for (const k of Object.keys(t)) t[k] += b[k];
  }
  console.log(`| ${arm} | ${subset.length} | ${t.hit} | **${t.ghost}** | ${t.offTarget} | ${t.glob} |`);
}

console.log('\n> `幻觉文件名` 一列在 run-eval 的 `offTargetExplored` 里被误记为命中（#429）。');
console.log('> 该盲区低估导航价值，方向是把两臂对照偏向零差异。\n');

console.log('## 逐任务明细\n');
for (const [arm, rows] of Object.entries(arms)) {
  for (const r of rows) {
    const b = bucket(r, arm);
    if (b.ghost === 0 && b.offTarget === 0) continue;
    console.log(`- **[${arm}] ${r.taskId}** ${r.pass ? 'PASS' : 'FAIL'} — 命中 ${b.hit} / 幻觉 ${b.ghost} / 脱靶 ${b.offTarget}`);
    for (const s of r.eventDetails?.explored ?? []) {
      if (s.path.includes('*')) continue;
      const ws = join('/tmp/frontagent-eval', arm, r.taskId);
      if (!existsSync(ws)) continue;
      const exists = existsSync(join(ws, s.path));
      const onTarget = (r.targetDirs ?? TARGETS.get(r.taskId) ?? []).some((d) => s.path.startsWith(d));
      if (!exists) console.log(`  - 幻觉文件名：\`${s.path}\``);
      else if (!onTarget) console.log(`  - 脱靶：\`${s.path}\``);
    }
  }
}
