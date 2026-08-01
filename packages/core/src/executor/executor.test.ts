import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HallucinationGuard } from '@frontagent/hallucination-guard';
import type { AgentTask, ExecutionStep } from '@frontagent/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorActionSkill } from '../skills/index.js';
import type { AgentEvent } from '../types.js';
import { createExecutor, Executor } from './executor.js';
import { ExecutorToolCallHandler } from './tool-call-handler.js';
import type { ExecutorCollectedContext, ExecutorConfig } from './types.js';

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    stepId: 'step-1',
    description: 'Test step',
    action: 'create_file',
    tool: 'create_file',
    params: { path: 'src/a.ts', content: 'export {}' },
    dependencies: [],
    validation: [],
    status: 'pending',
    phase: 'build',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    projectRoot: '/test',
    hallucinationGuard: {
      validateFilePath: vi.fn(),
      validateCode: vi.fn(),
    } as unknown as ExecutorConfig['hallucinationGuard'],
    llmService: {
      name: 'test',
      generateText: vi.fn(),
      generateObject: vi.fn(),
    } as unknown as ExecutorConfig['llmService'],
    ...overrides,
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 't1',
    type: 'create',
    description: 'test',
    ...overrides,
  };
}

function makeCollectedContext(
  overrides: Partial<ExecutorCollectedContext> = {},
): ExecutorCollectedContext {
  return {
    files: new Map(),
    ...overrides,
  };
}

function makeExecutionContext(
  overrides: {
    task?: Partial<AgentTask>;
    collectedContext?: Partial<ExecutorCollectedContext>;
  } = {},
): {
  task: AgentTask;
  collectedContext: ExecutorCollectedContext;
} {
  return {
    task: makeTask(overrides.task),
    collectedContext: makeCollectedContext(overrides.collectedContext),
  };
}

