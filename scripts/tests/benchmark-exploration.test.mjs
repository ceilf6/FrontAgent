import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyExploration,
  observeExploration,
  summarizeExploration,
} from '../../benchmarks/eval/exploration.mjs';

function withWorkspace(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fa-exploration-'));
  mkdirSync(join(root, 'src/app'), { recursive: true });
  writeFileSync(join(root, 'src/app/real.ts'), '');
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function event(path, output = { success: true, content: '' }) {
  return {
    type: 'step_completed',
    step: { action: 'read_file', params: { path } },
    result: { success: true, output },
  };
}

test('a completed skipped read records a missing file rather than a hit', () =>
  withWorkspace((root) => {
    const step = observeExploration(event('src/app/ghost.ts', { skipped: true }), root);
    assert.equal(step.ok, true);
    assert.equal(step.exists, false);
    assert.equal(classifyExploration(step, ['src/app']), 'ghost');
    assert.equal(summarizeExploration([step], ['src/app']).exploredHit, 0);
  }));

test('captured existence survives file creation and workspace deletion', () =>
  withWorkspace((root) => {
    const missing = observeExploration(event('src/app/ghost.ts'), root);
    const found = observeExploration(event('src/app/real.ts'), root);
    writeFileSync(join(root, 'src/app/ghost.ts'), 'now present');
    rmSync(root, { recursive: true, force: true });
    assert.equal(classifyExploration(missing, ['src/app']), 'ghost');
    assert.equal(classifyExploration(found, ['src/app']), 'hit');
  }));

test('unavailable workspace and old telemetry remain unknown', () =>
  withWorkspace((root) => {
    rmSync(root, { recursive: true, force: true });
    assert.equal(observeExploration(event('src/app/real.ts'), root).exists, null);
    assert.equal(
      classifyExploration({ path: 'src/app/real.ts', ok: true }, ['src/app']),
      'unknown',
    );
    assert.equal(
      classifyExploration({ path: 'src/app/real.ts', ok: false }, ['src/app']),
      'unknown',
    );
    assert.equal(summarizeExploration(undefined, ['src/app']).exploredGhost, null);
  }));

test('empty-file content is a read hit, while errors and missing content are misses', () =>
  withWorkspace((root) => {
    assert.equal(
      classifyExploration(observeExploration(event('src/app/real.ts'), root), ['src/app']),
      'hit',
    );
    for (const output of [
      { success: false, error: 'denied' },
      { skipped: true },
      { success: true },
    ]) {
      assert.equal(
        classifyExploration(observeExploration(event('src/app/real.ts', output), root), [
          'src/app',
        ]),
        'miss',
      );
    }
  }));

test('target matching respects directory segments and absolute request paths', () =>
  withWorkspace((root) => {
    const step = observeExploration(event(join(root, 'src/app/real.ts')), root);
    assert.equal(step.path, 'src/app/real.ts');
    assert.equal(classifyExploration(step, ['src/ap']), 'offTarget');
    assert.equal(classifyExploration(step, ['./src/app/']), 'hit');
    assert.equal(classifyExploration(step, undefined), 'unknown');
  }));

test('search patterns are separate from literal read paths with placeholders', () =>
  withWorkspace((root) => {
    const search = {
      type: 'step_completed',
      step: { action: 'search_code', params: { filePattern: '**/*.ts' } },
      result: { success: true },
    };
    assert.equal(classifyExploration(observeExploration(search, root), ['src/app']), 'glob');
    assert.equal(
      classifyExploration(
        observeExploration(event('src/features/{selectedFeatureName}/index.ts'), root),
        ['src'],
      ),
      'ghost',
    );
  }));

test('search_code is a file-pattern search with default or literal filePattern', () =>
  withWorkspace((root) => {
    for (const params of [
      { query: 'token' },
      { directory: 'src/app', query: 'token' },
      { directory: 'src/app', filePattern: 'real.ts', query: 'token' },
    ]) {
      const search = {
        type: 'step_completed',
        step: { action: 'search_code', params },
        result: { success: true, output: { success: true, matches: [] } },
      };
      assert.equal(classifyExploration(observeExploration(search, root), ['src/app']), 'glob');
    }
  }));
