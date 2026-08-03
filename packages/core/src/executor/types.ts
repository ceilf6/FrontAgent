import type { HallucinationGuard } from '@frontagent/hallucination-guard';
import type {
  ApprovalRequest,
  ExecutionStep,
  SDDConfig,
  SecurityApprovalResponse,
  SecurityConfig,
  SecurityDecision,
} from '@frontagent/shared';
import type { LLMService } from '../llm.js';
import type { AgentEvent, AgentLifecycleHooks } from '../types.js';

export interface MCPClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<Array<{ name: string; description: string }>>;
}

export interface ExecutorConfig {
  /**
   * 执行器事件出口。没有它，执行器这条校验路径上发生的一切在遥测层不可观测——
   * 这正是 issue #388 的内容：`validation_failed` 有类型定义、有 UI 消费方，
   * 却在全仓没有任何发射点。
   */
  emitEvent?: (event: AgentEvent) => void;
  projectRoot: string;
  hallucinationGuard: HallucinationGuard;
  llmService: LLMService;
  debug?: boolean;
  getCreatedModules?: () => string[];
  getSddConstraints?: () => string | undefined;
  getSkillContext?: () => string | undefined;
  getFileSystemFacts?: () =>
    | {
        existingFiles: Set<string>;
        existingDirectories: Set<string>;
        nonExistentPaths: Set<string>;
        directoryContents: Map<string, string[]>;
      }
    | undefined;
  getMemoryRecall?: (filePath: string, action: string) => string | undefined;
  onStreamToken?: (token: string, stepId: string) => void;
  security?: SecurityConfig;
  sddConfig?: SDDConfig;
  approvalHandler?: (request: ApprovalRequest) => Promise<boolean | SecurityApprovalResponse>;
  /** 用户选择"始终允许"时的规则持久化回调 */
  onPersistAllowRule?: (rule: string) => void;
  onSecurityDecision?: (decision: SecurityDecision) => void;
  /** 生命周期 hooks：preToolUse 可拦截调用，postToolUse 仅观察 */
  lifecycleHooks?: AgentLifecycleHooks;
  trace?: ExecutorTraceConfig;
  executionEngine?: 'native' | 'langgraph';
  langGraph?: {
    enabled?: boolean;
    useCheckpoint?: boolean;
    maxRecoveryAttempts?: number;
    threadIdPrefix?: string;
  };
  maxRecoveryAttempts?: number;
  parallelExecution?: boolean;
}

export interface PhaseExecutionGroup {
  phase: string;
  steps: ExecutionStep[];
  dependencies: Set<string>;
  firstSeenIndex: number;
  priority: number;
}

export interface ExecutorTraceStage {
  name:
    | 'validate_params'
    | 'validate_before'
    | 'prepare_tool_params'
    | 'validate_content'
    | 'call_tool'
    | 'validate_after'
    | 'handle_tool_result'
    | 'catch';
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ExecutorSubStage {
  name: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ExecutorStepTrace {
  taskId?: string;
  stepId: string;
  action: string;
  tool: string;
  totalMs: number;
  success: boolean;
  skipped?: boolean;
  error?: string;
  stages: ExecutorTraceStage[];
  toolDurationMs?: number;
  subStages?: ExecutorSubStage[];
}

export interface ExecutorTraceConfig {
  enabled?: boolean;
  onStepTrace?: (trace: ExecutorStepTrace) => void;
}

export interface ExecutorTraceSummary {
  count: number;
  totalMs: { avg: number; min: number; median: number; max: number };
  toolDurationMs: { avg: number; min: number; median: number; max: number };
  stages: Record<string, { avg: number; min: number; median: number; max: number }>;
  subStages: Record<string, { avg: number; min: number; median: number; max: number }>;
}

export interface ExecutorTraceCollector {
  traces: ExecutorStepTrace[];
  config: ExecutorTraceConfig;
  summary(): Record<string, ExecutorTraceSummary>;
}

export interface SerializablePhaseExecutionGroup {
  phase: string;
  steps: ExecutionStep[];
  dependencies: string[];
  firstSeenIndex: number;
  priority: number;
}

export interface LangGraphRuntimeState {
  phaseGroups: SerializablePhaseExecutionGroup[];
  phaseIndex: number;
  completedStepIds: string[];
  allResults: import('../types.js').ExecutorOutput[];
}

export interface ExecutorCollectedContext {
  files: Map<string, string>;
  ragResults?: string[];
  matchedSkillNames?: string[];
  skillContext?: string;
  filesenseContext?: string;
}
