import type { ExecutionStep } from '@frontagent/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildOrderedPhaseGroups, detectLanguage, getPhasePriority } from './phase-ordering.js';

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    stepId: 'step-1',
    action: 'create_file',
    description: 'Create a file',
    phase: '实现',
    dependencies: [],
    validation: { type: 'exists', target: 'src/index.ts' },
    ...overrides,
  };
}

describe('getPhasePriority', () => {
  // 导航步骤用的就是这个 phase，它必须排在分析之前——产出要给后续读写的路径接地
  // 用，排在它们之后等于没接（issue #446）。断言的是「小于分析」而不是某个字面量，
  // 免得调优优先级数值时被迫改这条。
  it('runs preparation before every other phase', () => {
    // planner-skills.ts 写死的就是这个字面量；断言它而不是某种措辞
    expect(getPhasePriority('preparation')).toBe(5);
    expect(getPhasePriority('  PREPARATION  ')).toBe(5);
    for (const later of ['分析需求', '创建组件', '安装依赖', '验证结果', '未分组', '别的什么']) {
      expect(getPhasePriority('preparation')).toBeLessThan(getPhasePriority(later));
    }
  });

  // 其余分支用 includes 是为了容忍 LLM 的自由措辞；preparation 是我们自己写死的
  // 字面量，所以走全等。否则模型顺手写的「准备提交 / prepare release」会被提到
  // 全局第一位，而那类阶段通常该最后跑。
  it('does not hoist unrelated phases that merely mention preparing', () => {
    for (const unrelated of ['准备提交', 'prepare release', 'prepare deployment']) {
      expect(getPhasePriority(unrelated)).not.toBe(5);
    }
  });

  it('assigns lowest priority to analysis phases', () => {
    expect(getPhasePriority('分析需求')).toBe(10);
    expect(getPhasePriority('analyze requirements')).toBe(10);
  });

  it('assigns priority 20 to creation/implementation phases', () => {
    expect(getPhasePriority('创建组件')).toBe(20);
    expect(getPhasePriority('implement feature')).toBe(20);
  });

  it('assigns priority 30 to install phases', () => {
    expect(getPhasePriority('安装依赖')).toBe(30);
    expect(getPhasePriority('install packages')).toBe(30);
  });

  it('assigns priority 40 to validation phases', () => {
    expect(getPhasePriority('验证结果')).toBe(40);
    expect(getPhasePriority('validate output')).toBe(40);
    expect(getPhasePriority('验收测试')).toBe(40);
    expect(getPhasePriority('acceptance test')).toBe(40);
  });

  it('assigns priority 50 to start/serve phases', () => {
    expect(getPhasePriority('启动服务')).toBe(50);
    expect(getPhasePriority('start server')).toBe(50);
  });

  it('assigns priority 60 to browser phases', () => {
    expect(getPhasePriority('浏览器测试')).toBe(60);
    expect(getPhasePriority('browser test')).toBe(60);
  });

  it('assigns priority 70 to repository phases', () => {
    expect(getPhasePriority('仓库操作')).toBe(70);
    expect(getPhasePriority('repository setup')).toBe(70);
  });

  it('assigns priority 90 to ungrouped phases', () => {
    expect(getPhasePriority('未分组')).toBe(90);
    expect(getPhasePriority('ungrouped')).toBe(90);
  });

  it('assigns default priority 80 to unknown phases', () => {
    expect(getPhasePriority('something else')).toBe(80);
    expect(getPhasePriority('')).toBe(80);
  });

  it('is case-insensitive', () => {
    expect(getPhasePriority('ANALYZE')).toBe(10);
    expect(getPhasePriority('Install')).toBe(30);
  });
});

describe('detectLanguage', () => {
  it('detects TypeScript files', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('App.tsx')).toBe('typescript');
  });

  it('detects JavaScript files', () => {
    expect(detectLanguage('index.js')).toBe('javascript');
    expect(detectLanguage('App.jsx')).toBe('javascript');
    expect(detectLanguage('config.mjs')).toBe('javascript');
    expect(detectLanguage('config.cjs')).toBe('javascript');
  });

  it('detects JSON files', () => {
    expect(detectLanguage('package.json')).toBe('json');
  });

  it('detects YAML files', () => {
    expect(detectLanguage('config.yaml')).toBe('yaml');
    expect(detectLanguage('config.yml')).toBe('yaml');
  });

  it('returns null for unknown extensions', () => {
    expect(detectLanguage('readme.md')).toBeNull();
    expect(detectLanguage('style.css')).toBeNull();
    expect(detectLanguage('image.png')).toBeNull();
  });
});

