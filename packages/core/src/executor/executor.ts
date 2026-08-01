import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentTask, ExecutionStep, StepResult, ValidationResult } from '@frontagent/shared';
import { logger } from '@frontagent/shared';
import {
  createDefaultExecutorSkillRegistry,
  type ExecutorActionSkill,
  type ExecutorSkillsLayerSnapshot,
} from '../skills/index.js';
import type { ExecutorOutput } from '../types.js';
import { buildOrderedPhaseGroups, detectLanguage } from './phase-ordering.js';
import { PhaseRunner } from './phase-runner.js';
import { executeStepsWithProgressEnforcement } from './progress-enforcement.js';
import { executeStepsWithErrorFeedbackViaLangGraph } from './step-feedback-runner.js';
import { createStepTraceRecorder } from './step-trace-recorder.js';
import { ExecutorToolCallHandler } from './tool-call-handler.js';
import type {
  ExecutorCollectedContext,
  ExecutorConfig,
  MCPClient,
  PhaseExecutionGroup,
} from './types.js';

/** 会把内容写到磁盘的动作——校验必须发生在调用它们之前 */
const WRITE_ACTIONS = ['apply_patch', 'create_file'];

/**
 * 有资格否决写盘的检查。只有语法失败才在列——语法非法的文件落盘没有任何价值，
 * 而 import_validity 对「同一计划里后续步骤才创建的相对模块」与路径别名会误判 block，
 * 把它纳入否决权会让本来能自洽的多文件计划根本写不出第一个文件。
 */
const PRE_WRITE_VETO_CHECKS = new Set(['syntax_validity']);

/**
 * 把完整校验结果收窄成「写盘否决」判定：仅保留有否决资格且判 block 的失败项。
 * 其余失败项照旧留给写盘后判定，语义与本 PR 之前一致。
 */
function narrowToPreWriteVeto(validation: ValidationResult): ValidationResult {
  const vetoing = validation.results.filter(
    (result) =>
      !result.pass && result.severity === 'block' && PRE_WRITE_VETO_CHECKS.has(result.type),
  );
  if (vetoing.length === 0) {
    return { pass: true, results: [] };
  }
  return {
    pass: false,
    results: vetoing,
    blockedBy: vetoing.map((result) => result.message ?? result.type),
  };
}

/**
 * codegen 生成的 apply_patch 是「覆盖整文件的单个 replace」——
 * 计划 schema 不产出 patches，所有 modify 步骤都走这条路（executor-skills 的
 * apply_patch 分支固定发 {operation:'replace', startLine:1, endLine:原文件行数}）。
 * 这类补丁的最终内容在写盘前完全已知，理应和 create_file 一样受前置校验保护。
 * 只改局部行的补丁仍返回 undefined，落回写盘后判定。
 */
function resolveFullFileReplaceContent(
  toolParams: Record<string, unknown>,
  originalContent: string | undefined,
): string | undefined {
  const patches = toolParams.patches;
  if (!Array.isArray(patches) || patches.length !== 1) {
    return undefined;
  }
  const patch = patches[0] as {
    operation?: string;
    startLine?: number;
    endLine?: number;
    content?: string;
  };
  if (patch.operation !== 'replace' || typeof patch.content !== 'string') {
    return undefined;
  }
  if (patch.startLine !== 1 || originalContent === undefined) {
    return undefined;
  }
  const originalLines = originalContent.split('\n').length;
  return typeof patch.endLine === 'number' && patch.endLine >= originalLines
    ? patch.content
    : undefined;
}

