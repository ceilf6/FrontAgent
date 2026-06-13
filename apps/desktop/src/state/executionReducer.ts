/**
 * Pure, framework-agnostic reducer that folds the agent's `AgentEvent` stream
 * into a renderable console state. Kept free of React/Electron so it can be
 * unit-tested in isolation and reused by any renderer.
 *
 * Design: events arrive in causal order (planning -> phases -> steps ->
 * completion). The reducer is total over the `AgentEvent` union and never
 * mutates its input — every branch returns a new state object.
 */
import type { AgentEvent, AgentExecutionResult } from '@frontagent/core';

export type RunStatus = 'idle' | 'planning' | 'running' | 'completed' | 'failed';
export type StepStatusView = 'pending' | 'running' | 'completed' | 'failed';
export type PhaseStatusView = 'pending' | 'active' | 'completed';
export type LogLevel = 'info' | 'success' | 'warn' | 'error';

/** Phase name used when a step arrives without an explicit phase grouping. */
export const UNGROUPED_PHASE = 'execution';

export interface StepView {
  id: string;
  title: string;
  phase: string;
  status: StepStatusView;
  tool?: string;
  detail?: string;
  error?: string;
}

export interface PhaseView {
  name: string;
  status: PhaseStatusView;
  /** Steps the phase announced it would run (0 when not yet known). */
  expectedSteps: number;
  steps: StepView[];
}

export interface LogLine {
  seq: number;
  level: LogLevel;
  text: string;
}

export interface ConsoleState {
  status: RunStatus;
  task?: string;
  planSummary?: string;
  phases: PhaseView[];
  activeStepId?: string;
  log: LogLine[];
  /** Accumulated streamed tokens keyed by step id. */
  tokensByStep: Record<string, string>;
  result?: AgentExecutionResult;
  error?: string;
  /** Monotonic counter backing stable log keys. */
  logSeq: number;
}

export const initialConsoleState: ConsoleState = {
  status: 'idle',
  phases: [],
  log: [],
  tokensByStep: {},
  logSeq: 0,
};

function appendLog(state: ConsoleState, level: LogLevel, text: string): ConsoleState {
  return {
    ...state,
    logSeq: state.logSeq + 1,
    log: [...state.log, { seq: state.logSeq + 1, level, text }],
  };
}

function activePhaseName(state: ConsoleState): string | undefined {
  return state.phases.find((phase) => phase.status === 'active')?.name;
}

/** Return a copy of `phases` guaranteeing a phase with `name` exists. */
function ensurePhase(phases: PhaseView[], name: string): PhaseView[] {
  if (phases.some((phase) => phase.name === name)) return phases;
  return [...phases, { name, status: 'pending', expectedSteps: 0, steps: [] }];
}

function mapPhase(
  phases: PhaseView[],
  name: string,
  fn: (phase: PhaseView) => PhaseView,
): PhaseView[] {
  return phases.map((phase) => (phase.name === name ? fn(phase) : phase));
}

function upsertStep(phase: PhaseView, step: StepView): PhaseView {
  const exists = phase.steps.some((existing) => existing.id === step.id);
  const steps = exists
    ? phase.steps.map((existing) => (existing.id === step.id ? { ...existing, ...step } : existing))
    : [...phase.steps, step];
  return { ...phase, steps };
}

function resolvePhaseName(state: ConsoleState, stepPhase: string | undefined): string {
  return stepPhase ?? activePhaseName(state) ?? UNGROUPED_PHASE;
}

