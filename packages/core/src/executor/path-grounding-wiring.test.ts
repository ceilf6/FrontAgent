import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HallucinationGuard } from '@frontagent/hallucination-guard';
import type { AgentTask, ExecutionStep } from '@frontagent/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { updateFilesystemFactsFromToolResult } from '../context/filesystem-facts-update.js';
import type { AgentEvent, ProjectFacts } from '../types.js';
import { Executor } from './executor.js';
import type { ExecutorConfig } from './types.js';

/**
 * 接线测试：路径接地必须在**真实的 executeStep 链路**上生效。
 *
 * 上一版把接地放在 `validateBeforeExecution` 之后，而幻觉 `read_file` 会被
 * fileExistence 检查判成 "does not exist"、由 `getPreValidationSkip` 整步 skip 掉
 * 并提前返回——接地在它唯一该起作用的那类步骤上永远执行不到。
 *
 * 当时的单测只覆盖 `groundStepPath` 这个纯函数，「端到端」验证也是直接调它，
 * 绕开了 executeStep，所以恰好避开了这个最高风险的问题。纯函数测试证明不了接线。
 */

let root: string;
let facts: ProjectFacts;

function emptyFacts(): ProjectFacts {
  return {
    revision: 0,
    filesystem: {
      existingFiles: new Set(),
      existingDirectories: new Set(),
      nonExistentPaths: new Set(),
      directoryContents: new Map(),
    },
    dependencies: { installedPackages: new Set(), missingPackages: new Set() },
    project: { devServerRunning: false },
  } as unknown as ProjectFacts;
}

/** 用 navigate 的真实返回形状喂事实层，而不是手搓 directoryContents */
function feedNavigation(target: ProjectFacts, overrides: Record<string, unknown> = {}): void {
  updateFilesystemFactsFromToolResult(target, 'filesense_navigate', {}, {
    success: true,
    data: {
      scanned: { paths: ['src/features/checkout/lib'], depth: 2, entries: 3, truncated: false },
      factsDelta: {
        existingFiles: [
          'src/features/checkout/lib/computeTotal.ts',
          'src/features/checkout/lib/computeTotal.test.ts',
          'src/features/checkout/lib/format.ts',
        ],
        existingDirectories: ['src/features/checkout/lib'],
        filesTruncated: false,
        directoriesTruncated: false,
        ...overrides,
      },
    },
  } as never);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ground-wiring-'));
  mkdirSync(join(root, 'src/features/checkout/lib'), { recursive: true });
  for (const f of ['computeTotal.ts', 'computeTotal.test.ts', 'format.ts']) {
    writeFileSync(join(root, 'src/features/checkout/lib', f), 'export {}\n');
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeExecutor(events: AgentEvent[], callTool: ReturnType<typeof vi.fn>) {
  // 真的 guard，默认配置——fileExistence 开着，正是消融实验里的配置
  const guard = new HallucinationGuard({ projectRoot: root });
  const executor = new Executor({
    projectRoot: root,
    hallucinationGuard: guard as unknown as ExecutorConfig['hallucinationGuard'],
    llmService: { name: 't', generateText: vi.fn(), generateObject: vi.fn() } as never,
    getFileSystemFacts: () => facts.filesystem,
    emitEvent: (e: AgentEvent) => events.push(e),
  } as ExecutorConfig);

  executor.registerMCPClient('file', {
    callTool,
    listTools: vi.fn().mockResolvedValue([]),
  } as never);
  executor.registerToolMapping('read_file', 'file');
  return executor;
}

function readStep(path: string): ExecutionStep {
  return {
    stepId: 's1',
    description: 'read',
    action: 'read_file',
    tool: 'read_file',
    params: { path },
    dependencies: [],
    validation: [],
    status: 'pending',
    phase: 'preparation',
  };
}

const task = { id: 't1', type: 'modify', description: 'x' } as AgentTask;

describe('路径接地在 executeStep 链路上', () => {
  it('corrects a hallucinated read before the existence check can skip it', async () => {
    facts = emptyFacts();
    feedNavigation(facts);

    const events: AgentEvent[] = [];
    const callTool = vi.fn().mockResolvedValue({ success: true, content: 'export {}' });
    const executor = makeExecutor(events, callTool);

    const step = readStep('src/features/checkout/lib/calculateTotal.ts');
    const out = await executor.executeStep(step, { task, collectedContext: { files: new Map() } });

    // 工具真的被以校正后的路径调用了——这是纯函数测试证明不了的部分
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]?.[1]).toMatchObject({
      path: 'src/features/checkout/lib/computeTotal.ts',
    });
    expect(out.stepResult.success).toBe(true);

    const grounded = events.find((e) => e.type === 'filesense_path_grounded');
    expect(grounded).toMatchObject({
      outcome: 'corrected',
      to: 'src/features/checkout/lib/computeTotal.ts',
    });
  });

  // engine 对 factsDelta 是无条件 slice(0,200)，而该裁剪不置位 scanned.truncated。
  // 拿一份被悄悄截断的清单去否定真实存在的路径，会把能跑通的步骤改坏。
  it('never rewrites when the listing itself was truncated', async () => {
    facts = emptyFacts();
    feedNavigation(facts, { filesTruncated: true });

    expect(facts.filesystem.directoryContents.size).toBe(0);

    const events: AgentEvent[] = [];
    const callTool = vi.fn().mockResolvedValue({ success: true, content: '' });
    const executor = makeExecutor(events, callTool);

    const step = readStep('src/features/checkout/lib/computeTotal.ts');
    await executor.executeStep(step, { task, collectedContext: { files: new Map() } });

    expect(step.params.path).toBe('src/features/checkout/lib/computeTotal.ts');
    expect(events.some((e) => e.type === 'filesense_path_grounded')).toBe(false);
  });
});
