import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HallucinationGuard } from '@frontagent/hallucination-guard';
import type { AgentTask, ExecutionStep } from '@frontagent/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../types.js';
import { Executor } from './executor.js';
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
describe('Executor write validation', () => {
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
        // 磁盘无残留，但必须中止剩余计划：否则后续针对该文件的 apply_patch
        // 会拿到「文件不存在」并被判为可跳过、记成成功
        expect(result.needsRollback).toBe(true);
        expect(result.rollbackFailed).toBeFalsy();
        expect(events).toEqual([
          expect.objectContaining({ type: 'validation_failed', stage: 'pre_write' }),
        ]);
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

    it('rolls back a written patch whose landed content carries a markdown fence', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-rb-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const target = join(projectRoot, 'src/a.ts');
        const original = 'export const x = 0;\nexport const a = 1;\n';
        writeFileSync(target, original);

        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            emitEvent: (event) => events.push(event),
            security: { permissions: { allow: ['rollback'] } },
          }),
        );
        // 真实工具的返回形状：只有 success + snapshotId，内容靠落盘体现
        const callTool = vi.fn().mockImplementation((tool: string) => {
          if (tool === 'rollback') {
            writeFileSync(target, original);
            return Promise.resolve({ success: true, message: 'rolled back' });
          }
          writeFileSync(target, 'export const x = 0;\n```ts\n');
          return Promise.resolve({ success: true, snapshotId: 'snap-1' });
        });
        executor.registerMCPClient('files', { callTool, listTools: vi.fn().mockResolvedValue([]) });
        executor.registerToolMapping('apply_patch', 'files');
        executor.registerToolMapping('rollback', 'files');

        const result = await executor.executeStep(
          makeStep({
            action: 'apply_patch',
            tool: 'apply_patch',
            // 局部行补丁：写盘前内容不可知，落到写盘后判定
            params: {
              path: 'src/a.ts',
              patches: [{ operation: 'replace', startLine: 2, endLine: 2, content: '```ts' }],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.ts', original]]) },
          }),
        );

        expect(result.stepResult.success).toBe(false);
        expect(callTool).toHaveBeenCalledWith('rollback', { snapshotId: 'snap-1' });
        // 回滚成功 → 磁盘干净 → rollbackFailed 为 false；
        // needsRollback 表达的是「有真实检查判失败」，仍为 true
        expect(result.rollbackFailed).toBe(false);
        expect(readFileSync(target, 'utf-8')).toBe(original);
        expect(events.map((event) => event.type)).toContain('rollback_completed');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
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
      // 纯工具失败不得中止剩余计划——一次 read_file/run_command 失败
      // 不应该让 progress-enforcement 把后续步骤全标 skipped
      expect(result.needsRollback).toBe(false);
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
            // 授予 rollback 许可：不给的话安全层会先拒掉，测不出「回滚会不会被触发」
            security: { permissions: { allow: ['rollback'] } },
          }),
        );
        // 必须带 snapshotId：没有它 rollbackFailedWrite 直接短路，用例形同虚设
        const callTool = vi.fn().mockResolvedValue({ success: true, snapshotId: 'snap-1' });
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
        // 关键：写工具返回了 snapshotId，若回滚触发口径没收窄，
        // create 快照的回滚会 unlinkSync 把这个刚写好的合法文件删掉。
        expect(callTool).not.toHaveBeenCalledWith('rollback', expect.anything());
        expect(result.rollbackFailed).toBeFalsy();
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
            // 授予 rollback 许可：不给的话安全层会先拒掉，测不出「回滚会不会被触发」
            security: { permissions: { allow: ['rollback'] } },
          }),
        );
        // 必须带 snapshotId：没有它 rollbackFailedWrite 直接短路，用例形同虚设
        const callTool = vi.fn().mockResolvedValue({ success: true, snapshotId: 'snap-1' });
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

    // 计划参数原样透传、apply_patch 技能整体 spread 原 params，所以
    // `{path, content, patches}` 是可达状态。若 content 能兜底，校验的就是一份
    // 不会被写入的内容，而真正落盘的补丁内容一次都不过 guard。
    it('validates the patch content, not a leftover content param, on apply_patch', async () => {
      const validateCode = vi.fn().mockResolvedValue({ pass: true, results: [] });
      const executor = new Executor(
        makeConfig({
          hallucinationGuard: {
            validateFilePath: vi.fn().mockResolvedValue({ pass: true, type: 'file_existence' }),
            validateCode,
          } as unknown as ExecutorConfig['hallucinationGuard'],
        }),
      );
      executor.registerMCPClient('files', {
        callTool: vi.fn().mockResolvedValue({ success: true }),
        listTools: vi.fn().mockResolvedValue([]),
      });
      executor.registerToolMapping('apply_patch', 'files');

      const original = 'export const a = 1;\n';
      await executor.executeStep(
        makeStep({
          action: 'apply_patch',
          tool: 'apply_patch',
          params: {
            path: 'src/a.ts',
            content: 'export const NEVER_WRITTEN = 1;',
            patches: [
              {
                operation: 'replace',
                startLine: 1,
                endLine: original.split('\n').length,
                content: 'export const ACTUALLY_WRITTEN = 1;',
              },
            ],
          },
        }),
        makeExecutionContext({
          collectedContext: { files: new Map([['src/a.ts', original]]) },
        }),
      );

      expect(validateCode).toHaveBeenCalledTimes(1);
      expect(validateCode.mock.calls[0]?.[0]).toContain('ACTUALLY_WRITTEN');
      expect(validateCode.mock.calls[0]?.[0]).not.toContain('NEVER_WRITTEN');
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
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-rbdeny-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const target = join(projectRoot, 'src/a.ts');
        const original = 'export const x = 0;\nexport const a = 1;\n';
        writeFileSync(target, original);

        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            emitEvent: (event) => events.push(event),
            // 刻意不给 permissions.allow: ['rollback']——这就是评测所处的默认配置
          }),
        );
        const callTool = vi.fn().mockImplementation((tool: string) => {
          if (tool === 'rollback') {
            return Promise.resolve({ success: true, message: 'rolled back' });
          }
          writeFileSync(target, 'export const x = 0;\n```ts\n');
          return Promise.resolve({ success: true, snapshotId: 'snap-1' });
        });
        executor.registerMCPClient('files', { callTool, listTools: vi.fn().mockResolvedValue([]) });
        executor.registerToolMapping('apply_patch', 'files');
        executor.registerToolMapping('rollback', 'files');

        const result = await executor.executeStep(
          makeStep({
            action: 'apply_patch',
            tool: 'apply_patch',
            params: {
              path: 'src/a.ts',
              patches: [{ operation: 'replace', startLine: 2, endLine: 2, content: '```ts' }],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.ts', original]]) },
          }),
        );

        const types = events.map((event) => event.type);
        expect(types).toContain('rollback_started');
        // 关键：不能出现只有 started 没有终态的悬空序列
        expect(types).toContain('rollback_failed');
        expect(result.stepResult.error).toContain('still on disk');
        expect(result.rollbackFailed).toBe(true);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
  describe('post-write validation reads the file back', () => {
    // 真实 create_file / apply_patch 都不返回 `content`，局部行补丁也没有
    // `content` 参数。若只认这几个来源，局部补丁写盘后根本不做内容校验，
    // #387 的「非法补丁内容不得留在磁盘」对补丁路径就不成立。
    it('validates a partial patch by reading the written file, and rolls it back', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-readback-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const target = join(projectRoot, 'src/a.ts');
        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            emitEvent: (event) => events.push(event),
            security: { permissions: { allow: ['rollback'] } },
          }),
        );

        // 真实工具的返回形状：只有 success + snapshotId，没有 content。
        // 写盘这一步由 mock 真的落到磁盘上，供读回校验。
        const callTool = vi.fn().mockImplementation((tool: string) => {
          if (tool === 'rollback') {
            writeFileSync(target, 'export const x = 0;\nexport const a = 1;\n');
            return Promise.resolve({ success: true, message: 'rolled back' });
          }
          writeFileSync(target, 'export const x = 0;\n```ts\n');
          return Promise.resolve({ success: true, snapshotId: 'snap-1' });
        });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('apply_patch', 'files');
        executor.registerToolMapping('rollback', 'files');

        const original = 'export const x = 0;\nexport const a = 1;\n';
        writeFileSync(target, original);

        const result = await executor.executeStep(
          makeStep({
            action: 'apply_patch',
            tool: 'apply_patch',
            params: {
              path: 'src/a.ts',
              // 局部行补丁：写盘前内容不可知，只能靠读回
              patches: [{ operation: 'replace', startLine: 2, endLine: 2, content: '```ts' }],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.ts', original]]) },
          }),
        );

        expect(result.stepResult.success).toBe(false);
        // 读回后语法检查判失败 → 发事件 → 触发回滚
        expect(events.map((event) => event.type)).toContain('validation_failed');
        expect(callTool).toHaveBeenCalledWith('rollback', { snapshotId: 'snap-1' });
        expect(readFileSync(target, 'utf-8')).toBe(original);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('validation_failed stage discrimination', () => {
    // 三个发射点含义完全不同；不带 stage 就没法把「真拦截」和
    // 「已落盘再判失败」分开计数（issue #388）。
    it('tags a pre-write interception as pre_write with the target path', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-stage-'));
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
        executor.registerMCPClient('files', {
          callTool: vi.fn().mockResolvedValue({ success: true }),
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        await executor.executeStep(
          makeStep({
            params: {
              path: 'src/Card.tsx',
              content: '```tsx\nexport const Card = () => null;\n```\n',
            },
          }),
          makeExecutionContext(),
        );

        const failed = events.find((event) => event.type === 'validation_failed');
        expect(failed).toMatchObject({ stage: 'pre_write', path: 'src/Card.tsx' });
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
  describe('the pre-write veto must not fire on legitimate code', () => {
    // 这是本轮最该锁住的契约。guard 的 syntax_validity 是逐行数引号奇偶的启发式，
    // 对 "it's"、多行模板字符串、JSX 撇号全部判 block（实测）。曾经把它当作写盘
    // 否决权，等于让任何含撇号的字符串都写不出来——比它要修的缺陷严重得多。
    const legitimate = {
      'apostrophe in a string': 'export const msg = "it\'s fine";\n',
      'multi-line template literal': 'export const q = `\n  SELECT 1\n`;\n',
      'JSX text with an apostrophe': "export const P = () => <p>Don't panic</p>;\n",
      'unbalanced-looking regex': 'export const re = /[{(]/;\n',
    };

    for (const [name, content] of Object.entries(legitimate)) {
      it(`writes a file containing ${name}`, async () => {
        const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-legit-'));
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
            makeStep({ params: { path: 'src/Legit.tsx', content } }),
            makeExecutionContext(),
          );

          expect(callTool).toHaveBeenCalledTimes(1);
          expect(result.stepResult.error).not.toContain('Pre-write validation failed');
        } finally {
          rmSync(projectRoot, { recursive: true, force: true });
        }
      });
    }

    it('still blocks a markdown fence, which is the failure actually observed in the eval', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-fence-'));
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
              path: 'src/Card.tsx',
              content: '```tsx\nexport const Card = () => null;\n```\n',
            },
          }),
          makeExecutionContext(),
        );

        expect(callTool).not.toHaveBeenCalled();
        expect(result.stepResult.error).toContain('Markdown code fence');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
