import type { AgentTask, ExecutionStep } from '@frontagent/shared';
import { logger } from '@frontagent/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesenseConfig } from '../types.js';
import { createDefaultPlannerSkillRegistry } from './planner-skills.js';
import type { PlannerStepFactory } from './types.js';

let stepSeq = 0;
const stepFactory: PlannerStepFactory = {
  createStep: (options) => ({
    stepId: `step-${++stepSeq}`,
    description: options.description,
    action: options.action,
    tool: options.tool,
    params: options.params,
    dependencies: options.dependencies ?? [],
    validation: options.validation ?? [],
    status: 'pending',
    phase: options.phase,
  }),
};

function buildRegistry() {
  const noSteps = (): ExecutionStep[] => [];
  return createDefaultPlannerSkillRegistry({
    generateCreateSteps: noSteps,
    generateModifySteps: noSteps,
    generateQuerySteps: noSteps,
    generateDebugSteps: noSteps,
    generateRefactorSteps: noSteps,
    generateTestSteps: noSteps,
    injectRepositoryManagementPhase: (_task, steps) => steps,
  });
}

// create 任务的 filesense 触发是无条件的（trigger-policy 的 prepare_create 分支），
// 且必须带一个会真正落到工具上的 write 步骤，否则 decideFilesense 会短路。
const createTask: AgentTask = {
  id: 'task-1',
  description: 'add a Card component',
  type: 'create',
  status: 'pending',
} as AgentTask;

const writeSteps: ExecutionStep[] = [
  {
    stepId: 'w1',
    description: 'create Card',
    action: 'create_file',
    tool: 'create_file',
    params: { path: 'src/components/Card.tsx' },
    dependencies: [],
    validation: [],
    status: 'pending',
  },
  {
    stepId: 'w2',
    description: 'create Card styles',
    action: 'create_file',
    tool: 'create_file',
    params: { path: 'src/components/Card.css' },
    dependencies: [],
    validation: [],
    status: 'pending',
  },
];

function navigateStepOf(filesense?: FilesenseConfig): ExecutionStep | undefined {
  const steps = buildRegistry().injectPhaseSteps(createTask, writeSteps, stepFactory, filesense);
  return steps.find((step) => step.tool === 'filesense_navigate');
}

describe('phase.filesense-navigate writeMode boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through cache by default', () => {
    expect(navigateStepOf()?.params.writeMode).toBe('cache');
    expect(navigateStepOf({ writeMode: 'none' })?.params.writeMode).toBe('none');
  });

  // engine 硬拒绝 workspace，而 navigate 的工具错误在 executor 里是非致命静默跳过。
  // 若原样透传，配置了 workspace 的用户会丢掉整个导航阶段且没有任何可见信号。
  it('downgrades the documented workspace value instead of losing the navigation step', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const step = navigateStepOf({ writeMode: 'workspace' });

    expect(step).toBeDefined();
    expect(step?.params.writeMode).toBe('none');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('filesense_sync');
  });

  it('warns once per registry rather than once per planned step', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const registry = buildRegistry();

    for (let i = 0; i < 3; i++) {
      registry.injectPhaseSteps(createTask, writeSteps, stepFactory, { writeMode: 'workspace' });
    }

    // 必须是恰好 1：`<= 1` 在 0 次告警时也通过，钉不住语义；
    // 而且若降级标志退化成模块级全局变量，下面这条新 registry 的断言会失败。
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    buildRegistry().injectPhaseSteps(createTask, writeSteps, stepFactory, {
      writeMode: 'workspace',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('injects no navigate step at all when filesense is disabled', () => {
    expect(navigateStepOf({ enabled: false })).toBeUndefined();
  });
});