describe('buildOrderedPhaseGroups', () => {
  it('groups steps by phase', () => {
    const steps = [
      makeStep({ stepId: 's1', phase: '分析' }),
      makeStep({ stepId: 's2', phase: '实现' }),
      makeStep({ stepId: 's3', phase: '分析' }),
    ];

    const groups = buildOrderedPhaseGroups(steps);
    expect(groups).toHaveLength(2);
    const analysisGroup = groups.find((g) => g.phase === '分析');
    expect(analysisGroup?.steps).toHaveLength(2);
  });

  // getPhasePriority 单测只钉数值；这条钉的是真实后果——planner 把导航步骤前插进
  // 数组，但执行按 phase 分组排序，所以「数组第一」不等于「先执行」。此前
  // preparation 落到兜底的 80，导航实际在倒数第二个跑（issue #446）。
  it('executes the navigation step before the steps it is meant to inform', () => {
    const steps = [
      makeStep({ stepId: 'navigate', phase: 'preparation', action: 'filesense_navigate' }),
      makeStep({ stepId: 'read', phase: '分析' }),
      makeStep({ stepId: 'write', phase: '创建' }),
      makeStep({ stepId: 'verify', phase: '验证' }),
    ];

    const order = buildOrderedPhaseGroups(steps).flatMap((group) =>
      group.steps.map((step) => step.stepId),
    );

    expect(order[0]).toBe('navigate');
    expect(order).toEqual(['navigate', 'read', 'write', 'verify']);
  });

  it('orders groups by priority', () => {
    const steps = [
      makeStep({ stepId: 's1', phase: '验证' }),
      makeStep({ stepId: 's2', phase: '分析' }),
      makeStep({ stepId: 's3', phase: '实现' }),
    ];

    const groups = buildOrderedPhaseGroups(steps);
    expect(groups[0].phase).toBe('分析');
    expect(groups[1].phase).toBe('实现');
    expect(groups[2].phase).toBe('验证');
  });

  it('uses default phase for steps without phase', () => {
    const steps = [makeStep({ stepId: 's1', phase: undefined })];

    const groups = buildOrderedPhaseGroups(steps);
    expect(groups[0].phase).toBe('未分组');
  });

  it('respects step dependencies across phases', () => {
    const steps = [
      makeStep({ stepId: 's1', phase: 'B-implement', dependencies: ['s2'] }),
      makeStep({ stepId: 's2', phase: 'A-analyze', dependencies: [] }),
    ];

    const groups = buildOrderedPhaseGroups(steps);
    const phases = groups.map((g) => g.phase);
    expect(phases.indexOf('A-analyze')).toBeLessThan(phases.indexOf('B-implement'));
  });

  it('handles circular dependencies gracefully', () => {
    const debugWarn = vi.fn();
    const steps = [
      makeStep({ stepId: 's1', phase: 'A', dependencies: ['s2'] }),
      makeStep({ stepId: 's2', phase: 'B', dependencies: ['s1'] }),
    ];

    const groups = buildOrderedPhaseGroups(steps, debugWarn);
    expect(groups).toHaveLength(2);
    expect(debugWarn).toHaveBeenCalledWith(expect.stringContaining('cycle'));
  });

  it('returns empty array for empty steps', () => {
    expect(buildOrderedPhaseGroups([])).toEqual([]);
  });

  it('preserves firstSeenIndex for stable ordering', () => {
    const steps = [
      makeStep({ stepId: 's1', phase: 'same-priority-a' }),
      makeStep({ stepId: 's2', phase: 'same-priority-b' }),
    ];

    const groups = buildOrderedPhaseGroups(steps);
    expect(groups[0].firstSeenIndex).toBe(0);
    expect(groups[1].firstSeenIndex).toBe(1);
  });
});
