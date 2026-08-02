import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StepResult, ValidationResult } from '@frontagent/shared';
import type { AgentEvent, ExecutorOutput } from '../types.js';
import { buildFenceVeto, WRITE_ACTIONS } from './write-validation.js';

/**
 * 一次写步骤在工具返回之后的全部判定：合成最终 validation、决定要不要撤销、
 * 拼出对恢复循环有用的错误文案。
 *
 * 抽出来是因为这几件事互相耦合——`landedContent === undefined`、
 * `landedFenceVeto.pass`、`needsRollback` 三者的交叉分支要一起读才成立——
 * 而它们塞在 `executeStep` 里会让那个函数变成「读完 280 行才敢改一行」。
 * 除回滚外全是纯计算，回滚以回调注入，所以这个模块可以脱离执行器单独推演。
 */
export interface WriteOutcomeInput {
  action: string;
  /** 已解析的写入路径，写盘前后共用同一份 */
  landedPath: string | undefined;
  /** 落盘内容；读不回时为 undefined。一次步骤只读一次，由调用方传入 */
  landedContent: string | undefined;
  /**
   * 本次写入之前的文件内容，取自 `collectedContext.files`；不可知时为 undefined。
   *
   * 围栏判据要判的是「**这次写入**引入了围栏」，而不是「文件里有围栏」。局部行
   * 补丁只改几行，却会拿到整份落盘文件——文件别处早就存在的围栏会让一次无关的
   * 合法编辑失败并触发回滚。undefined 时按 fail-closed 处理（`create_file` 没有
   * 前置内容，任何围栏都必然是这次引入的）。
   */
  priorContent: string | undefined;
  /** 落盘路径的语言，供围栏判据判断适用性 */
  landedLanguage: string;
  /** 工具原始返回值，用于取 snapshotId 与判断工具自身是否失败 */
  toolResult: unknown;
  /** 写盘后校验结论 */
  postValidation: ValidationResult;
  /** guard 的 syntaxValidity 是否启用；关掉时围栏判据也必须一起失效 */
  vetoEnabled: boolean;
  durationMs: number;
}

export interface WriteOutcome {
  stepResult: StepResult;
  validation: ValidationResult;
  needsRollback: boolean;
  /** 需要撤销时由调用方执行；读不回内容时为 undefined（无法判断该不该撤销） */
  rollback?: 'requested';
  /** 读不回落盘内容的路径，仅用于告警 */
  unreadablePath?: string;
}

function toolReportedFailure(toolResult: unknown): boolean {
  return (
    typeof toolResult === 'object' &&
    toolResult !== null &&
    (toolResult as { success?: boolean }).success === false
  );
}

function snapshotIdOf(toolResult: unknown): string | undefined {
  return (toolResult as { snapshotId?: string } | null | undefined)?.snapshotId;
}

/**
 * 计算写盘后的判定，不产生任何副作用。
 *
 * 返回的 `rollback === 'requested'` 表示调用方应当撤销；`unreadablePath` 表示
 * 落盘内容读不回来，因此**无法判断**要不要撤销——两者互斥，且后者刻意不置
 * `rollbackFailed`（那会驱动中止语义，是比「读不回」更强的断言）。
 */
