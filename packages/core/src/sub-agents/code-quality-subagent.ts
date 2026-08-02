/**
 * Code Quality SubAgent
 * Uses A2A protocol for generated code quality evaluation
 * LLM review first, rule-based checks as fallback
 */

import type { SDDConfig } from '@frontagent/shared';
import { generateId, logger } from '@frontagent/shared';
import { z } from 'zod';
import type { A2AAgent, A2ARequest, A2AResponse } from '../a2a.js';
import type { LLMService } from '../llm.js';
import type { ProjectFactsSnapshot, ProjectFactsUpdate } from '../types.js';
import { buildCodeQualityLlmReviewPrompt } from './code-quality-prompt.js';

export interface CodeQualityReviewFile {
  path: string;
  content: string;
}

export interface CodeQualityIssue {
  severity: 'error' | 'warning';
  filePath: string;
  line?: number;
  rule: string;
  message: string;
  suggestion?: string;
}

export interface CodeQualityReviewRequest {
  taskId: string;
  phase: string;
  files: CodeQualityReviewFile[];
  sddConfig?: SDDConfig;
  sharedFacts?: ProjectFactsSnapshot;
}

export interface CodeQualityReviewResponse {
  passed: boolean;
  score: number;
  summary: string;
  issues: CodeQualityIssue[];
  factUpdates?: ProjectFactsUpdate;
  /**
   * LLM 评审未跑成（超时或调用失败），本次结果只来自规则评审。
   * `passed`/`score` 在这种情况下照常是「干净的成功」——没有这个字段，
   * 消费方无从区分「LLM 评审通过」与「LLM 评审压根没跑」（#407 建议 3）。
   */
  llmReviewDegraded?: boolean;
}

export interface CodeQualitySubAgentOptions {
  llmService?: LLMService;
  enableRuleFallback?: boolean;
  maxFilesForLLM?: number;
  maxCharsPerFileForLLM?: number;
  /**
   * LLM 评审调用的时间上界（毫秒）。**缺省不设上界**——这是有意的：
   * 进程隔离分支的上界由父进程的 SIGKILL 提供，worker 内部再叠一层默认值，
   * 会让调用方设置的 `processTimeoutMs > 默认值` 时由 worker 先超时并
   * 静默返回一份 rule-only 的成功响应，父进程的上界形同虚设。
   * 只有没有进程边界可杀的 in_memory 分支才由 `agent.ts` 显式传入上界。
   *
   * 两条边界要说清楚：
   * - 超时只让调用方停止等待，**不取消在途请求**（`LLMService` 无 AbortSignal 接口），
   *   backend 可能继续消耗 token。
   * - 只约束 LLM 调用。规则评审是同步的，`Promise.race` 抢占不了同步代码，
   *   所以病态正则或 OOM 在 in_memory 下没有任何边界——那是 process 分支
   *   SIGKILL 独有的保障，降级后确实失去了。
   */
  reviewTimeoutMs?: number;
  debug?: boolean;
}

