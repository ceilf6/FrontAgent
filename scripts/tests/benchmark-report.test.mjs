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
          'validation_failed:pre_write': 2,
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
          'validation_failed:pre_write': 5,
          'validation_failed:post_write': 6,
        }),
      )}\n`,
      'utf8',
    );

    const report = execFileSync(process.execPath, ['benchmarks/eval/report.mjs', dir], {
      encoding: 'utf8',
    });

    assert.match(report, /`pre_execution`（执行前结构性拦截） \| 1 \| 4 \|/);
    assert.match(report, /`pre_write`（写盘前内容拦截） \| 2 \| 5 \|/);
    assert.match(report, /`post_write`（已落盘后判失败） \| 3 \| 6 \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