export function consoleReducer(state: ConsoleState, event: AgentEvent): ConsoleState {
  switch (event.type) {
    case 'task_started':
      return appendLog(
        { ...initialConsoleState, status: 'planning', task: event.task.description },
        'info',
        `任务开始: ${event.task.description}`,
      );

    case 'status_update':
      return appendLog(
        state,
        'info',
        event.detail ? `${event.label} — ${event.detail}` : event.label,
      );

    case 'planning_started':
      return appendLog({ ...state, status: 'planning' }, 'info', '规划开始');

    case 'rag_retrieved':
      return appendLog(state, 'info', `RAG 检索: ${event.matches.length} 条匹配`);

    case 'filesense_navigated':
      return appendLog(
        state,
        'info',
        `Filesense 导航: ${event.paths.length} 路径 / ${event.entries} 条目`,
      );

    case 'planning_completed': {
      const seeded = (event.plan.phases ?? []).reduce(
        (phases, phase) =>
          mapPhase(ensurePhase(phases, phase.name), phase.name, (existing) => ({
            ...existing,
            expectedSteps: phase.stepIndices.length,
          })),
        state.phases,
      );
      return appendLog(
        { ...state, status: 'running', planSummary: event.plan.summary, phases: seeded },
        'success',
        `规划完成: ${event.plan.steps.length} 步`,
      );
    }

    case 'phase_started': {
      const phases = mapPhase(ensurePhase(state.phases, event.phase), event.phase, (phase) => ({
        ...phase,
        status: 'active',
        expectedSteps: event.stepCount,
      }));
      return appendLog(
        { ...state, phases },
        'info',
        `阶段开始: ${event.phase} (${event.stepCount} 步)`,
      );
    }

    case 'phase_completed': {
      const phases = mapPhase(state.phases, event.phase, (phase) => ({
        ...phase,
        status: 'completed',
      }));
      return appendLog(
        { ...state, phases },
        event.failureCount > 0 ? 'warn' : 'success',
        `阶段完成: ${event.phase} (成功 ${event.successCount} / 失败 ${event.failureCount})`,
      );
    }

    case 'step_started': {
      const phaseName = resolvePhaseName(state, event.step.phase);
      const phases = mapPhase(ensurePhase(state.phases, phaseName), phaseName, (phase) =>
        upsertStep(phase, {
          id: event.step.stepId,
          title: event.step.description,
          phase: phaseName,
          status: 'running',
          tool: event.step.tool,
        }),
      );
      return appendLog(
        { ...state, phases, activeStepId: event.step.stepId },
        'info',
        `步骤开始: ${event.step.description}`,
      );
    }

    case 'step_completed': {
      const phaseName = resolvePhaseName(state, event.step.phase);
      const phases = mapPhase(ensurePhase(state.phases, phaseName), phaseName, (phase) =>
        upsertStep(phase, {
          id: event.step.stepId,
          title: event.step.description,
          phase: phaseName,
          status: 'completed',
          tool: event.step.tool,
        }),
      );
      const cleared = state.activeStepId === event.step.stepId ? undefined : state.activeStepId;
      return appendLog(
        { ...state, phases, activeStepId: cleared },
        'success',
        `步骤完成: ${event.step.description}`,
      );
    }

    case 'step_failed': {
      const phaseName = resolvePhaseName(state, event.step.phase);
      const phases = mapPhase(ensurePhase(state.phases, phaseName), phaseName, (phase) =>
        upsertStep(phase, {
          id: event.step.stepId,
          title: event.step.description,
          phase: phaseName,
          status: 'failed',
          tool: event.step.tool,
          error: event.error,
        }),
      );
      const cleared = state.activeStepId === event.step.stepId ? undefined : state.activeStepId;
      return appendLog(
        { ...state, phases, activeStepId: cleared },
        'error',
        `步骤失败: ${event.step.description} — ${event.error}`,
      );
    }

    case 'security_decision':
      return appendLog(
        state,
        event.decision.decision === 'deny' ? 'error' : 'warn',
        `安全决策 [${event.decision.riskLevel}] ${event.decision.toolName}: ${event.decision.message}`,
      );

    case 'stream_token':
      return {
        ...state,
        tokensByStep: {
          ...state.tokensByStep,
          [event.stepId]: (state.tokensByStep[event.stepId] ?? '') + event.token,
        },
      };

    case 'validation_failed':
      return appendLog(
        state,
        'warn',
        `校验失败${event.result.blockedBy?.length ? `: ${event.result.blockedBy.join(', ')}` : ''}`,
      );

    case 'rollback_started':
      return appendLog(state, 'warn', `回滚开始: ${event.snapshotId}`);

    case 'rollback_completed':
      return appendLog(state, 'info', `回滚完成: ${event.snapshotId}`);

    case 'task_completed':
      return appendLog(
        { ...state, status: 'completed', result: event.result, activeStepId: undefined },
        event.result.success ? 'success' : 'warn',
        `任务完成${event.result.success ? '' : '（部分失败）'}`,
      );

    case 'task_failed':
      return appendLog(
        { ...state, status: 'failed', error: event.error, activeStepId: undefined },
        'error',
        `任务失败: ${event.error}`,
      );

    default:
      return assertNever(event);
  }
}

/** Fold a whole event sequence from the initial state — convenient for tests and replays. */
export function reduceEvents(
  events: AgentEvent[],
  state: ConsoleState = initialConsoleState,
): ConsoleState {
  return events.reduce(consoleReducer, state);
}

function assertNever(event: never): never {
  throw new Error(`Unhandled agent event: ${JSON.stringify(event)}`);
}
