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

const dir = process.argv[2] ?? 'benchmarks/eval/out-final';
const suffix = process.argv[3] === 'deep' ? '-deep' : '';

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
    if (!wsAvailable) {
      out.unknown += 1;
      continue;
    }
    const exists = existsSync(join(ws, path));
    if (!exists) out.ghost += 1;
    else if (onTarget) out.hit += 1;
    else out.offTarget += 1;
  }
  return out;
}

// targetDirs 目前不在记录里（harness 从任务文件读，但没落盘），
// 所以这里也从任务文件读。记录自包含才是对的——已在 issue #429 里一并提出。
const TASKS = JSON.parse(readFileSync('benchmarks/eval/tasks-deep.json', 'utf8'));
const TARGETS = new Map(TASKS.map((t) => [t.id, t.targetDirs ?? []]));

const arms = { full: load('full'), 'no-filesense': load('no-filesense') };

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