export class CodeQualitySubAgent
  implements A2AAgent<CodeQualityReviewRequest, CodeQualityReviewResponse>
{
  // a2a 协议中 Id
  readonly agentId = 'subagent.code-quality';
  // 角色扮演
  readonly capabilities = ['code_quality.review_generated_files'];

  // === 配置区
  // First split extracts LLM prompt policy; rule fallback policy remains local.
  private readonly llmService?: LLMService; // 启动LLM评估
  private readonly enableRuleFallback: boolean; // 规则函数检查
  private readonly maxFilesForLLM: number; // LLM评估最多文件数
  private readonly maxCharsPerFileForLLM: number; // 上下文上限
  private readonly reviewTimeoutMs?: number; // LLM 评审时间上界；undefined = 不设上界
  private readonly debug: boolean; // 失败日志

  constructor(options: CodeQualitySubAgentOptions = {}) {
    this.llmService = options.llmService;
    this.enableRuleFallback = options.enableRuleFallback ?? true;
    this.maxFilesForLLM = options.maxFilesForLLM ?? 6;
    this.maxCharsPerFileForLLM = options.maxCharsPerFileForLLM ?? 12000;
    this.reviewTimeoutMs = options.reviewTimeoutMs;
    this.debug = options.debug ?? false;
  }

  async handleRequest(
    request: A2ARequest<CodeQualityReviewRequest>,
  ): Promise<A2AResponse<CodeQualityReviewResponse>> {
    if (request.intent !== 'code_quality.review_generated_files') {
      return this.errorResponse(request, `Unsupported intent: ${request.intent}`);
    }

    const payload = request.payload;
    if (!payload || !Array.isArray(payload.files)) {
      return this.errorResponse(request, 'Invalid request payload: files is required');
    }

    const ruleIssues: CodeQualityIssue[] = [];
    if (this.enableRuleFallback) {
      for (const file of payload.files) {
        ruleIssues.push(...this.evaluateFile(file, payload.sddConfig));
      }
    }

    let llmIssues: CodeQualityIssue[] = [];
    let llmSummary: string | undefined;
    let llmReviewFailed = false;

    if (this.llmService) {
      try {
        const llmReview = await this.withReviewTimeout(this.evaluateWithLLM(payload));
        llmIssues = llmReview.issues;
        llmSummary = llmReview.summary;
        llmReviewFailed = false;
      } catch (error) {
        // 无条件上报：静默退回规则评审正是 #407 描述的失能形态——
        // 调用方会拿到一份 success/score 100 的 rule-only 结果而毫无信号。
        // debug 只控制是否附带完整错误详情。
        llmReviewFailed = true;
        logger.warn(
          `[CodeQualitySubAgent] LLM review unavailable, falling back to the rule review: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (this.debug) {
          console.warn('[CodeQualitySubAgent] LLM review failure detail:', error);
        }
      }
    }

    const issues = this.mergeIssues(llmIssues, ruleIssues);

    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
    const score = Math.max(0, 100 - errorCount * 20 - warningCount * 5);

    // 日志给人看，`llmReviewDegraded` 给消费方判定，summary 两者都照顾到。
    const degraded = llmReviewFailed ? ' [LLM review unavailable — rule-only result]' : '';
    const summary = llmSummary
      ? `${llmSummary} (merged with ${ruleIssues.length} rule issue(s))`
      : `CodeQualitySubAgent reviewed ${payload.files.length} file(s): ${errorCount} error(s), ${warningCount} warning(s), score ${score}/100.${degraded}`;

    const review: CodeQualityReviewResponse = {
      passed: errorCount === 0,
      score,
      summary,
      issues,
      factUpdates: this.buildFactUpdates(payload, issues),
      llmReviewDegraded: llmReviewFailed || undefined,
    };

    return {
      protocol: 'A2A',
      version: '1.0',
      kind: 'response',
      messageId: generateId('a2a-res'),
      inReplyTo: request.messageId,
      timestamp: Date.now(),
      from: this.agentId,
      to: request.from,
      intent: request.intent,
      success: true,
      payload: review,
    };
  }

  /**
   * 给 LLM 评审加时间上界。超时不中断底层请求（LLMService 无 AbortSignal 接口），
   * 但让调用方停止等待并落到规则评审——in_memory 分支没有进程可杀，这是唯一的兜底位。
   * 未配置上界时原样透传，不引入第二层竞速。
   */
  private async withReviewTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.reviewTimeoutMs;
    if (timeoutMs === undefined) return promise;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`LLM review timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async evaluateWithLLM(
    payload: CodeQualityReviewRequest,
  ): Promise<{ summary: string; issues: CodeQualityIssue[] }> {
    if (!this.llmService) {
      return { summary: 'LLM review disabled.', issues: [] };
    }

    const reviewSchema = z.object({
      summary: z.string(),
      issues: z.array(
        z.object({
          severity: z.enum(['error', 'warning']),
          filePath: z.string(),
          line: z.number().int().positive().optional(),
          rule: z.string(),
          message: z.string(),
          suggestion: z.string().optional(),
        }),
      ),
    });

    const prompt = buildCodeQualityLlmReviewPrompt(payload, {
      maxFilesForLLM: this.maxFilesForLLM,
      maxCharsPerFileForLLM: this.maxCharsPerFileForLLM,
    });

    const llmResult = await this.llmService.generateObject({
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.userPrompt }],
      schema: reviewSchema,
      temperature: 0.1,
      maxTokens: 3000,
    });

    return {
      summary: llmResult.summary,
      issues: llmResult.issues.map((issue) => ({
        severity: issue.severity,
        filePath: issue.filePath,
        line: issue.line,
        rule: issue.rule,
        message: issue.message,
        suggestion: issue.suggestion,
      })),
    };
  }

  private evaluateFile(file: CodeQualityReviewFile, sddConfig?: SDDConfig): CodeQualityIssue[] {
    const issues: CodeQualityIssue[] = [];
    const lines = file.content.split('\n');

    const maxFileLines = sddConfig?.codeQuality.maxFileLines ?? 400;
    const maxFunctionLines = sddConfig?.codeQuality.maxFunctionLines ?? 80;
    const maxParameters = sddConfig?.codeQuality.maxParameters ?? 5;
    const forbiddenPatterns = sddConfig?.codeQuality.forbiddenPatterns ?? [];

    if (lines.length > maxFileLines) {
      issues.push({
        severity: 'warning',
        filePath: file.path,
        rule: 'max_file_lines',
        message: `File has ${lines.length} lines, exceeds limit ${maxFileLines}.`,
        suggestion: 'Split file into smaller modules.',
      });
    }

    for (const pattern of forbiddenPatterns) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        continue;
      }

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          issues.push({
            severity: 'error',
            filePath: file.path,
            line: i + 1,
            rule: 'forbidden_pattern',
            message: `Forbidden pattern "${pattern}" found.`,
            suggestion: 'Remove or replace this pattern.',
          });
        }
        regex.lastIndex = 0;
      }
    }

    const candidates = this.extractFunctionCandidates(file.content);
    for (const fn of candidates) {
      if (fn.parameterCount > maxParameters) {
        issues.push({
          severity: 'warning',
          filePath: file.path,
          line: fn.line,
          rule: 'max_parameters',
          message: `Function "${fn.name}" has ${fn.parameterCount} parameters, exceeds limit ${maxParameters}.`,
          suggestion: 'Use an options object or split responsibilities.',
        });
      }

      const estimatedLines = this.estimateFunctionBodyLines(lines, fn.line);
      if (estimatedLines !== null && estimatedLines > maxFunctionLines) {
        issues.push({
          severity: 'warning',
          filePath: file.path,
          line: fn.line,
          rule: 'max_function_lines',
          message: `Function "${fn.name}" has ${estimatedLines} lines, exceeds limit ${maxFunctionLines}.`,
          suggestion: 'Extract helper functions to reduce complexity.',
        });
      }
    }

    return issues;
  }

  private buildFactUpdates(
    payload: CodeQualityReviewRequest,
    issues: CodeQualityIssue[],
  ): ProjectFactsUpdate | undefined {
    const sharedFacts = payload.sharedFacts;
    if (!sharedFacts) {
      return undefined;
    }

    const installedPackages = new Set(sharedFacts.dependencies.installedPackages);
    const knownMissingPackages = new Set(sharedFacts.dependencies.missingPackages);

    const usedExternalPackages = this.collectExternalPackages(payload.files);
    const detectedMissingPackages: string[] = [];

    for (const pkg of usedExternalPackages) {
      if (!installedPackages.has(pkg) && !knownMissingPackages.has(pkg)) {
        detectedMissingPackages.push(pkg);
      }
    }

    const blockingIssues = issues
      .filter((issue) => issue.severity === 'error')
      .slice(0, 10)
      .map((issue) => ({
        stepId: `subagent-code-quality:${payload.phase}`,
        type: 'code_quality',
        message: `${issue.filePath}${issue.line ? `:${issue.line}` : ''} [${issue.rule}] ${issue.message}`,
        timestamp: Date.now(),
      }));

    const hasChanges = detectedMissingPackages.length > 0 || blockingIssues.length > 0;

    if (!hasChanges) {
      return undefined;
    }

    return {
      baseRevision: sharedFacts.revision,
      source: this.agentId,
      timestamp: Date.now(),
      changes: {
        addMissingPackages: detectedMissingPackages,
        addErrors: blockingIssues,
      },
    };
  }

  private collectExternalPackages(files: CodeQualityReviewFile[]): string[] {
    const packages = new Set<string>();
    const importRegex = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const file of files) {
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(file.content)) !== null) {
        const maybePackage = this.normalizeExternalPackageName(match[1]);
        if (maybePackage) {
          packages.add(maybePackage);
        }
      }
      importRegex.lastIndex = 0;

      while ((match = requireRegex.exec(file.content)) !== null) {
        const maybePackage = this.normalizeExternalPackageName(match[1]);
        if (maybePackage) {
          packages.add(maybePackage);
        }
      }
      requireRegex.lastIndex = 0;
    }

    return Array.from(packages);
  }

  private normalizeExternalPackageName(specifier: string): string | null {
    if (
      !specifier ||
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('@/')
    ) {
      return null;
    }

    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
      return specifier;
    }

    return specifier.split('/')[0];
  }

  private mergeIssues(
    primary: CodeQualityIssue[],
    secondary: CodeQualityIssue[],
  ): CodeQualityIssue[] {
    const result: CodeQualityIssue[] = [];
    const seen = new Set<string>();

    for (const issue of [...primary, ...secondary]) {
      const key = `${issue.severity}|${issue.filePath}|${issue.line ?? 0}|${issue.rule}|${issue.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(issue);
    }

    return result;
  }

  private extractFunctionCandidates(content: string): Array<{
    name: string;
    line: number;
    parameterCount: number;
  }> {
    const candidates: Array<{
      name: string;
      line: number;
      parameterCount: number;
    }> = [];

    const functionDeclarationRegex =
      /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)\s*\{/gm;
    const arrowFunctionRegex =
      /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{/gm;

    let match: RegExpExecArray | null;
    while ((match = functionDeclarationRegex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      candidates.push({
        name: match[1] || 'anonymous',
        line,
        parameterCount: this.countParameters(match[2] || ''),
      });
    }

    while ((match = arrowFunctionRegex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      candidates.push({
        name: match[1] || 'anonymous',
        line,
        parameterCount: this.countParameters(match[2] || match[3] || ''),
      });
    }

    return candidates;
  }

  private countParameters(paramText: string): number {
    const cleaned = paramText.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!cleaned) {
      return 0;
    }

    return cleaned
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean).length;
  }

  private estimateFunctionBodyLines(lines: string[], startLine: number): number | null {
    const startIndex = startLine - 1;
    if (startIndex < 0 || startIndex >= lines.length) {
      return null;
    }

    let started = false;
    let depth = 0;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        if (ch === '{') {
          depth++;
          started = true;
        } else if (ch === '}') {
          depth--;
          if (started && depth === 0) {
            return i + 1 - startLine + 1;
          }
        }
      }
    }

    return null;
  }

  private errorResponse(
    request: A2ARequest<CodeQualityReviewRequest>,
    message: string,
  ): A2AResponse<CodeQualityReviewResponse> {
    return {
      protocol: 'A2A',
      version: '1.0',
      kind: 'response',
      messageId: generateId('a2a-res'),
      inReplyTo: request.messageId,
      timestamp: Date.now(),
      from: this.agentId,
      to: request.from,
      intent: request.intent,
      success: false,
      error: message,
    };
  }
}