export class Executor {
  private config: ExecutorConfig;
  private mcpClients: Map<string, MCPClient> = new Map();
  private toolToClient: Map<string, string> = new Map();
  private actionSkills: ReturnType<typeof createDefaultExecutorSkillRegistry>;
  private currentBrowserUrl?: string;
  private phaseRunner: PhaseRunner;
  private toolCallHandler: ExecutorToolCallHandler;

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.toolCallHandler = new ExecutorToolCallHandler({
      config: this.config,
      mcpClients: this.mcpClients,
      toolToClient: this.toolToClient,
      nowMs: () => this.nowMs(),
      getCurrentBrowserUrl: () => this.currentBrowserUrl,
    });
    this.actionSkills = createDefaultExecutorSkillRegistry({
      llmService: this.config.llmService,
      debug: this.config.debug,
      getCreatedModules: this.config.getCreatedModules,
      getSddConstraints: this.config.getSddConstraints,
      getSkillContext: this.config.getSkillContext,
      getMemoryRecall: this.config.getMemoryRecall,
      onStreamToken: this.config.onStreamToken,
      buildContextString: (collectedContext) => this.buildContextString(collectedContext),
      detectLanguage: (path) => detectLanguage(path),
    });
    this.phaseRunner = new PhaseRunner({
      executeStep: (step, ctx) => this.executeStep(step, ctx),
      debugLog: (...args) => this.debugLog(...args),
      debugWarn: (...args) => this.debugWarn(...args),
      debugError: (...args) => this.debugError(...args),
      throwIfAborted: (signal) => this.throwIfAborted(signal),
      getMaxRecoveryAttempts: () => this.getMaxRecoveryAttempts(),
      createRecoveryFingerprint: (errors) => this.createRecoveryFingerprint(errors),
      parallelExecution: Boolean(config.parallelExecution),
    });
  }

  private debugLog(...args: unknown[]): void {
    if (this.config.debug) {
      logger.debug(...args);
    }
  }

  private debugWarn(...args: unknown[]): void {
    if (this.config.debug) {
      logger.warn(...args);
    }
  }

  private debugError(...args: unknown[]): void {
    if (this.config.debug) {
      logger.error(...args);
    }
  }

  private nowMs(): number {
    return Number(process.hrtime.bigint()) / 1_000_000;
  }

  registerMCPClient(name: string, client: MCPClient): void {
    this.mcpClients.set(name, client);
  }

  registerToolMapping(toolName: string, clientName: string): void {
    this.toolToClient.set(toolName, clientName);
  }

  registerActionSkill(skill: ExecutorActionSkill): void {
    this.actionSkills.registerActionSkill(skill);
  }

  getActionSkillSnapshot(): ExecutorSkillsLayerSnapshot {
    return this.actionSkills.snapshot();
  }

  async executeStep(
    step: ExecutionStep,
    context: {
      task: AgentTask;
      collectedContext: ExecutorCollectedContext;
    },
  ): Promise<ExecutorOutput> {
    const startTime = Date.now();
    const trace = createStepTraceRecorder({
      trace: this.config.trace,
      taskId: context.task.id,
      step,
      nowMs: () => this.nowMs(),
    });

    try {
      const paramValidation = await trace.withStage('validate_params', () =>
        this.validateStepParams(step),
      );
      if (!paramValidation.valid) {
        if (this.config.debug) {
          console.log(`[Executor] Skipping step due to invalid params: ${paramValidation.reason}`);
        }
        return trace.finish(this.buildSkippedStepOutput(paramValidation.reason, startTime));
      }

      const preValidation = await trace.withStage('validate_before', () =>
        this.validateBeforeExecution(step, context),
      );
      if (!preValidation.pass) {
        const skip = this.getPreValidationSkip(step, preValidation);
        if (skip) {
          if (this.config.debug) {
            console.log(`[Executor] Skipping step due to validation: ${skip.reason}`);
          }
          return trace.finish(
            this.buildSkippedStepOutput(skip.reason, startTime, { exists: false }),
          );
        }

        const errorMsg = preValidation.blockedBy?.join('; ') || '';
        this.emitValidationFailed(preValidation);
        return trace.finish({
          stepResult: {
            success: false,
            error: `Pre-execution validation failed: ${errorMsg}`,
            duration: Date.now() - startTime,
          },
          validation: preValidation,
          needsRollback: false,
        });
      }

      let toolParams = { ...step.params };

      if (this.config.debug) {
        const stepAny = step as { needsCodeGeneration?: boolean };
        console.log(
          `[Executor] Step action: ${step.action}, needsCodeGeneration: ${Boolean(stepAny.needsCodeGeneration)}`,
        );
        console.log('[Executor] Step params:', toolParams);
      }

      toolParams = await trace.withStage('prepare_tool_params', () =>
        this.actionSkills.prepareToolParams({
          step,
          params: toolParams,
          context,
          onSubStageTiming: (name, durationMs) => {
            trace.addSubStage(name, durationMs);
          },
        }),
      );

      const writeContent = this.resolveWriteContent(step, toolParams, context);
      const rawContentValidation = await trace.withStage('validate_content', () =>
        writeContent
          ? this.config.hallucinationGuard.validateCode(
              writeContent.content,
              writeContent.language,
              writeContent.path,
            )
          : Promise.resolve<ValidationResult>({ pass: true, results: [] }),
      );
      // 只有语法失败才有资格否决写盘。import_validity 对「同一计划里后续步骤才创建的
      // 相对模块」和路径别名必然判 block——写盘后判定时文件还在磁盘上、后续步骤补齐即可自洽，
      // 但一旦升级成写盘否决权，这类合法文件就根本不会存在。import 结果继续留给写盘后判定。
      const contentValidation = narrowToPreWriteVeto(rawContentValidation);
      if (!contentValidation.pass) {
        const errorMsg = contentValidation.blockedBy?.join('; ') || '';
        this.emitValidationFailed(contentValidation);
        if (this.config.debug) {
          console.log(`[Executor] Blocked write before disk: ${errorMsg}`);
        }
        return trace.finish({
          stepResult: {
            success: false,
            error: `Pre-write validation failed: ${errorMsg}`,
            duration: Date.now() - startTime,
          },
          validation: contentValidation,
          needsRollback: false,
        });
      }

      const toolResult = await trace.withStage('call_tool', () =>
        this.callTool(step.tool, toolParams),
      );

      if (typeof toolResult === 'object' && toolResult !== null) {
        const resultObj = toolResult as { success?: boolean; error?: string };
        if (resultObj.success === false && resultObj.error) {
          const isSkippableError = this.isSkippableError(resultObj.error, step, toolParams);
          if (isSkippableError) {
            if (this.config.debug) {
              console.log(`[Executor] Skipping step due to tool error: ${resultObj.error}`);
            }
            return trace.finish(this.buildSkippedStepOutput(resultObj.error, startTime));
          }
        }
      }

      const postValidation = await trace.withStage('validate_after', () =>
        this.validateAfterExecution(
          step,
          toolResult,
          toolParams,
          writeContent ? rawContentValidation : undefined,
        ),
      );

      let rollbackOutcome: { leftOnDisk: boolean; error?: string } = { leftOnDisk: false };
      if (!postValidation.pass) {
        this.emitValidationFailed(postValidation);
        // 回滚不看事件口径：工具失败但已产生快照时同样要把落盘撤销
        rollbackOutcome = await this.rollbackFailedWrite(toolResult);
      }

      const stepError = postValidation.pass ? undefined : postValidation.blockedBy?.join('; ');
      const stepResult: StepResult = {
        success: postValidation.pass,
        output: toolResult,
        // 回滚没成功时把原因并入 error：否则「坏文件还在磁盘上」这一事实在
        // 非交互运行里除了事件流之外无处可查。
        error: rollbackOutcome.leftOnDisk
          ? `${stepError ?? 'step failed'} (rollback failed: ${rollbackOutcome.error}; the written file is still on disk)`
          : stepError,
        duration: Date.now() - startTime,
        snapshotId: (toolResult as { snapshotId?: string })?.snapshotId,
      };

      return trace.finish({
        stepResult,
        validation: postValidation,
        // 字段名说的是「需要回滚」，语义就该是「有内容落了盘且没被成功撤销」，
        // 而不是「这一步失败了」——后者与 !stepResult.success 同义，且会让
        // progress-enforcement 因为一次 read_file/run_command 失败就中止整个剩余计划。
        needsRollback: rollbackOutcome.leftOnDisk,
      });
    } catch (error) {
      trace.markCatchIfEmpty(error);
      return trace.finish({
        stepResult: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
        },
        validation: {
          pass: false,
          results: [],
          blockedBy: [error instanceof Error ? error.message : String(error)],
        },
        needsRollback: true,
      });
    }
  }

  private buildSkippedStepOutput(
    reason: string | undefined,
    startTime: number,
    output: { exists?: false } = {},
  ): ExecutorOutput {
    return {
      stepResult: {
        success: true,
        output: { skipped: true, reason, ...output },
        duration: Date.now() - startTime,
      },
      validation: { pass: true, results: [] },
      needsRollback: false,
    };
  }

  private getPreValidationSkip(
    step: ExecutionStep,
    validation: ValidationResult,
  ): { reason: string } | undefined {
    const reason = validation.blockedBy?.join('; ') || '';
    const isDirectoryError = reason.includes('is not a file') || reason.includes('Not a file');
    const isFileNotExist = reason.includes('does not exist') && step.action === 'read_file';

    if (isDirectoryError || isFileNotExist) {
      return { reason };
    }

    return undefined;
  }

  private validateStepParams(step: ExecutionStep): { valid: boolean; reason?: string } {
    const params = step.params as Record<string, unknown>;
    const customValidation = this.actionSkills.validateStepParams(step, params);
    if (customValidation && !customValidation.valid) {
      return customValidation;
    }

    const requiredParams = this.actionSkills.resolveRequiredParams(step.action);

    for (const paramName of requiredParams) {
      const value = params[paramName];
      const missing =
        value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

      if (missing) {
        return {
          valid: false,
          reason: `${step.action} requires non-empty ${paramName} parameter`,
        };
      }
    }

    return { valid: true };
  }

  private isSkippableError(
    errorMsg: string,
    step: ExecutionStep,
    params?: Record<string, unknown>,
  ): boolean {
    const skillDecision = this.actionSkills.shouldSkipToolError({
      errorMsg,
      step,
      params: params ?? {},
    });
    if (typeof skillDecision === 'boolean') {
      return skillDecision;
    }

    if (
      errorMsg.includes('Not a directory') ||
      errorMsg.includes('is not a file') ||
      errorMsg.includes('Not a file')
    ) {
      return true;
    }

    return false;
  }

  private buildContextString(collectedContext: ExecutorCollectedContext): string {
    const parts: string[] = [];

    if (collectedContext.files.size > 0) {
      parts.push('相关文件:');
      for (const [path, content] of collectedContext.files) {
        const truncatedContent =
          content.length > 1000 ? `${content.substring(0, 1000)}\n... (内容已截断)` : content;
        parts.push(`\n--- ${path} ---\n${truncatedContent}`);
      }
    }

    if (collectedContext.ragResults && collectedContext.ragResults.length > 0) {
      parts.push('\n知识库参考:');
      for (const result of collectedContext.ragResults) {
        parts.push(`- ${result}`);
      }
    }

    if (collectedContext.matchedSkillNames && collectedContext.matchedSkillNames.length > 0) {
      parts.push(`\n已激活内容技能: ${collectedContext.matchedSkillNames.join(', ')}`);
    }

    return parts.join('\n');
  }

  private async validateBeforeExecution(
    step: ExecutionStep,
    context: { task: AgentTask; collectedContext: ExecutorCollectedContext },
  ): Promise<ValidationResult> {
    const results: ValidationResult['results'] = [];

    if (step.action === 'apply_patch' && step.params.path) {
      const path = step.params.path as string;
      const facts = this.config.getFileSystemFacts?.();

      if (facts?.nonExistentPaths.has(path)) {
        if (this.config.debug) {
          console.log(
            `[Executor] ⚠️  File ${path} is known to not exist. Suggest using create_file instead.`,
          );
        }
        return {
          pass: false,
          results: [
            {
              pass: false,
              type: 'file_not_found',
              severity: 'block',
              message: `Cannot apply patch: file ${path} does not exist (confirmed by previous directory listing). Please use create_file instead.`,
            },
          ],
          blockedBy: [`File ${path} does not exist. Use create_file instead of apply_patch.`],
        };
      }

      if (!context.collectedContext.files.has(path)) {
        this.debugLog(
          `[Executor] 📖 File ${path} not in context, auto-reading before apply_patch...`,
        );

        try {
          const readResult = (await this.callTool('read_file', { path })) as {
            success: boolean;
            content?: string;
            error?: string;
          };

          if (readResult.success && readResult.content !== undefined) {
            context.collectedContext.files.set(path, readResult.content);
            this.debugLog(
              `[Executor] ✅ Auto-read file ${path} (${readResult.content.length} chars) into context`,
            );
          } else {
            const errorMsg = readResult.error || 'Failed to read file';
            if (this.config.debug) {
              console.log(`[Executor] ❌ Auto-read failed: ${errorMsg}`);
            }
            return {
              pass: false,
              results: [
                {
                  pass: false,
                  type: 'file_read_failed',
                  severity: 'block',
                  message: `Cannot apply patch: failed to auto-read file ${path}. Error: ${errorMsg}`,
                },
              ],
              blockedBy: [`Failed to auto-read file ${path}: ${errorMsg}`],
            };
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.debugLog(`[Executor] ❌ Auto-read exception: ${errorMsg}`);
          return {
            pass: false,
            results: [
              {
                pass: false,
                type: 'file_read_error',
                severity: 'block',
                message: `Cannot apply patch: error reading file ${path}. Error: ${errorMsg}`,
              },
            ],
            blockedBy: [`Error auto-reading file ${path}: ${errorMsg}`],
          };
        }
      }
    }

    if (step.action === 'read_file' && step.params.path) {
      const fileCheck = await this.config.hallucinationGuard.validateFilePath(
        step.params.path as string,
        true,
      );
      results.push(fileCheck);
    }

    if (step.action === 'create_file' && step.params.path && !step.params.overwrite) {
      const path = step.params.path as string;
      const facts = this.config.getFileSystemFacts?.();

      if (facts?.existingFiles.has(path)) {
        return {
          pass: false,
          results: [
            {
              pass: false,
              type: 'file_existence',
              severity: 'block',
              message: `Cannot create file: ${path} already exists. Use apply_patch after reading the file instead.`,
            },
          ],
          blockedBy: [`File ${path} already exists. Use apply_patch instead of create_file.`],
        };
      }

      const parentDir = dirname(path);
      const parentKnown =
        parentDir === '.' ||
        facts?.existingDirectories.has(parentDir) ||
        Array.from(facts?.directoryContents.keys() ?? []).some((dir) => dir === parentDir);

      if (!parentKnown) {
        if (facts?.nonExistentPaths.has(parentDir)) {
          return {
            pass: false,
            results: [
              {
                pass: false,
                type: 'parent_directory_not_found',
                severity: 'block',
                message: `Cannot create file: parent directory ${parentDir} is known to not exist.`,
              },
            ],
            blockedBy: [`Parent directory ${parentDir} is known to not exist.`],
          };
        }

        try {
          const absoluteParent = resolve(this.config.projectRoot, parentDir);
          const absoluteTarget = resolve(this.config.projectRoot, path);
          const parentExists = existsSync(absoluteParent) && statSync(absoluteParent).isDirectory();
          const targetExists = existsSync(absoluteTarget);

          if (!parentExists || targetExists) {
            const reason = !parentExists
              ? `parent directory ${parentDir} does not exist`
              : `target ${path} already exists`;
            return {
              pass: false,
              results: [
                {
                  pass: false,
                  type: 'progressive_exploration_required',
                  severity: 'block',
                  message: `Cannot create file until the target path is precisely confirmed. ${reason}.`,
                },
              ],
              blockedBy: [
                `Create_file requires progressive exploration: use search_code globOnly/list_directory to narrow candidates before writing ${path}.`,
              ],
            };
          }
        } catch (error) {
          return {
            pass: false,
            results: [
              {
                pass: false,
                type: 'progressive_exploration_required',
                severity: 'block',
                message: `Cannot create file before precise Bash confirmation for ${path}: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            blockedBy: [`Create_file requires precise confirmation before writing ${path}.`],
          };
        }
      }

      const fileCheck = await this.config.hallucinationGuard.validateFilePath(path, false);
      results.push(fileCheck);
    }

    const blockedBy = results
      .filter((r) => !r.pass && r.severity === 'block')
      .map((r) => r.message ?? r.type);

    return {
      pass: blockedBy.length === 0,
      results,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
    };
  }

  /**
   * 解析出「写盘前即可确定的完整文件内容」；返回 null 表示该步骤无法前置校验
   * （如只改动局部行的补丁，最终内容要落盘后才知道）。
   */
  private resolveWriteContent(
    step: ExecutionStep,
    toolParams: Record<string, unknown>,
    context?: { collectedContext: ExecutorCollectedContext },
  ): {
    path: string;
    content: string;
    language: 'typescript' | 'javascript' | 'json' | 'yaml';
  } | null {
    if (!WRITE_ACTIONS.includes(step.action)) {
      return null;
    }

    const path = (toolParams.path ?? step.params.path) as string | undefined;
    if (!path) {
      return null;
    }

    const content =
      ((toolParams.content ?? step.params.content) as string | undefined) ??
      resolveFullFileReplaceContent(toolParams, context?.collectedContext.files.get(path));
    if (typeof content !== 'string') {
      return null;
    }

    const language = detectLanguage(path);
    return language ? { path, content, language } : null;
  }

  /**
   * 只有「至少一项真实检查判定失败」才算校验失败。
   * validateAfterExecution 在工具自身报错时返回 results 为空的失败结果——那是工具失败，
   * 不是校验拦截；两者混在同一事件里会让 validation_failed 无法当作拦截数使用。
   */
  private emitValidationFailed(validation: ValidationResult): void {
    if (validation.results.some((result) => !result.pass)) {
      this.config.emitEvent?.({ type: 'validation_failed', result: validation });
    }
  }

  /**
   * 撤销已落盘的写入。快照由写工具在改动前创建，回滚是把它恢复回去；
   * 没有快照（工具未写盘或不支持快照）时无事可做。
   *
   * 返回「磁盘上是否仍留着未被撤销的写入」——这正是 needsRollback 想表达的东西，
   * 也是判断坏文件是否还在的唯一依据。
   */
  private async rollbackFailedWrite(
    toolResult: unknown,
  ): Promise<{ leftOnDisk: boolean; error?: string }> {
    if (typeof toolResult !== 'object' || toolResult === null) {
      return { leftOnDisk: false };
    }
    const snapshotId = (toolResult as { snapshotId?: string }).snapshotId;
    if (!snapshotId) {
      return { leftOnDisk: false };
    }

    this.config.emitEvent?.({ type: 'rollback_started', snapshotId });
    const result = await this.rollback(snapshotId);
    if (result.success) {
      this.config.emitEvent?.({ type: 'rollback_completed', snapshotId });
      return { leftOnDisk: false };
    }

    // 默认非交互配置下安全层会拒绝 rollback，返回的是 { success:false, error }——
    // 只读 message 会打成 undefined。这条分支恰恰是 headless 运行里最需要上报的：
    // 没有终态事件，调用方会停在「回滚开始」，无法判定坏文件是否还在磁盘上。
    const reason = result.message ?? (result as { error?: string }).error ?? 'unknown error';
    this.config.emitEvent?.({ type: 'rollback_failed', snapshotId, error: reason });
    this.debugWarn(`[Executor] Rollback failed for snapshot ${snapshotId}: ${reason}`);
    return { leftOnDisk: true, error: reason };
  }

  private async validateAfterExecution(
    step: ExecutionStep,
    result: unknown,
    toolParams?: Record<string, unknown>,
    /**
     * 写盘前已在同一份内容上算出的完整校验结果（含 import 检查）。
     * 有它就直接沿用：内容一模一样，再跑一遍只是重复开销。
     */
    preWriteContentValidation?: ValidationResult,
  ): Promise<ValidationResult> {
    if (typeof result === 'object' && result !== null) {
      const resultObj = result as { success?: boolean; error?: string };
      if (resultObj.success === false) {
        return {
          pass: false,
          results: [],
          blockedBy: [resultObj.error ?? 'Tool execution failed'],
        };
      }
    }

    if (preWriteContentValidation) {
      return preWriteContentValidation;
    }

    if (WRITE_ACTIONS.includes(step.action)) {
      const content =
        (result as { content?: string })?.content ??
        (toolParams?.content as string | undefined) ??
        (step.params.content as string | undefined);
      const path = step.params.path as string;

      if (content && path) {
        const language = detectLanguage(path);
        if (language) {
          const codeValidation = await this.config.hallucinationGuard.validateCode(
            content,
            language,
            path,
          );
          return codeValidation;
        }
      }
    }

    return {
      pass: true,
      results: [],
    };
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const toolCall = await this.toolCallHandler.callTool(toolName, args);

    if (toolName === 'browser_navigate' || toolName === 'navigate') {
      if (typeof args.url === 'string' && toolCall.successful) {
        this.currentBrowserUrl = args.url;
      }
    }

    return toolCall.result;
  }

  async executeSteps(
    steps: ExecutionStep[],
    context: {
      task: AgentTask;
      collectedContext: ExecutorCollectedContext;
    },
    onStepComplete?: (step: ExecutionStep, output: ExecutorOutput) => void,
  ): Promise<ExecutorOutput[]> {
    return executeStepsWithProgressEnforcement(
      steps,
      context,
      { executeStep: (step, executionContext) => this.executeStep(step, executionContext) },
      onStepComplete,
    );
  }

  private shouldUseLangGraphEngine(): boolean {
    if (this.config.executionEngine === 'langgraph') {
      return true;
    }
    return this.config.langGraph?.enabled ?? false;
  }

  private getMaxRecoveryAttempts(): number {
    return this.config.maxRecoveryAttempts ?? this.config.langGraph?.maxRecoveryAttempts ?? 2;
  }

  private createRecoveryFingerprint(errors: Array<{ step: ExecutionStep; error: string }>): string {
    return errors
      .map(({ step, error }) => {
        const target =
          typeof step.params.path === 'string'
            ? step.params.path
            : typeof step.params.command === 'string'
              ? step.params.command
              : '';
        const normalizedError = error
          .replace(/:\d+:\d+/g, '')
          .replace(/\bline\s+\d+\b/gi, 'line')
          .replace(/\s+/g, ' ')
          .trim();
        return `${step.action}|${step.tool}|${target}|${normalizedError}`;
      })
      .sort()
      .join('\n');
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    throw new Error(typeof reason === 'string' ? reason : 'FrontAgent run cancelled');
  }

  private async executeSinglePhaseWithRecovery(
    phaseGroup: PhaseExecutionGroup,
    context: {
      task: AgentTask;
      collectedContext: ExecutorCollectedContext;
    },
    completedStepIds: Set<string>,
    allResults: ExecutorOutput[],
    onStepStart?: (step: ExecutionStep) => void,
    onStepComplete?: (step: ExecutionStep, output: ExecutorOutput) => void,
    onPhaseStart?: (phase: string, stepCount: number) => void,
    onPhaseError?: (
      phase: string,
      errors: Array<{ step: ExecutionStep; error: string }>,
    ) => Promise<ExecutionStep[]>,
    onPhaseComplete?: (
      phase: string,
      results: ExecutorOutput[],
    ) => Promise<Array<{ step: ExecutionStep; error: string }>>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.phaseRunner.executeSinglePhaseWithRecovery(
      phaseGroup,
      context,
      completedStepIds,
      allResults,
      { onStepStart, onStepComplete, onPhaseStart, onPhaseError, onPhaseComplete, signal },
    );
  }

  async executeStepsWithErrorFeedback(
    steps: ExecutionStep[],
    context: {
      task: AgentTask;
      collectedContext: ExecutorCollectedContext;
    },
    onStepStart?: (step: ExecutionStep) => void,
    onStepComplete?: (step: ExecutionStep, output: ExecutorOutput) => void,
    onPhaseStart?: (phase: string, stepCount: number) => void,
    onPhaseError?: (
      phase: string,
      errors: Array<{ step: ExecutionStep; error: string }>,
    ) => Promise<ExecutionStep[]>,
    onPhaseComplete?: (
      phase: string,
      results: ExecutorOutput[],
    ) => Promise<Array<{ step: ExecutionStep; error: string }>>,
    signal?: AbortSignal,
  ): Promise<ExecutorOutput[]> {
    if (this.shouldUseLangGraphEngine()) {
      if (this.config.debug) {
        console.log('[Executor] Using LangGraph execution engine');
      }
      return executeStepsWithErrorFeedbackViaLangGraph({
        steps,
        context,
        debugWarn: this.debugWarn.bind(this),
        langGraph: this.config.langGraph,
        executeSinglePhaseWithRecovery: (
          phaseGroup,
          executionContext,
          completedStepIds,
          allResults,
          callbacks,
        ) =>
          this.executeSinglePhaseWithRecovery(
            phaseGroup,
            executionContext,
            completedStepIds,
            allResults,
            callbacks.onStepStart,
            callbacks.onStepComplete,
            callbacks.onPhaseStart,
            callbacks.onPhaseError,
            callbacks.onPhaseComplete,
            callbacks.signal,
          ),
        callbacks: {
          onStepStart,
          onStepComplete,
          onPhaseStart,
          onPhaseError,
          onPhaseComplete,
          signal,
        },
      });
    }

    const orderedPhaseGroups = buildOrderedPhaseGroups(steps, this.debugWarn.bind(this));

    const allResults: ExecutorOutput[] = [];
    const completedStepIds = new Set<string>();

    for (const phaseGroup of orderedPhaseGroups) {
      this.throwIfAborted(signal);
      await this.executeSinglePhaseWithRecovery(
        phaseGroup,
        context,
        completedStepIds,
        allResults,
        onStepStart,
        onStepComplete,
        onPhaseStart,
        onPhaseError,
        onPhaseComplete,
        signal,
      );
    }

    return allResults;
  }

  async rollback(snapshotId: string): Promise<{ success: boolean; message: string }> {
    try {
      const result = await this.callTool('rollback', { snapshotId });
      return result as { success: boolean; message: string };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createExecutor(config: ExecutorConfig): Executor {
  return new Executor(config);
}
