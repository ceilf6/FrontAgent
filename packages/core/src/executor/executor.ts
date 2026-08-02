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
import {
  describeWriteFailure,
  readWrittenFile,
  resolvePreWriteVeto,
  resolveWriteOutcome,
  rollbackFailedWrite,
} from './write-outcome.js';
import {
  demoteNonDecidingVerdicts,
  resolveWriteActionContent,
  resolveWriteContent,
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

      // 写入路径只解析这一次，写盘前后共用；技能可能改写 params.path，
      // 两侧各解析一次就会指向不同文件。
      const writePath = (toolParams.path ?? step.params.path) as string | undefined;
      const writeContent = resolveWriteContent(step, toolParams, writePath, context);
      const vetoEnabled = this.config.hallucinationGuard.isCheckEnabled('syntaxValidity');
      // 否决判据先跑：它是纯字符串扫描，而 validateCode 会做文件系统解析
      // （import 检查）。围栏一旦命中就直接 return，没必要为一份不会落盘的内容
      // 白跑一次完整 guard。
      const veto = resolvePreWriteVeto(writeContent, vetoEnabled, Date.now() - startTime);
      if (veto) {
        this.emitValidationFailed('pre_write', veto.validation, step, writeContent?.path);
        if (this.config.debug) {
          console.log(`[Executor] Blocked write before disk: ${veto.output.stepResult.error}`);
        }
        return trace.finish(veto.output);
      }

      const rawContentValidation = await trace.withStage('validate_content', () =>
        writeContent
          ? this.config.hallucinationGuard.validateCode(
              writeContent.content,
              writeContent.language,
              writeContent.path,
            )
          : Promise.resolve<ValidationResult>({ pass: true, results: [] }),
      );

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

      // 一次步骤只读回一次落盘内容，路径也只解析一次：写盘前用的是
      // `toolParams.path ?? step.params.path`（技能可能改写路径），写盘后若改用
      // `step.params.path`，两侧就会指向不同文件——今天的技能都不改写 path，
      // 所以那是个隐性假设而非现存缺陷，但它正是 emitValidationFailed 的
      // resolvedPath 参数存在的理由，不该在同一个函数里自相矛盾。
      const landedPath = writePath;
      const landedContent = WRITE_ACTIONS.includes(step.action)
        ? readWrittenFile(this.config.projectRoot, landedPath)
        : undefined;

      const postValidation = await trace.withStage('validate_after', () =>
        this.validateAfterExecution(step, toolResult, toolParams, {
          path: landedPath,
          landedContent,
          preWriteContentValidation: writeContent
            ? { validation: rawContentValidation, content: writeContent.content }
            : undefined,
        }),
      );

      const outcome = resolveWriteOutcome({
        action: step.action,
        landedPath,
        landedContent,
        // 补丁前的原文，供围栏判据判断「这次写入是否引入了围栏」
        priorContent: landedPath ? context.collectedContext.files.get(landedPath) : undefined,
        landedLanguage: detectLanguage(String(landedPath)) ?? '',
        toolResult,
        postValidation,
        vetoEnabled,
        durationMs: Date.now() - startTime,
      });

      // 发事件与判成败刻意解耦：降级后的判定仍留在 `results` 里（`pass: false`），
      // 只是不再决定步骤成败。emitValidationFailed 自己按「有没有真实检查判失败」
      // 过滤，所以把它挂在 `!pass` 分支里，等于让降级顺手把遥测也一起关掉——
      // #388 要的恰恰是一个能计数的拦截量。消费方必须读 `result.pass` 才能把
      // 「拦下了」与「只是记了一笔」分开。
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
    if (validation.results.some((result) => !result.pass)) {
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
    /**
     * 写盘前已在同一份内容上算出的完整校验结果（含 import 检查）。
     * 有它就直接沿用：内容一模一样，再跑一遍只是重复开销。
     */
    write?: {
      /** 解析后的写入路径与落盘内容，由 executeStep 各读一次后传入 */
      path: string | undefined;
      landedContent: string | undefined;
      preWriteContentValidation?: { validation: ValidationResult; content: string };
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

    if (write?.preWriteContentValidation) {
      // 只有「实际落盘的就是被校验过的那份」才能复用。整文件判定依赖
      // collectedContext.files 的行数快照，而 apply_patch 成功后该 Map 不刷新——
      // 同一计划内二次改同一文件时，工具可能只替换了前 N 行并保留尾部，
      // 落盘内容 ≠ 被校验的 patch.content。不一致就按读回内容重新判。
      if (
        write.landedContent === undefined ||
        write.landedContent === write.preWriteContentValidation.content
      ) {
        // 同样按 action 降级：这份结果是写盘**前**算的，但它现在被当作
        // 写盘**后**的结论用——判据的可信度不因复用而改变。
        return demoteNonDecidingVerdicts(write.preWriteContentValidation.validation, step.action);
      }
    }

    if (WRITE_ACTIONS.includes(step.action)) {
      const path = write?.path;
      // 与写盘前共用同一条分派规则（见 resolveWriteActionContent）。这里补丁内容
      // 来自读回磁盘：真实的 create_file / apply_patch 都不返回 `content`，
      // 局部行补丁也没有 `content` 参数。
      const content = resolveWriteActionContent(step, toolParams, {
        patchContent: () => write?.landedContent,
        resultContent: (result as { content?: string })?.content,
      });

      if (content && path) {
        const language = detectLanguage(path);
        if (language) {
          // 对 `apply_patch` 这次调用是**纯遥测**：validateCode 只产出
          // syntax_validity 与 import_validity，而 NON_DECIDING_CHECKS 把两者都
          // 降级了，所以它决定不了这个动作的成败。保留是因为遥测本身是目标
          // （#388 要一个能计数的量），代价是每个 modify 步骤多一次整文件的
          // import 解析。不在这里按 ablation 短路：guard 内部本就跳过被禁用的
          // 检查，而写盘前那次 validateCode 也是无条件调用的——只在一侧短路会让
          // 读者以为两条路径的 ablation 行为不同。
          const codeValidation = await this.config.hallucinationGuard.validateCode(
            content,
            language,
            path,
          );
          return demoteNonDecidingVerdicts(codeValidation, step.action);
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