export function resolveWriteOutcome(input: WriteOutcomeInput): WriteOutcome {
  const { action, landedPath, landedContent, landedLanguage, toolResult, postValidation } = input;

  // 工具自己失败时，写盘后的这套判定全都不适用：没有落盘内容可判，
  // 而 `validateAfterExecution` 已经把工具错误原样放进 blockedBy。继续往下走会
  // 让「读不回」的后缀拼到一个与读回无关的错误后面（EACCES + could not read
  // back），而 runPhaseRecovery 会把这句话喂给重试用的模型。
  if (toolReportedFailure(toolResult)) {
    return {
      stepResult: {
        success: false,
        output: toolResult,
        error: postValidation.blockedBy?.join('; '),
        duration: input.durationMs,
        snapshotId: snapshotIdOf(toolResult),
      },
      validation: postValidation,
      // 写动作的工具失败照旧中止：继续跑的话，后续「引用该模块的另一个文件」
      // 会全绿收尾，整轮以「缺模块但步骤全成功」呈现。
      needsRollback: postValidation.results.length > 0 || WRITE_ACTIONS.includes(action),
    };
  }

  // 落盘内容里的围栏是**独立**的失败来源，不依附于 postValidation：写盘后的
  // syntax_validity 在 apply_patch 上已降级为不否决，所以一份写进 .ts 的围栏不会
  // 再让 postValidation 失败——但它确实是坏内容，必须自己让步骤失败并触发撤销。
  // 这也让「判失败」与「触发回滚」用同一条确定性判据，不会一个判失败、另一个不撤销。
  const landedVeto =
    landedContent !== undefined && input.vetoEnabled
      ? buildFenceVeto(landedContent, String(landedPath), landedLanguage)
      : { pass: true, results: [] };
  // 补丁前就已存在围栏时，这次写入没有引入任何东西——放行，否则一次只改几行的
  // 合法补丁会因文件别处的既有围栏被判失败并回滚。原文不可知时不放行。
  const preExisting =
    input.priorContent !== undefined && !landedVeto.pass
      ? !buildFenceVeto(input.priorContent, String(landedPath), landedLanguage).pass
      : false;
  const landedFenceVeto = preExisting ? { pass: true, results: [] } : landedVeto;

  // 合并而不是替换。整体换成 landedFenceVeto 会让 postValidation 的
  // import_validity / syntax_validity 条目、以及工具自身的错误文案一起消失，
  // 而这个对象同时喂给 validation_failed 事件、stepResult.error 和
  // ExecutorOutput.validation——正好与 write-validation.ts 里「降级不删除、
  // 遥测照常可见」的原则相反。
  const validation: ValidationResult = landedFenceVeto.pass
    ? postValidation
    : {
        pass: false,
        results: [...postValidation.results, ...landedFenceVeto.results],
        blockedBy: [...(postValidation.blockedBy ?? []), ...(landedFenceVeto.blockedBy ?? [])],
      };

  let rollback: 'requested' | undefined;
  let unreadablePath: string | undefined;
  if (!validation.pass) {
    if (landedContent === undefined && snapshotIdOf(toolResult)) {
      // 读不回内容（路径越界 / 不可读 / 工具根目录与 projectRoot 不一致）时，
      // 既不会尝试回滚、rollbackFailed 也保持 false——三处都表现为「无异常」。
      // 至少要让它在 stepResult.error 里可见，否则又是一个静默为「什么都没发生」
      // 的分支。
      unreadablePath = landedPath;
    } else if (!landedFenceVeto.pass) {
      // 回滚只由确定性的围栏判据触发：`create` 快照的回滚是 unlinkSync，
      // 误判一次就是删掉一个合法文件。
      rollback = 'requested';
    }
  }

  return {
    stepResult: {
      success: validation.pass,
      output: toolResult,
      error: validation.pass ? undefined : validation.blockedBy?.join('; '),
      duration: input.durationMs,
      snapshotId: snapshotIdOf(toolResult),
    },
    validation,
    // 判据是 `!pass`，不是 `results.some(!pass)`：降级后的判定仍以 `pass: false`
    // 留在 results 里，用后者会让一条不该否决的检查把整个剩余计划标成 skipped
    // ——正是降级要消除的那种误伤。`results.length > 0` 只用来把「纯工具失败」
    // （results 为空）从非写动作里排除掉。
    needsRollback:
      !validation.pass && (validation.results.length > 0 || WRITE_ACTIONS.includes(action)),
    rollback,
    unreadablePath,
  };
}

/**
 * 把回滚结果与「读不回」并进错误文案。
 *
 * 回滚没成功时必须写进 error：否则「坏文件还在磁盘上」这一事实在非交互运行里
 * 除了事件流之外无处可查。
 */
export function describeWriteFailure(
  baseError: string | undefined,
  rollbackOutcome: { rollbackFailed: boolean; error?: string },
  unreadablePath: string | undefined,
): string | undefined {
  if (rollbackOutcome.rollbackFailed) {
    return `${baseError ?? 'step failed'} (rollback failed: ${rollbackOutcome.error}; the written file is still on disk)`;
  }
  if (unreadablePath) {
    return `${baseError ?? 'step failed'} (could not read back ${unreadablePath}; rollback was not attempted)`;
  }
  return baseError;
}

