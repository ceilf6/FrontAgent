import type { ExecutionStep } from '@frontagent/shared';
import type { PhaseExecutionGroup } from './types.js';

export function getPhasePriority(phase: string): number {
  const normalized = phase.toLowerCase();

  // 必须排在分析(10)之前。filesense 的导航步骤用的就是这个 phase，它的产出
  // （真实目录清单）要给后续每一次读取和写入的路径接地用——排在它们之后就等于
  // 没接。此前这里没有分支，`preparation` 落到兜底的 80，于是导航实际在倒数第二
  // 个才跑：分析(10)、创建(20)、安装(30)、验证(40)、启动(50)、浏览器(60)、
  // 仓库(70) 全跑完之后。planner 把它前插进数组（planner-skills.ts）看上去在最
  // 前面，但执行不按数组顺序，而是按 phase 分组再按本函数排序（issue #446）。
  //
  // 这里用**全等**而不是像下面各分支那样用 includes：其余 phase 名出自 LLM 自由
  // 书写的计划，用子串匹配是为了容忍措辞；而 `preparation` 是我们自己在
  // planner-skills.ts 里写死的字面量，不需要容忍。用 `includes('prepar')` 会把
  // 模型顺手写出的「准备提交 / prepare release」也提到全局第一位——那类阶段通常
  // 该在最后跑，提前反而把顺序弄得更糟。
  if (normalized.trim() === 'preparation') return 5;
  if (normalized.includes('分析') || normalized.includes('analy')) return 10;
  if (
    normalized.includes('创建') ||
    normalized.includes('实现') ||
    normalized.includes('create') ||
    normalized.includes('implement')
  )
    return 20;
  if (normalized.includes('安装') || normalized.includes('install')) return 30;
  if (
    normalized.includes('验证') ||
    normalized.includes('验收') ||
    normalized.includes('valid') ||
    normalized.includes('accept')
  )
    return 40;
  if (normalized.includes('启动') || normalized.includes('start') || normalized.includes('serve'))
    return 50;
  if (normalized.includes('浏览器') || normalized.includes('browser')) return 60;
  if (
    normalized.includes('仓库') ||
    normalized.includes('repo') ||
    normalized.includes('repository')
  )
    return 70;
  if (normalized.includes('未分组') || normalized.includes('ungroup')) return 90;

  return 80;
}

function comparePhaseGroup(a: PhaseExecutionGroup, b: PhaseExecutionGroup): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  if (a.firstSeenIndex !== b.firstSeenIndex) {
    return a.firstSeenIndex - b.firstSeenIndex;
  }
  return a.phase.localeCompare(b.phase);
}

function topologicalSortPhaseGroups(
  groups: PhaseExecutionGroup[],
  debugWarn?: (...args: unknown[]) => void,
): PhaseExecutionGroup[] {
  if (groups.length <= 1) {
    return groups;
  }

  const groupMap = new Map(groups.map((group) => [group.phase, group]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();

  for (const group of groups) {
    indegree.set(group.phase, 0);
    outgoing.set(group.phase, new Set<string>());
  }

  for (const group of groups) {
    for (const dep of group.dependencies) {
      if (!groupMap.has(dep)) continue;
      indegree.set(group.phase, (indegree.get(group.phase) ?? 0) + 1);
      outgoing.get(dep)!.add(group.phase);
    }
  }

  const ready = groups.filter((group) => (indegree.get(group.phase) ?? 0) === 0);
  ready.sort((a, b) => comparePhaseGroup(a, b));

  const ordered: PhaseExecutionGroup[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);

    for (const nextPhase of outgoing.get(current.phase) ?? []) {
      const nextDegree = (indegree.get(nextPhase) ?? 0) - 1;
      indegree.set(nextPhase, nextDegree);

      if (nextDegree === 0) {
        const nextGroup = groupMap.get(nextPhase);
        if (nextGroup) {
          ready.push(nextGroup);
        }
      }
    }

    ready.sort((a, b) => comparePhaseGroup(a, b));
  }

  if (ordered.length !== groups.length) {
    debugWarn?.('[Executor] Detected phase dependency cycle, fallback to priority ordering');
    return [...groups].sort((a, b) => comparePhaseGroup(a, b));
  }

  return ordered;
}

export function buildOrderedPhaseGroups(
  steps: ExecutionStep[],
  debugWarn?: (...args: unknown[]) => void,
): PhaseExecutionGroup[] {
  const phaseGroups = new Map<string, PhaseExecutionGroup>();
  const stepToPhase = new Map<string, string>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const phase = step.phase || '未分组';
    stepToPhase.set(step.stepId, phase);

    if (!phaseGroups.has(phase)) {
      phaseGroups.set(phase, {
        phase,
        steps: [],
        dependencies: new Set<string>(),
        firstSeenIndex: i,
        priority: getPhasePriority(phase),
      });
    }

    phaseGroups.get(phase)!.steps.push(step);
  }

  for (const step of steps) {
    const phase = step.phase || '未分组';
    const group = phaseGroups.get(phase);
    if (!group) continue;

    for (const dep of step.dependencies) {
      const depPhase = stepToPhase.get(dep);
      if (!depPhase || depPhase === phase) continue;
      group.dependencies.add(depPhase);
    }
  }

  return topologicalSortPhaseGroups(Array.from(phaseGroups.values()), debugWarn);
}

export function detectLanguage(path: string): 'typescript' | 'javascript' | 'json' | 'yaml' | null {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return null;
  }
}
