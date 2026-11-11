import type { AgentTask, ExecutionStep } from '@frontagent/shared';
import { describe, expect, it } from 'vitest';
import { decideFilesense } from './trigger-policy.js';

function task(description: string, type: AgentTask['type'] = 'query'): AgentTask {
  return {
    id: 'task-1',
    description,
    type,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    context: {},
  } as AgentTask;
}

function step(
  action: ExecutionStep['action'],
  params: Record<string, unknown> = {},
): ExecutionStep {
  return {
    stepId: `step-${action}`,
    description: action,
    action,
    tool: action,
    params,
    dependencies: [],
    validation: [],
    status: 'pending',
  };
}

describe('decideFilesense', () => {
  it('skips known single-file tasks', () => {
    const decision = decideFilesense(task('modify this file', 'modify'), [
      step('read_file', { path: 'src/App.tsx' }),
    ]);
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('single-file');
  });

  it('injects lightweight navigation for repository structure queries', () => {
    const decision = decideFilesense(task('梳理 src 目录结构'), [
      step('list_directory', { path: '.' }),
    ]);
    expect(decision.enabled).toBe(true);
    expect(decision.intent).toBe('understand_structure');
    expect(decision.paths).toEqual(['.']);
    expect(decision.maxEntries).toBeLessThanOrEqual(250);
  });

  it('uses a narrow freshness budget for stale path checks', () => {
    const decision = decideFilesense(task('找不到 components 里的最新入口在哪'), [
      step('search_code', { path: '.' }),
    ]);
    expect(decision.enabled).toBe(true);
    expect(decision.intent).toBe('validate_freshness');
    expect(decision.paths).toEqual(['.']);
    expect(decision.depth).toBe(1);
    expect(decision.timeoutMs).toBeLessThanOrEqual(1500);
  });
});

it.each([
  '这个代码库按什么原则分层？说明各层之间允许的依赖方向，以及一个业务域内部是怎么组织的。',
  'How is this codebase organised?',
  'Explain the responsibilities here.',
])('uses discovery steps for query navigation: %s', (description) => {
  const decision = decideFilesense(task(description), [
    step('list_directory', { path: 'src' }),
    step('search_code', { directory: 'src' }),
  ]);
  expect(decision.enabled).toBe(true);
  expect(decision.intent).toBe('understand_structure');
  expect(decision.paths).toEqual(['src']);
});

it('navigates modify plans that need discovery without matching task vocabulary', () => {
  const decision = decideFilesense(task('修复合并逻辑', 'modify'), [
    step('search_code', { directory: 'src/features/cart' }),
    step('apply_patch', { path: 'src/features/cart/lib/merge.ts' }),
  ]);
  expect(decision.enabled).toBe(true);
  expect(decision.paths).toContain('src/features/cart');
});

it('keeps prose names and invented combinations out of scan roots', () => {
  const decision = decideFilesense(
    task('add hooks components api services pages routes', 'create'),
    [
      step('list_directory', { path: 'src/features/checkout' }),
      step('create_file', { path: 'src/features/checkout/hooks/useTotal.ts' }),
    ],
  );
  expect(decision.paths).toEqual(['src/features/checkout', 'src/features/checkout/hooks']);
});

it('takes search roots from directory, not file patterns or prose', () => {
  const decision = decideFilesense(task('检查最新结果'), [
    step('search_code', { directory: 'src/features/cart', filePattern: '**/*.ts' }),
  ]);
  expect(decision.paths).toEqual(['src/features/cart']);
});

it.each(['explain this architecture', '解释这个文件的结构'])(
  'skips a known single-file query with structure vocabulary: %s',
  (description) => {
    const decision = decideFilesense(task(description), [
      step('read_file', { path: 'src/App.tsx' }),
    ]);
    expect(decision.enabled).toBe(false);
  },
);

it.each([
  step('search_code', { directory: 'src/features/cart.v2' }),
  step('list_directory', { path: 'src/features/cart.v2' }),
])('preserves the explicit directory of $action', (discoveryStep) => {
  const decision = decideFilesense(task('Explain responsibilities here'), [discoveryStep]);
  expect(decision.paths).toEqual(['src/features/cart.v2']);
});

it.each(['read_file', 'apply_patch', 'create_file'] as const)(
  'uses the parent of an extensionless %s target without changing a dotted directory',
  (action) => {
    const decision = decideFilesense(task('Explain responsibilities here'), [
      step('list_directory', { path: 'src/features/cart.v2' }),
      step(action, { path: 'src/features/cart.v2/README' }),
    ]);
    expect(decision.paths).toEqual(['src/features/cart.v2']);
  },
);

it.each([
  step('search_code', { directory: 'src/features/cart' }),
  step('list_directory', { path: 'src/features/cart' }),
])('keeps the multi-file modification budget with $action discovery', (discoveryStep) => {
  const decision = decideFilesense(task('repair merge logic', 'modify'), [
    discoveryStep,
    step('apply_patch', { path: 'src/features/cart/merge.ts' }),
    step('apply_patch', { path: 'src/features/cart/merge.test.ts' }),
  ]);
  expect(decision).toMatchObject({
    enabled: true,
    intent: 'prepare_refactor',
    depth: 2,
    maxEntries: 500,
    maxBytes: 160 * 1024,
    timeoutMs: 3000,
  });
});

it.each([
  {
    type: 'create' as const,
    intent: 'prepare_create',
    depth: 1,
    maxEntries: 180,
    maxBytes: 64 * 1024,
  },
  {
    type: 'refactor' as const,
    intent: 'prepare_refactor',
    depth: 2,
    maxEntries: 500,
    maxBytes: 160 * 1024,
  },
])('preserves the $type intent when discovery is needed', (expected) => {
  const decision = decideFilesense(task('Implement the total calculation', expected.type), [
    step('search_code', { directory: 'src' }),
    step('read_file', { path: 'src/App.tsx' }),
  ]);
  const { type: _type, ...budget } = expected;
  expect(decision).toMatchObject({ enabled: true, ...budget, timeoutMs: 3000 });
});
