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
import type { ApprovalRequest } from '@frontagent/shared';

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
  /**
   * Outstanding approval requests awaiting a decision. Approvals do not flow
   * through the `AgentEvent` union — they arrive on a separate bridge channel —
   * so they are applied via {@link addApprovalRequest} / {@link resolveApproval}
   * rather than `consoleReducer`. They live here so the whole console renders
   * from one state model (one truth, not a parallel UI-owned store).
   */
  pendingApprovals: ApprovalRequest[];
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
  pendingApprovals: [],
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

/**
 * Close out a run that has ended: force any still-`running` step to a terminal
 * state and any still-`active` phase lane to `completed`, so a finished run is
 * never rendered as in-progress. `error` is attached to steps terminalized as
 * failed. (Phase status has no `failed` variant — step-level status carries the
 * failure detail.)
 */
function terminalizeRunningSteps(
  phases: PhaseView[],
  status: 'completed' | 'failed',
  error?: string,
): PhaseView[] {
  return phases.map((phase) => ({
    ...phase,
    status: phase.status === 'active' ? 'completed' : phase.status,
    steps: phase.steps.map((step) =>
      step.status === 'running' ? { ...step, status, error: error ?? step.error } : step,
    ),
  }));
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

    // 放弃校正也要出现在日志里，且用 warn。只显示成功改写会让人以为
    // 路径接地全都命中了，而放弃的那几条恰恰是需要人去看的（#434）。
    case 'filesense_path_grounded':
      return event.outcome === 'corrected'
        ? appendLog(state, 'info', `路径接地: ${event.from} → ${event.to}`)
        : appendLog(state, 'warn', `路径接地放弃: ${event.from}（${event.reason}）`);

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

    case 'validation_failed': {
      // 这个事件现在有两种含义，必须看 `result.pass` 才能分开：
      // 执行器把「发事件」与「判成败」解耦了，被降级的判定（写动作上的
      // syntax_validity、apply_patch 上的 import_validity）仍以 pass:false 留在
      // results 里并照常发事件，但 `blockedBy` 是空的、步骤是成功的。只按 stage
      // 归类会把它标成「校验失败」并给出一句没有理由的 warn——而按 #413 的实测
      // （撇号、多行模板字符串、JSX 缩写全判 block）这会出现在大量成功写入上。
      const recordedOnly = event.result.pass;
      // 阶段决定了这条日志的含义：pre_write 是「坏内容没能落盘」（好事），
      // post_write 是「已落盘再判失败」（文件可能还在）。混成一句会误导读日志的人。
      const stageLabel = recordedOnly
        ? '写盘后校验记录（未否决）'
        : event.stage === 'pre_write'
          ? '写盘前拦截'
          : event.stage === 'post_write'
            ? '写盘后校验失败'
            : '执行前校验失败';
      const target = event.path ? `[${event.path}] ` : '';
      // 降级项的理由不在 blockedBy 里（那是「否决了什么」），退回到 results 上的
      // 检查名，否则这条日志会只剩一个前缀。
      const recordedReasons = event.result.results
        .filter((entry) => !entry.pass)
        .map((entry) => entry.message ?? entry.type);
      const reasons = event.result.blockedBy?.length ? event.result.blockedBy : recordedReasons;
      const reason = reasons.length ? `: ${reasons.join(', ')}` : '';
      return appendLog(
        state,
        recordedOnly ? 'info' : 'warn',
        `${stageLabel} ${target}${reason}`.trim(),
      );
    }

    case 'rollback_started':
      return appendLog(state, 'warn', `回滚开始: ${event.snapshotId}`);

    case 'rollback_completed':
      return appendLog(state, 'info', `回滚完成: ${event.snapshotId}`);

    case 'rollback_failed':
      // 没有这条，`rollback_started` 会成为永远等不到收尾的日志，
      // 用户也无从知道坏文件仍在工作区里。
      return appendLog(
        state,
        'error',
        `回滚失败: ${event.snapshotId}（写入仍在磁盘上）: ${event.error}`,
      );

    case 'task_completed':
      // A `task_completed` event only means the run reached its end — the run
      // may still have failed. Route the status by `result.success` so the UI
      // can rely on `status` alone and never paints a failed run as successful.
      return appendLog(
        {
          ...state,
          status: event.result.success ? 'completed' : 'failed',
          result: event.result,
          error: event.result.success ? state.error : (event.result.error ?? state.error),
          activeStepId: undefined,
          phases: terminalizeRunningSteps(
            state.phases,
            event.result.success ? 'completed' : 'failed',
            event.result.success ? undefined : '任务结束时该步骤仍未完成',
          ),
        },
        event.result.success ? 'success' : 'warn',
        `任务完成${event.result.success ? '' : '（失败）'}`,
      );

    case 'task_failed':
      return appendLog(
        {
          ...state,
          status: 'failed',
          error: event.error,
          activeStepId: undefined,
          phases: terminalizeRunningSteps(state.phases, 'failed', `任务失败时中断: ${event.error}`),
        },
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

/**
 * Record an incoming approval request. Approvals arrive on a separate bridge
 * channel (not the `AgentEvent` stream), so they have their own action while
 * still living in {@link ConsoleState}. De-duplicates on `approvalId`.
 */
export function addApprovalRequest(state: ConsoleState, request: ApprovalRequest): ConsoleState {
  if (state.pendingApprovals.some((pending) => pending.approvalId === request.approvalId)) {
    return state;
  }
  return appendLog(
    { ...state, pendingApprovals: [...state.pendingApprovals, request] },
    'warn',
    `等待审批 [${request.riskLevel}] ${request.toolName}: ${request.message}`,
  );
}

/** Remove a resolved approval request from the pending queue once a decision is made. */
export function resolveApproval(
  state: ConsoleState,
  approvalId: string,
  approved: boolean,
): ConsoleState {
  if (!state.pendingApprovals.some((pending) => pending.approvalId === approvalId)) {
    return state;
  }
  return appendLog(
    {
      ...state,
      pendingApprovals: state.pendingApprovals.filter(
        (pending) => pending.approvalId !== approvalId,
      ),
    },
    approved ? 'info' : 'warn',
    `审批${approved ? '通过' : '拒绝'}: ${approvalId}`,
  );
}

function assertNever(event: never): never {
  throw new Error(`Unhandled agent event: ${JSON.stringify(event)}`);
}
