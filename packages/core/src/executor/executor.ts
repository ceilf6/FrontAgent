import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentTask, ExecutionStep, ValidationResult } from '@frontagent/shared';
import { logger } from '@frontagent/shared';
import { groundStepPath } from '../filesense/path-grounding.js';
import {
  createDefaultExecutorSkillRegistry,
  type ExecutorActionSkill,
  type ExecutorSkillsLayerSnapshot,
} from '../skills/index.js';
import type { ExecutorOutput } from '../types.js';
import { buildOrderedPhaseGroups, detectLanguage } from './phase-ordering.js';
import { PhaseRunner, type StepExecutionOptions } from './phase-runner.js';
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
import {
  describeWriteFailure,
  readWrittenFile,
  resolveWriteOutcome,
  rollbackFailedWrite,
} from './write-outcome.js';
import { validateWriteBeforeExecution } from './write-preflight.js';
import {
  demoteNonDecidingVerdicts,
  resolveWriteActionContent,
  WRITE_ACTIONS,
} from './write-validation.js';

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
      executeStep: (step, ctx, options) => this.executeStep(step, ctx, options),
      debugLog: (...args) => this.debugLog(...args),
      debugWarn: (...args) => this.debugWarn(...args),
      debugError: (...args) => this.debugError(...args),
      throwIfAborted: (signal) => this.throwIfAborted(signal),
      getMaxRecoveryAttempts: () => this.getMaxRecoveryAttempts(),
      createRecoveryFingerprint: (errors) => this.createRecoveryFingerprint(errors),
      getWriteTarget: (step) => this.getWriteTarget(step),
      parallelExecution: Boolean(config.parallelExecution),
    });
  }

  private getWriteTarget(step: ExecutionStep): string | undefined {
    if (step.action !== 'create_file' && step.action !== 'apply_patch') return undefined;
    const path = typeof step.params.path === 'string' ? step.params.path : undefined;
    return path ? resolve(this.config.projectRoot, path) : undefined;
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
    options: StepExecutionOptions = {},
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

      // 路径接地必须发生在前置校验**之前**（#434 评审意见）。
      //
      // 幻觉 `read_file` 会被 `validateBeforeExecution` 里的 fileExistence 检查
      // 判为 "does not exist"，随后 `getPreValidationSkip` 把整步 skip 掉并提前
      // 返回——接地放在其后就永远执行不到，恰好在它唯一该起作用的那类步骤上失效。
      // （这条 skip 分支返回 `success: true`，也正是 #432 里「幻觉步骤 ok 恒为 true」
      // 的来源。）
      //
      // 就地改写 `step.params` 而不是只改一份副本：后续的校验、apply_patch 的
      // auto-read、prepareToolParams 都读 `step.params`，只改副本会让它们各看各的路径。
      this.groundStepPathInPlace(step);

      const preValidation = await trace.withStage('validate_before', () =>
        this.validateBeforeExecution(step, context, options),
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
        this.emitValidationFailed('pre_execution', preValidation, step);
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

      let toolParams: Record<string, unknown> = {
        ...step.params,
        ...(['create_file', 'apply_patch'].includes(step.action)
          ? {
              __frontagentSyntaxValidationEnabled:
                this.config.hallucinationGuard.isCheckEnabled('syntaxValidity'),
            }
          : {}),
      };

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

      const writePath = (toolParams.path ?? step.params.path) as string | undefined;
      const dryRun = step.action === 'apply_patch' && toolParams.dryRun === true;
      const vetoEnabled =
        WRITE_ACTIONS.includes(step.action) &&
        this.config.hallucinationGuard.isCheckEnabled('syntaxValidity') &&
        toolParams.skipSyntaxValidation !== true;
      const preflight = await validateWriteBeforeExecution(
        this.config.hallucinationGuard,
        step,
        toolParams,
        context.collectedContext.files,
      );
      if (preflight) {
        if (!preflight.validation.pass) {
          this.emitValidationFailed('pre_write', preflight.validation, step, preflight.path);
          const errorMsg = preflight.validation.blockedBy?.join('; ') || 'Invalid write content';
          return trace.finish({
            stepResult: {
              success: false,
              error: `Pre-write validation failed: ${errorMsg}`,
              duration: Date.now() - startTime,
            },
            validation: preflight.validation,
            needsRollback: true,
          });
        }
        toolParams = preflight.toolParams;
      }

      const sddValidation =
        preflight && !dryRun
          ? await this.config.hallucinationGuard.validateSDDCompliance({
              action: step.action,
              targetPath: preflight.path,
              content: preflight.content,
            })
          : undefined;
      if (sddValidation && !sddValidation.pass) {
        this.emitValidationFailed('pre_write', sddValidation, step, preflight?.path);
        return trace.finish({
          stepResult: {
            success: false,
            error: `Pre-write validation failed: ${sddValidation.blockedBy?.join('; ')}`,
            duration: Date.now() - startTime,
          },
          validation: sddValidation,
          needsRollback: true,
        });
      }

      const toolResult = await trace.withStage('call_tool', () =>
        this.callTool(step.tool, toolParams),
      );

      if (typeof toolResult === 'object' && toolResult !== null) {
        const resultObj = toolResult as {
          success?: boolean;
          error?: string;
          errorCode?: string;
        };
        if (resultObj.success === false && resultObj.error) {
          if (resultObj.errorCode === 'stale_original_hash') {
            await this.refreshCollectedFileContext(
              (toolParams as Record<string, unknown>).path,
              context,
            );
          }
          const isSkippableError = this.isSkippableError(
            resultObj.error,
            step,
            toolParams,
            resultObj.errorCode,
          );
          if (isSkippableError) {
            if (this.config.debug) {
              console.log(`[Executor] Skipping step due to tool error: ${resultObj.error}`);
            }
            return trace.finish(this.buildSkippedStepOutput(resultObj.error, startTime));
          }
        }
      }

      // Read back once so validation and rollback describe the same disk content.
      const landedPath = writePath;
      const landedContent =
        !dryRun && WRITE_ACTIONS.includes(step.action)
          ? readWrittenFile(this.config.projectRoot, landedPath)
          : undefined;

      const postValidation = await trace.withStage('validate_after', () =>
        this.validateAfterExecution(step, toolResult, toolParams, {
          path: landedPath,
          landedContent,
          preflightContent: preflight?.content,
          sddValidation,
        }),
      );

      const outcome = resolveWriteOutcome({
        action: step.action,
        landedPath,
        landedContent,
        priorContent: landedPath ? context.collectedContext.files.get(landedPath) : undefined,
        toolResult,
        postValidation,
        vetoEnabled: vetoEnabled && !dryRun,
        durationMs: Date.now() - startTime,
      });

      this.emitValidationFailed('post_write', outcome.validation, step, landedPath);

      if (outcome.unreadablePath) {
        this.debugWarn(
          `[Executor] Could not read back ${outcome.unreadablePath} after the write; rollback was not attempted.`,
        );
      }
      const rollbackOutcome = outcome.rollback
        ? await rollbackFailedWrite(toolResult, {
            rollback: (snapshotId) => this.rollback(snapshotId),
            emitEvent: this.config.emitEvent,
            warn: (message) => this.debugWarn(message),
          })
        : { rollbackFailed: false as boolean, error: undefined as string | undefined };

      if (writePath && WRITE_ACTIONS.includes(step.action) && !dryRun) {
        if (outcome.stepResult.success && landedContent !== undefined) {
          context.collectedContext.files.set(writePath, landedContent);
        } else if (outcome.stepResult.success && preflight) {
          context.collectedContext.files.set(writePath, preflight.content);
        } else {
          context.collectedContext.files.delete(writePath);
        }
      }

      return trace.finish({
        stepResult: {
          ...outcome.stepResult,
          error: describeWriteFailure(
            outcome.stepResult.error,
            rollbackOutcome,
            outcome.unreadablePath,
          ),
        },
        validation: outcome.validation,
        needsRollback: outcome.needsRollback,
        rollbackFailed: rollbackOutcome.rollbackFailed,
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

  private async refreshCollectedFileContext(
    pathValue: unknown,
    context: { task: AgentTask; collectedContext: ExecutorCollectedContext },
  ): Promise<void> {
    if (typeof pathValue !== 'string') return;
    context.collectedContext.files.delete(pathValue);
    try {
      const readResult = (await this.callTool('read_file', { path: pathValue })) as {
        success?: boolean;
        content?: string;
      };
      if (readResult.success && typeof readResult.content === 'string') {
        context.collectedContext.files.set(pathValue, readResult.content);
      }
    } catch {
      // Leave the entry absent so recovery cannot reuse stale content.
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
    errorCode?: string,
  ): boolean {
    const skillDecision = this.actionSkills.shouldSkipToolError({
      errorMsg,
      errorCode,
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
    options: StepExecutionOptions = {},
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

      {
        const cachedContent = context.collectedContext.files.get(path);
        this.debugLog(`[Executor] 📖 Refreshing ${path} before apply_patch...`);

        try {
          const readResult = (await this.callTool('read_file', { path })) as {
            success: boolean;
            content?: string;
            error?: string;
          };

          if (readResult.success && readResult.content !== undefined) {
            context.collectedContext.files.set(path, readResult.content);
            if (
              Array.isArray(step.params.patches) &&
              ((options.deferredSameTargetWrite &&
                (options.deferredOriginalContent === undefined ||
                  options.deferredOriginalContent !== readResult.content)) ||
                (!options.deferredSameTargetWrite &&
                  cachedContent !== undefined &&
                  cachedContent !== readResult.content))
            ) {
              const message = `Cannot apply explicit patches: ${path} changed after its patch context was collected`;
              return {
                pass: false,
                results: [
                  {
                    pass: false,
                    type: 'stale_patch_context',
                    severity: 'block',
                    message,
                  },
                ],
                blockedBy: [message],
              };
            }
            this.debugLog(
              `[Executor] ✅ Refreshed file ${path} (${readResult.content.length} chars) into context`,
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
   * 用导航枚举出的真实目录清单校正步骤路径，**就地改写 `step.params`**（#434）。
   *
   * 就地而不是返回副本：后续的前置校验、`apply_patch` 的 auto-read、
   * `prepareToolParams` 全都读 `step.params`，只改副本会让它们各看各的路径。
   *
   * 拒绝的情形也要发事件。只统计成功校正会让「接地覆盖率」读成 100%，
   * 而被拒绝的那部分正是这套启发式的能力边界——那才是下一轮该改的东西。
   */
  private groundStepPathInPlace(step: ExecutionStep): void {
    const path = step.params.path;
    if (typeof path !== 'string' || !path) return;

    const facts = this.config.getFileSystemFacts?.();
    if (!facts) return;

    const outcome = groundStepPath(path, step.action, facts);

    if (outcome.corrected) {
      const { from, to, score, candidateCount } = outcome.corrected;
      this.debugLog(`[Executor] 🧭 路径接地：${from} → ${to}（相似度 ${score}）`);
      step.params.path = to;
      this.config.emitEvent?.({
        type: 'filesense_path_grounded',
        outcome: 'corrected',
        stepId: step.stepId,
        action: step.action,
        from,
        to,
        score,
        candidateCount,
      });
      return;
    }

    if (outcome.declined) {
      this.debugLog(
        `[Executor] 🧭 路径接地放弃：${outcome.declined.path}（${outcome.declined.reason}）`,
      );
      this.config.emitEvent?.({
        type: 'filesense_path_grounded',
        outcome: 'declined',
        stepId: step.stepId,
        action: step.action,
        from: outcome.declined.path,
        reason: outcome.declined.reason,
        candidateCount: outcome.declined.candidates.length,
      });
    }
  }

  /**
   * 只有「至少一项真实检查判定失败」才算校验拦截。
   * `validateAfterExecution` 在工具自身报错时返回 results 为空的失败结果——
   * 那是工具失败，不是拦截；两者混在同一事件里，`validation_failed`
   * 就不能当拦截数用，而 #388 要的正是一个能计数的拦截量。
   */
  private emitValidationFailed(
    stage: 'pre_execution' | 'pre_write' | 'post_write',
    validation: ValidationResult,
    step: ExecutionStep,
    /** 已解析的写入路径；技能可能改写过 step.params.path */
    resolvedPath?: string,
  ): void {
    if (
      validation.results.some(
        (result) =>
          !result.pass && (result.type !== 'sdd_compliance' || result.severity === 'block'),
      )
    ) {
      this.config.emitEvent?.({
        type: 'validation_failed',
        stage,
        result: validation,
        path: resolvedPath ?? (step.params.path as string | undefined),
        stepId: step.stepId,
      });
    }
  }

  private async validateAfterExecution(
    step: ExecutionStep,
    result: unknown,
    toolParams?: Record<string, unknown>,
    write?: {
      path: string | undefined;
      landedContent: string | undefined;
      preflightContent?: string;
      sddValidation?: ValidationResult;
    },
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

    if (toolParams?.dryRun === true) return { pass: true, results: [] };
    if (WRITE_ACTIONS.includes(step.action)) {
      const path = write?.path;
      const content = resolveWriteActionContent(step, toolParams, {
        landedContent: write?.landedContent,
        patchContent: () => write?.preflightContent,
        resultContent: (result as { content?: string })?.content,
      });
      if (typeof content === 'string' && path) {
        const sddValidation =
          content === write?.preflightContent && write.sddValidation
            ? write.sddValidation
            : await this.config.hallucinationGuard.validateSDDCompliance({
                action: step.action,
                targetPath: path,
                content,
              });
        const validations = [sddValidation];
        const language = detectLanguage(path);
        if (language === 'typescript' || language === 'javascript') {
          const validation = await this.config.hallucinationGuard.validateImports(content, path);
          validations.push(demoteNonDecidingVerdicts(validation, step.action));
        }
        const blockedBy = validations.flatMap((validation) => validation.blockedBy ?? []);
        const warnings = validations.flatMap((validation) => validation.warnings ?? []);
        return {
          pass: validations.every((validation) => validation.pass),
          results: validations.flatMap((validation) => validation.results),
          blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
    }
    return { pass: true, results: [] };
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

  /**
   * 撤销一次快照。返回形状在此归一化：工具成功时给 `message`，
   * 而安全层拒绝时给的是 `{ success:false, error }`（`tool-call-handler.ts`）——
   * 声明成必有 `message` 会让每个调用方各自 cast 一次去捞 `error`。
   */
  async rollback(snapshotId: string): Promise<{ success: boolean; message: string }> {
    try {
      const result = (await this.callTool('rollback', { snapshotId })) as {
        success?: boolean;
        message?: string;
        error?: string;
      };
      return {
        success: Boolean(result?.success),
        message: result?.message ?? result?.error ?? 'rollback returned no message',
      };
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