describe('Executor', () => {
  describe('constructor', () => {
    it('creates executor with config', () => {
      const executor = new Executor(makeConfig({ debug: true }));
      expect(executor).toBeDefined();
    });

    it('creates executor with parallel execution', () => {
      const executor = new Executor(makeConfig({ parallelExecution: true }));
      expect(executor).toBeDefined();
    });

    it('creates executor with langgraph config', () => {
      const executor = new Executor(
        makeConfig({
          executionEngine: 'langgraph',
          langGraph: { enabled: true, maxRecoveryAttempts: 5 },
        }),
      );
      expect(executor).toBeDefined();
    });
  });

  describe('registerMCPClient', () => {
    it('registers an MCP client', () => {
      const executor = new Executor(makeConfig());
      const client = {
        callTool: vi.fn().mockResolvedValue({}),
        listTools: vi.fn().mockResolvedValue([]),
      };
      executor.registerMCPClient('test-client', client);
    });
  });

  describe('registerToolMapping', () => {
    it('registers a tool mapping', () => {
      const executor = new Executor(makeConfig());
      executor.registerToolMapping('my-tool', 'test-client');
    });
  });

  describe('registerActionSkill', () => {
    it('registers an action skill', () => {
      const executor = new Executor(makeConfig());
      const skill = {
        name: 'test-skill',
        action: 'read_file',
      } satisfies ExecutorActionSkill;
      executor.registerActionSkill(skill);
      const snapshot = executor.getActionSkillSnapshot();
      expect(snapshot.actionSkills.length).toBeGreaterThan(0);
    });
  });

  describe('callTool', () => {
    it('passes approved security args to the MCP client and emits ask then allow decisions', async () => {
      const approvalHandler = vi.fn().mockResolvedValue(true);
      const decisions: Array<{ decision: string; reasonCode: string; approvalId?: string }> = [];
      const callTool = vi.fn().mockResolvedValue({ success: true });
      const executor = new Executor(
        makeConfig({
          security: { mode: 'strict', interactive: true, auditEnabled: true },
          approvalHandler,
          onSecurityDecision: (decision) => decisions.push(decision),
        }),
      );
      executor.registerMCPClient('files', {
        callTool,
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('create_file', 'files');

      const result = await executor.callTool('create_file', {
        path: 'src/new.ts',
        content: 'export {}',
      });

      expect(result).toEqual(expect.objectContaining({ success: true }));
      expect(approvalHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'ask',
          reasonCode: 'strict_file_write_requires_approval',
          toolName: 'create_file',
        }),
      );
      expect(callTool).toHaveBeenCalledWith(
        'create_file',
        expect.objectContaining({
          path: 'src/new.ts',
          content: 'export {}',
          __frontagentSecurityApproved: true,
        }),
      );
      expect(decisions.map((decision) => decision.decision)).toEqual(['ask', 'allow']);
      expect(decisions[1]).toEqual(
        expect.objectContaining({
          reasonCode: 'approved_by_user',
          approvalId: expect.any(String),
        }),
      );
    });

    it('fails closed without invoking the MCP client when approval is unavailable', async () => {
      const decisions: Array<{ decision: string; reasonCode: string }> = [];
      const callTool = vi.fn().mockResolvedValue({ success: true });
      const executor = new Executor(
        makeConfig({
          security: { mode: 'strict', interactive: false, auditEnabled: true },
          onSecurityDecision: (decision) => decisions.push(decision),
        }),
      );
      executor.registerMCPClient('files', {
        callTool,
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('create_file', 'files');

      const result = await executor.callTool('create_file', {
        path: 'src/new.ts',
        content: 'export {}',
      });

      expect(result).toEqual({
        success: false,
        error: 'Approval is required but no interactive approval channel is available.',
      });
      expect(callTool).not.toHaveBeenCalled();
      expect(decisions).toEqual([
        expect.objectContaining({
          decision: 'ask',
          reasonCode: 'strict_file_write_requires_approval',
        }),
        expect.objectContaining({
          decision: 'deny',
          reasonCode: 'security_approval_unavailable',
        }),
      ]);
    });

    it('updates browser context only after successful navigation results', async () => {
      const callTool = vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: 'navigation failed' })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true });
      const executor = new Executor(
        makeConfig({
          security: { mode: 'balanced', interactive: false, auditEnabled: true },
        }),
      );
      executor.registerMCPClient('browser', {
        callTool,
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('browser_navigate', 'browser');
      executor.registerToolMapping('browser_click', 'browser');

      const failedNavigate = await executor.callTool('browser_navigate', {
        url: 'http://localhost:5173',
      });
      const clickAfterFailure = await executor.callTool('browser_click', { selector: '#submit' });
      const successfulNavigate = await executor.callTool('browser_navigate', {
        url: 'http://localhost:5173',
      });
      const clickAfterSuccess = await executor.callTool('browser_click', { selector: '#submit' });

      expect(failedNavigate).toEqual(expect.objectContaining({ success: false }));
      expect(clickAfterFailure).toEqual(
        expect.objectContaining({
          success: false,
          error: 'Approval is required but no interactive approval channel is available.',
        }),
      );
      expect(successfulNavigate).toEqual(expect.objectContaining({ success: true }));
      expect(clickAfterSuccess).toEqual(expect.objectContaining({ success: true }));
      expect(callTool).toHaveBeenCalledTimes(3);
      expect(callTool).toHaveBeenNthCalledWith(3, 'browser_click', { selector: '#submit' });
    });
  });

  describe('ExecutorToolCallHandler', () => {
    it('classifies object results with success false as unsuccessful', () => {
      const handler = new ExecutorToolCallHandler({
        config: makeConfig(),
        mcpClients: new Map(),
        toolToClient: new Map(),
        nowMs: () => 0,
        getCurrentBrowserUrl: () => undefined,
      });

      expect(handler.isSuccessfulToolResult({ success: false })).toBe(false);
      expect(handler.isSuccessfulToolResult({ success: true })).toBe(true);
      expect(handler.isSuccessfulToolResult({})).toBe(true);
      expect(handler.isSuccessfulToolResult('ok')).toBe(true);
    });
  });

  describe('getActionSkillSnapshot', () => {
    it('returns a snapshot of registered skills', () => {
      const executor = new Executor(makeConfig());
      const snapshot = executor.getActionSkillSnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot.actionSkills).toBeInstanceOf(Array);
      expect(snapshot.byAction).toBeDefined();
    });
  });

  describe('executeStep', () => {
    it('skips step with invalid params (missing path)', async () => {
      const executor = new Executor(makeConfig({ debug: false }));
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: {},
      });

      const result = await executor.executeStep(step, makeExecutionContext());

      expect(result.stepResult.success).toBe(true);
      expect(result.stepResult.output).toEqual(expect.objectContaining({ skipped: true }));
    });

    it('returns the skipped output shape for invalid params', async () => {
      const executor = new Executor(makeConfig({ debug: false }));
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: {},
      });

      const result = await executor.executeStep(step, makeExecutionContext());

      expect(result.stepResult).toEqual(
        expect.objectContaining({
          success: true,
          output: {
            skipped: true,
            reason: 'read_file requires non-empty path parameter',
          },
        }),
      );
      expect(result.validation).toEqual({ pass: true, results: [] });
      expect(result.needsRollback).toBe(false);
    });

    it('skips step with empty path', async () => {
      const executor = new Executor(makeConfig({ debug: false }));
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: { path: '' },
      });

      const result = await executor.executeStep(step, makeExecutionContext());

      expect(result.stepResult.success).toBe(true);
      expect(result.stepResult.output).toEqual(expect.objectContaining({ skipped: true }));
    });

    it('returns exists false when pre-validation skips a missing read file', async () => {
      const executor = new Executor(
        makeConfig({
          debug: false,
          hallucinationGuard: {
            validateFilePath: vi.fn().mockResolvedValue({
              pass: false,
              type: 'file_not_found',
              severity: 'block',
              message: 'File src/missing.ts does not exist',
            }),
            validateCode: vi.fn(),
          } as unknown as ExecutorConfig['hallucinationGuard'],
        }),
      );
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: { path: 'src/missing.ts' },
      });

      const result = await executor.executeStep(step, makeExecutionContext());

      expect(result.stepResult).toEqual(
        expect.objectContaining({
          success: true,
          output: {
            skipped: true,
            reason: 'File src/missing.ts does not exist',
            exists: false,
          },
        }),
      );
      expect(result.validation).toEqual({ pass: true, results: [] });
      expect(result.needsRollback).toBe(false);
    });

    it('returns the skipped output shape for skippable tool errors', async () => {
      const executor = new Executor(
        makeConfig({
          debug: false,
          hallucinationGuard: {
            validateFilePath: vi.fn().mockResolvedValue({
              pass: true,
              type: 'file_exists',
              severity: 'info',
            }),
            validateCode: vi.fn(),
          } as unknown as ExecutorConfig['hallucinationGuard'],
        }),
      );
      executor.registerMCPClient('test-client', {
        callTool: vi.fn().mockResolvedValue({ success: false, error: 'Not a directory' }),
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('read_file', 'test-client');
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: { path: 'src/a.ts' },
      });

      const result = await executor.executeStep(step, makeExecutionContext());

      expect(result.stepResult).toEqual(
        expect.objectContaining({
          success: true,
          output: {
            skipped: true,
            reason: 'Not a directory',
          },
        }),
      );
      expect(result.validation).toEqual({ pass: true, results: [] });
      expect(result.needsRollback).toBe(false);
    });

    it('honors a fully disabled hallucination guard on the executor validation path', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-disabled-guard-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const disabledGuard = new HallucinationGuard({
          projectRoot,
          enabledChecks: {
            fileExistence: false,
            importValidity: false,
            syntaxValidity: false,
            sddCompliance: false,
          },
        });
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: disabledGuard,
          }),
        );
        const invalidContent = "import { missing } from './missing';\nexport const broken = {";
        const callTool = vi.fn().mockResolvedValue({ success: true, content: invalidContent });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        const result = await executor.executeStep(
          makeStep({
            action: 'create_file',
            tool: 'create_file',
            params: { path: 'src/broken.ts', content: invalidContent },
          }),
          makeExecutionContext(),
        );

        expect(callTool).toHaveBeenCalledWith('create_file', {
          path: 'src/broken.ts',
          content: invalidContent,
        });
        expect(result.stepResult.success).toBe(true);
        expect(result.validation).toEqual({ pass: true, results: [], blockedBy: undefined });
        expect(result.needsRollback).toBe(false);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('executes read_file on a missing path only when fileExistence is disabled', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-guard-readfile-'));
      try {
        const readStep = () =>
          makeStep({
            action: 'read_file',
            tool: 'read_file',
            params: { path: 'src/ghost.ts' },
          });
        const registerFiles = (executor: Executor, callTool: ReturnType<typeof vi.fn>) => {
          executor.registerMCPClient('files', {
            callTool,
            listTools: vi.fn().mockResolvedValue([]),
          });
          executor.registerToolMapping('read_file', 'files');
        };

        const disabledGuard = new HallucinationGuard({
          projectRoot,
          enabledChecks: {
            fileExistence: false,
            importValidity: false,
            syntaxValidity: false,
            sddCompliance: false,
          },
        });
        const disabledExecutor = new Executor(
          makeConfig({ projectRoot, hallucinationGuard: disabledGuard }),
        );
        const disabledCallTool = vi.fn().mockResolvedValue({ success: true, content: 'data' });
        registerFiles(disabledExecutor, disabledCallTool);

        const disabledResult = await disabledExecutor.executeStep(
          readStep(),
          makeExecutionContext(),
        );
        expect(disabledCallTool).toHaveBeenCalledWith('read_file', { path: 'src/ghost.ts' });
        expect(disabledResult.stepResult.success).toBe(true);

        const enabledGuard = new HallucinationGuard({ projectRoot });
        const enabledExecutor = new Executor(
          makeConfig({ projectRoot, hallucinationGuard: enabledGuard }),
        );
        const enabledCallTool = vi.fn().mockResolvedValue({ success: true, content: 'data' });
        registerFiles(enabledExecutor, enabledCallTool);

        const enabledResult = await enabledExecutor.executeStep(readStep(), makeExecutionContext());
        expect(enabledCallTool).not.toHaveBeenCalled();
        expect(enabledResult.stepResult.output).toEqual(expect.objectContaining({ skipped: true }));
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('returns validation result structure', async () => {
      const executor = new Executor(makeConfig());
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: {},
      });

      const result = await executor.executeStep(step, makeExecutionContext());

      expect(result).toHaveProperty('stepResult');
      expect(result).toHaveProperty('validation');
      expect(result).toHaveProperty('needsRollback');
    });
  });

  describe('executeSteps', () => {
    it('returns empty results for empty steps', async () => {
      const executor = new Executor(makeConfig());
      const results = await executor.executeSteps([], makeExecutionContext());
      expect(results).toEqual([]);
    });

    it('throws on missing dependency', async () => {
      const executor = new Executor(makeConfig());
      const step = makeStep({
        stepId: 's1',
        dependencies: ['missing-dep'],
        action: 'read_file',
        tool: 'read_file',
        params: { path: 'a.ts' },
      });

      await expect(executor.executeSteps([step], makeExecutionContext())).rejects.toThrow(
        'Circular dependency detected or missing dependency',
      );
    });

    it('calls onStepComplete callback', async () => {
      const executor = new Executor(makeConfig());
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: {},
      });

      const onStepComplete = vi.fn();

      await executor.executeSteps([step], makeExecutionContext(), onStepComplete);

      expect(onStepComplete).toHaveBeenCalledWith(step, expect.any(Object));
    });
  });

  describe('executeStepsWithErrorFeedback', () => {
    it('returns empty results for empty steps', async () => {
      const executor = new Executor(makeConfig());
      const results = await executor.executeStepsWithErrorFeedback([], makeExecutionContext());
      expect(results).toEqual([]);
    });

    it('calls onStepStart and onStepComplete callbacks', async () => {
      const executor = new Executor(makeConfig());
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: {},
      });

      const onStepStart = vi.fn();
      const onStepComplete = vi.fn();

      await executor.executeStepsWithErrorFeedback(
        [step],
        makeExecutionContext(),
        onStepStart,
        onStepComplete,
      );

      expect(onStepStart).toHaveBeenCalledWith(step);
      expect(onStepComplete).toHaveBeenCalledWith(step, expect.any(Object));
    });

    it('respects AbortSignal', async () => {
      const executor = new Executor(makeConfig());
      const controller = new AbortController();
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: {},
      });

      controller.abort();

      await expect(
        executor.executeStepsWithErrorFeedback(
          [step],
          makeExecutionContext(),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow();
    });

    it('marks step as skipped with unmet dependencies', async () => {
      const executor = new Executor(makeConfig());
      const step = makeStep({
        stepId: 's1',
        dependencies: ['missing-dep'],
        action: 'read_file',
        tool: 'read_file',
        params: { path: 'a.ts' },
      });

      await executor.executeStepsWithErrorFeedback([step], makeExecutionContext());

      expect(step.status).toBe('skipped');
    });
  });

  describe('trace', () => {
    it('calls onStepTrace when trace is enabled', async () => {
      const onStepTrace = vi.fn();
      const executor = new Executor(
        makeConfig({
          trace: { enabled: true, onStepTrace },
        }),
      );
      const step = makeStep({
        action: 'read_file',
        tool: 'read_file',
        params: {},
      });

      await executor.executeStepsWithErrorFeedback([step], makeExecutionContext());

      expect(onStepTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 't1',
          stepId: 'step-1',
          action: 'read_file',
          tool: 'read_file',
        }),
      );
    });
  });

  describe('write validation', () => {
    it('blocks invalid content before the write tool runs', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-prewrite-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            emitEvent: (event) => events.push(event),
          }),
        );
        const callTool = vi.fn().mockResolvedValue({ success: true });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        // 评测失败清单里的真实样本：markdown 围栏被当作代码写进 .tsx（tsc 报 TS1127）
        const fencedContent = '```tsx\nexport const Card = () => null;\n```\n';
        const result = await executor.executeStep(
          makeStep({
            action: 'create_file',
            tool: 'create_file',
            params: { path: 'src/Card.tsx', content: fencedContent },
          }),
          makeExecutionContext(),
        );

        expect(callTool).not.toHaveBeenCalled();
        expect(existsSync(join(projectRoot, 'src/Card.tsx'))).toBe(false);
        expect(result.stepResult.success).toBe(false);
        expect(result.stepResult.error).toContain('Pre-write validation failed');
        expect(result.needsRollback).toBe(false);
        expect(events).toEqual([expect.objectContaining({ type: 'validation_failed' })]);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('validates create_file content once instead of twice', async () => {
      const validateCode = vi.fn().mockResolvedValue({ pass: true, results: [] });
      const executor = new Executor(
        makeConfig({
          hallucinationGuard: {
            validateFilePath: vi.fn().mockResolvedValue({ pass: true, type: 'file_existence' }),
            validateCode,
          } as unknown as ExecutorConfig['hallucinationGuard'],
          getFileSystemFacts: () => ({
            existingFiles: new Set<string>(),
            existingDirectories: new Set(['src']),
            nonExistentPaths: new Set<string>(),
            directoryContents: new Map<string, string[]>(),
          }),
        }),
      );
      const callTool = vi.fn().mockResolvedValue({ success: true });
      executor.registerMCPClient('files', {
        callTool,
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('create_file', 'files');

      const result = await executor.executeStep(
        makeStep({ params: { path: 'src/a.ts', content: 'export const a = 1;' } }),
        makeExecutionContext(),
      );

      expect(validateCode).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(result.stepResult.success).toBe(true);
    });

    it('rolls back a written patch when post-write validation fails', async () => {
      const events: AgentEvent[] = [];
      const executor = new Executor(
        makeConfig({
          hallucinationGuard: {
            validateFilePath: vi.fn().mockResolvedValue({ pass: true, type: 'file_existence' }),
            validateCode: vi.fn().mockResolvedValue({
              pass: false,
              // 真实 guard 失败时 results 必有判失败项——事件口径依赖它
              results: [
                {
                  pass: false,
                  type: 'syntax_validity',
                  severity: 'block',
                  message: 'Syntax errors found in src/a.ts',
                },
              ],
              blockedBy: ['Syntax errors found in src/a.ts'],
            }),
          } as unknown as ExecutorConfig['hallucinationGuard'],
          emitEvent: (event) => events.push(event),
          // SecurityManager 把 rollback 归为「需审批」，非交互运行会直接拒绝；
          // 自动回滚要真正落地必须有这条 allow 规则（见 PR follow-up）
          security: { permissions: { allow: ['rollback'] } },
        }),
      );
      const callTool = vi.fn().mockImplementation((tool: string) => {
        if (tool === 'rollback') {
          return Promise.resolve({ success: true, message: 'rolled back' });
        }
        return Promise.resolve({
          success: true,
          content: 'export const a = {',
          snapshotId: 'snap-1',
        });
      });
      executor.registerMCPClient('files', {
        callTool,
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('apply_patch', 'files');
      executor.registerToolMapping('rollback', 'files');

      const result = await executor.executeStep(
        makeStep({
          action: 'apply_patch',
          tool: 'apply_patch',
          // 非空 patches：走直传路径，避免落进 apply_patch 技能的 LLM 代码生成分支。
          // 局部行补丁（不覆盖整文件）写盘前内容不可知，故必然落到写盘后判定 + 回滚——
          // 整文件 replace 已被前置门禁挡在磁盘外，测不到这条回滚路径。
          params: {
            path: 'src/a.ts',
            patches: [
              { operation: 'replace', startLine: 2, endLine: 2, content: 'export const a = {' },
            ],
          },
        }),
        makeExecutionContext({
          collectedContext: {
            files: new Map([['src/a.ts', 'export const x = 0;\nexport const a = 1;\n']]),
          },
        }),
      );

      expect(callTool).toHaveBeenCalledWith('rollback', { snapshotId: 'snap-1' });
      expect(result.stepResult.success).toBe(false);
      // 回滚成功 → 磁盘上没有残留 → 后续步骤可以安全继续。
      // needsRollback 表达的是「有内容落盘且未被撤销」，不是「这一步失败了」。
      expect(result.needsRollback).toBe(false);
      expect(events.map((event) => event.type)).toEqual([
        'validation_failed',
        'rollback_started',
        'rollback_completed',
      ]);
    });

    it('does not emit validation_failed when only the tool itself failed', async () => {
      const events: AgentEvent[] = [];
      // 内容本身没问题：失败只来自工具
      const validateCode = vi.fn().mockResolvedValue({ pass: true, results: [] });
      const executor = new Executor(
        makeConfig({
          hallucinationGuard: {
            validateFilePath: vi.fn().mockResolvedValue({ pass: true, type: 'file_existence' }),
            validateCode,
          } as unknown as ExecutorConfig['hallucinationGuard'],
          emitEvent: (event) => events.push(event),
          getFileSystemFacts: () => ({
            existingFiles: new Set<string>(),
            existingDirectories: new Set(['src']),
            nonExistentPaths: new Set<string>(),
            directoryContents: new Map<string, string[]>(),
          }),
        }),
      );
      // 工具自身报错（磁盘满、权限等），没有任何检查判失败
      const callTool = vi
        .fn()
        .mockResolvedValue({ success: false, error: 'EACCES: permission denied' });
      executor.registerMCPClient('files', {
        callTool,
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('create_file', 'files');

      const result = await executor.executeStep(
        makeStep({ params: { path: 'src/a.ts', content: 'export const a = 1;' } }),
        makeExecutionContext(),
      );

      expect(result.stepResult.success).toBe(false);
      expect(result.stepResult.error).toContain('EACCES');
      // 步骤失败但没有拦截：validation_failed 必须保持为 0，否则拦截数不可用
      expect(events.map((event) => event.type)).not.toContain('validation_failed');
    });
  });

  describe('pre-write veto scope', () => {
    // 前置门禁只有语法失败才有否决权。import_validity 对「同一计划里后续步骤才创建的
    // 相对模块」必然判 block——若它也能否决写盘，多文件计划的第一个文件根本写不出来，
    // 而改动前这类文件是照常落盘、等后续步骤补齐后自洽的。
    it('writes a file importing a module a later step will create', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-forwardref-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
          }),
        );
        const callTool = vi.fn().mockResolvedValue({ success: true });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        const result = await executor.executeStep(
          makeStep({
            params: {
              path: 'src/Page.tsx',
              // ./Card 尚不存在——由计划里后续的 create_file 步骤生成
              content: "import { Card } from './Card';\nexport const Page = () => Card;\n",
            },
          }),
          makeExecutionContext(),
        );

        expect(callTool).toHaveBeenCalledTimes(1);
        expect(result.stepResult.error).not.toContain('Pre-write validation failed');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('does not veto a write over a path-alias import', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-alias-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
          }),
        );
        const callTool = vi.fn().mockResolvedValue({ success: true });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        const result = await executor.executeStep(
          makeStep({
            params: {
              path: 'src/Page.tsx',
              // 别名会被 import 检查当成「未安装的包」
              content:
                "import { Card } from '@/components/Card';\nexport const Page = () => Card;\n",
            },
          }),
          makeExecutionContext(),
        );

        expect(callTool).toHaveBeenCalledTimes(1);
        expect(result.stepResult.error).not.toContain('Pre-write validation failed');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    // #387 的验收口径是「非法内容不得留在磁盘上」，且必须对 patch 成立。
    // 计划 schema 不产出 patches，所有 modify 步骤都走 codegen 的整文件 replace。
    it('blocks a syntactically invalid full-file replace patch before disk', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-patchveto-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            emitEvent: (event) => events.push(event),
          }),
        );
        const callTool = vi.fn().mockResolvedValue({ success: true, snapshotId: 'snap-1' });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('apply_patch', 'files');

        const original = 'export const a = 1;\nexport const b = 2;\n';
        const result = await executor.executeStep(
          makeStep({
            action: 'apply_patch',
            tool: 'apply_patch',
            params: {
              path: 'src/a.tsx',
              patches: [
                {
                  operation: 'replace',
                  startLine: 1,
                  endLine: original.split('\n').length,
                  content: '```tsx\nexport const A = () => null;\n```\n',
                },
              ],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.tsx', original]]) },
          }),
        );

        // 写工具从未被调用 → 坏内容根本没到磁盘，不必依赖回滚兜底
        expect(callTool).not.toHaveBeenCalled();
        expect(existsSync(join(projectRoot, 'src/a.tsx'))).toBe(false);
        expect(result.stepResult.error).toContain('Pre-write validation failed');
        expect(events.map((event) => event.type)).toEqual(['validation_failed']);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('leaves a partial-line patch to post-write validation', async () => {
      const validateCode = vi.fn().mockResolvedValue({ pass: true, results: [] });
      const executor = new Executor(
        makeConfig({
          hallucinationGuard: {
            validateFilePath: vi.fn().mockResolvedValue({ pass: true, type: 'file_existence' }),
            validateCode,
          } as unknown as ExecutorConfig['hallucinationGuard'],
        }),
      );
      const callTool = vi.fn().mockResolvedValue({ success: true });
      executor.registerMCPClient('files', {
        callTool,
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('apply_patch', 'files');

      await executor.executeStep(
        makeStep({
          action: 'apply_patch',
          tool: 'apply_patch',
          params: {
            path: 'src/a.ts',
            // 只覆盖 3 行文件里的第 2 行：最终内容写盘前不可知
            patches: [{ operation: 'replace', startLine: 2, endLine: 2, content: 'const b = 2;' }],
          },
        }),
        makeExecutionContext({
          collectedContext: { files: new Map([['src/a.ts', 'a\nb\nc\n']]) },
        }),
      );

      expect(callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('rollback observability', () => {
    // 默认非交互配置下 SecurityManager 拒绝 rollback。这条分支恰恰是 headless
    // 运行里最需要上报的：没有终态事件，调用方会停在「回滚开始」。
    it('emits rollback_failed and reports the file is still on disk when rollback is denied', async () => {
      const events: AgentEvent[] = [];
      const executor = new Executor(
        makeConfig({
          hallucinationGuard: {
            validateFilePath: vi.fn().mockResolvedValue({ pass: true, type: 'file_existence' }),
            validateCode: vi.fn().mockResolvedValue({
              pass: false,
              results: [
                {
                  pass: false,
                  type: 'syntax_validity',
                  severity: 'block',
                  message: 'Syntax errors found in src/a.ts',
                },
              ],
              blockedBy: ['Syntax errors found in src/a.ts'],
            }),
          } as unknown as ExecutorConfig['hallucinationGuard'],
          emitEvent: (event) => events.push(event),
          // 刻意不给 permissions.allow: ['rollback']——这就是评测所处的默认配置
        }),
      );
      const callTool = vi.fn().mockImplementation((tool: string) => {
        if (tool === 'rollback') {
          return Promise.resolve({ success: true, message: 'rolled back' });
        }
        return Promise.resolve({ success: true, content: 'x', snapshotId: 'snap-1' });
      });
      executor.registerMCPClient('files', {
        callTool,
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('apply_patch', 'files');
      executor.registerToolMapping('rollback', 'files');

      const result = await executor.executeStep(
        makeStep({
          action: 'apply_patch',
          tool: 'apply_patch',
          // 局部行补丁：内容写盘前不可知，落到写盘后判定 → 触发回滚 → 回滚被安全层拒
          params: {
            path: 'src/a.ts',
            patches: [
              { operation: 'replace', startLine: 2, endLine: 2, content: 'export const a = {' },
            ],
          },
        }),
        makeExecutionContext({
          collectedContext: {
            files: new Map([['src/a.ts', 'export const x = 0;\nexport const a = 1;\n']]),
          },
        }),
      );

      const types = events.map((event) => event.type);
      expect(types).toContain('rollback_started');
      // 关键：不能出现只有 started 没有终态的悬空序列
      expect(types).toContain('rollback_failed');
      expect(result.stepResult.error).toContain('still on disk');
      // 坏文件仍在磁盘上 → 后续步骤不能在这个状态上继续
      expect(result.needsRollback).toBe(true);
    });
  });

  describe('createExecutor factory', () => {
    it('returns an Executor instance', () => {
      const executor = createExecutor(makeConfig());
      expect(executor).toBeInstanceOf(Executor);
    });
  });
});
