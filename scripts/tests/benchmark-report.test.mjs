import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function makeRow(events) {
  return {
    taskId: 'task-1',
    category: 'syntax',
    pass: true,
    llmCalls: 1,
    outputTokens: 10,
    elapsedMs: 100,
    events,
    checks: [],
  };
}

test('benchmark report renders validation failures for every write stage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontagent-report-'));
  try {
    writeFileSync(
      join(dir, 'ablation.jsonl'),
      `${JSON.stringify(
        makeRow({
          'validation_failed:pre_execution': 1,
          'validation_failed:pre_write': 3,
          'validation_failed:pre_write:syntax_validity': 2,
          'validation_failed:pre_write:patch_projection': 1,
          'validation_failed:post_write': 3,
        }),
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'full.jsonl'),
      `${JSON.stringify(
        makeRow({
          'validation_failed:pre_execution': 4,
          'validation_failed:pre_write': 7,
          'validation_failed:pre_write:syntax_validity': 5,
          'validation_failed:pre_write:write_preflight_input': 1,
          'validation_failed:pre_write:stale_patch_context': 1,
          'validation_failed:post_write': 6,
        }),
      )}\n`,
      'utf8',
    );

    const report = execFileSync(process.execPath, ['benchmarks/eval/report.mjs', dir], {
      encoding: 'utf8',
    });

    assert.match(report, /`pre_execution`（执行前结构性拦截） \| 1 \| 4 \|/);
    assert.match(report, /`pre_write:syntax_validity`（写盘前解析器拦截） \| 2 \| 5 \|/);
    assert.match(report, /`pre_write:other`（其他写盘前拒绝） \| 1 \| 2 \|/);
    assert.match(report, /`post_write`（已落盘后判失败） \| 3 \| 6 \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('filesense reports replay stored existence instead of trusting stale aggregate counters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontagent-exploration-report-'));
  try {
    for (const arm of ['full', 'no-filesense']) {
      const row = {
        ...makeRow(arm === 'full' ? { filesense_navigated: 1 } : {}),
        fixture: 'deep',
        taskSet: 'tasks-deep.json',
        targetDirs: ['src/app'],
        filesenseConfigRequested: { enabled: arm === 'full' },
        eventDetails: {
          explored: [
            { action: 'read_file', path: 'src/app/ghost.ts', exists: false, ok: true },
            { action: 'read_file', path: 'src/app/old.ts', ok: true },
            {
              action: 'read_file',
              path: 'src/apple/real.ts',
              exists: true,
              ok: true,
              resultSuccess: true,
              contentLength: 0,
            },
          ],
        },
        exploredHit: 99,
        exploredGhost: 0,
        offTargetExplored: 0,
      };
      writeFileSync(join(dir, `${arm}-deep.jsonl`), `${JSON.stringify(row)}\n`);
    }
    const report = execFileSync(
      process.execPath,
      ['benchmarks/eval/report-filesense.mjs', dir, 'deep'],
      { encoding: 'utf8' },
    );
    assert.match(report, /命中目标目录且操作成功 \| 0 \| 0 \|/);
    assert.match(report, /路径缺失 \| 1 \| 1 \|/);
    assert.match(report, /脱靶探索 \| 1 \| 1 \|/);
    assert.match(report, /不可判定 \| 1 \| 1 \|/);
    const analysis = execFileSync(
      process.execPath,
      ['benchmarks/eval/analyze-exploration.mjs', dir, 'deep'],
      { encoding: 'utf8' },
    );
    assert.match(analysis, /\| full \| 1 \| 0 \| \*\*1\*\* \| 1 \| 0 \| 0 \| 1 \|/);
    assert.match(analysis, /路径缺失：`src\/app\/ghost.ts`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