/**
 * 写盘前的否决判定。返回 `null` 表示放行。
 *
 * 判据故意只有围栏这一条确定性规则——见 `write-validation.ts` 里为什么不能把
 * 否决权交给 guard 的 `syntax_validity`。而 `vetoEnabled` 必须来自 guard 自己的
 * `enabledChecks`：执行器在 guard 之外复刻了一条检查，若它不受同一份配置管辖，
 * `syntaxValidity: false` 就关不掉写盘否决——那正是 #386 让七月消融基准 guard 臂
 * 失效的机制。
 */
export function resolvePreWriteVeto(
  writeContent: { path: string; content: string; language: string } | null,
  vetoEnabled: boolean,
  durationMs: number,
): { output: ExecutorOutput; validation: ValidationResult } | null {
  if (!writeContent || !vetoEnabled) return null;
  const validation = buildFenceVeto(writeContent.content, writeContent.path, writeContent.language);
  if (validation.pass) return null;

  return {
    validation,
    output: {
      stepResult: {
        success: false,
        error: `Pre-write validation failed: ${validation.blockedBy?.join('; ') ?? ''}`,
        duration: durationMs,
      },
      validation,
      // 磁盘上没有残留（rollbackFailed 保持 false），但中止语义必须与其余真实
      // 检查失败一致：否则计划继续跑，后续针对该文件的 apply_patch 会拿到
      // 「文件不存在」并被判为可跳过、记成成功——整轮以「零文件产出」呈现为成功。
      //
      // 范围限定：`needsRollback` 的唯一读取方是 progress-enforcement，只对直接
      // 嵌入 `Executor.executeSteps` 的调用方生效。agent 主路径走
      // `executeStepsWithErrorFeedback` → phase-runner，两者都不读这个字段，那条
      // 路径上的实际效果是「步骤失败 → 进入 runPhaseRecovery 重试」，而不是中止。
      needsRollback: true,
      rollbackFailed: false,
    },
  };
}

/**
 * 读回刚写入的文件内容，供写盘后校验使用。
 * 读不到（路径越界、文件已被删）时返回 undefined，由调用方跳过内容校验。
 */
export function readWrittenFile(projectRoot: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const absolute = resolve(projectRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
    return readFileSync(absolute, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * 撤销已落盘的写入。快照由写工具在改动前创建，回滚是把它恢复回去；
 * 没有快照（工具未写盘或不支持快照）时无事可做。
 *
 * 返回「是否尝试过回滚且没成功」。这**不等于**「坏文件还在磁盘上」：
 * 没有快照时根本不会尝试回滚，文件照样留着。字段名如实反映前者。
 */
export async function rollbackFailedWrite(
  toolResult: unknown,
  deps: {
    rollback: (snapshotId: string) => Promise<{ success: boolean; message: string }>;
    emitEvent?: (event: AgentEvent) => void;
    warn: (message: string) => void;
  },
): Promise<{ rollbackFailed: boolean; error?: string }> {
  if (typeof toolResult !== 'object' || toolResult === null) {
    return { rollbackFailed: false };
  }
  const snapshotId = (toolResult as { snapshotId?: string }).snapshotId;
  if (!snapshotId) {
    return { rollbackFailed: false };
  }

  deps.emitEvent?.({ type: 'rollback_started', snapshotId });
  const result = await deps.rollback(snapshotId);
  if (result.success) {
    deps.emitEvent?.({ type: 'rollback_completed', snapshotId });
    return { rollbackFailed: false };
  }

  // 默认非交互配置下安全层会拒绝 rollback。这条分支恰恰是 headless 运行里
  // 最需要上报的：没有终态事件，调用方会停在「回滚开始」，
  // 无法判定坏文件是否还在磁盘上。
  deps.emitEvent?.({ type: 'rollback_failed', snapshotId, error: result.message });
  deps.warn(`[Executor] Rollback failed for snapshot ${snapshotId}: ${result.message}`);
  return { rollbackFailed: true, error: result.message };
}
