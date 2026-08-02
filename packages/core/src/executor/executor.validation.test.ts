import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HallucinationGuard } from '@frontagent/hallucination-guard';
import type { AgentTask, ExecutionStep } from '@frontagent/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../types.js';
import { Executor } from './executor.js';
import { executeStepsWithProgressEnforcement } from './progress-enforcement.js';
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
      isCheckEnabled: () => true,
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
  describe('pre-write veto and reuse', () => {
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

    // 用真实临时目录并让 mock 工具真的写盘：此前这条用例的 projectRoot 是
    // '/test'、工具也不落盘，于是 readWrittenFile 返回 undefined，命中的是复用
    // 条件里「读不回」那一支——断言成立的前提是「文件根本不存在」，锁不住它
    // 声称的「落盘内容与被校验内容相等时不重复校验」。
    it('validates create_file content once when what landed is what was checked', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-once-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const content = 'export const a = 1;\n';
        const validateCode = vi.fn().mockResolvedValue({ pass: true, results: [] });
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: {
              validateFilePath: vi.fn().mockResolvedValue({ pass: true, type: 'file_existence' }),
              validateCode,
              isCheckEnabled: () => true,
            } as unknown as ExecutorConfig['hallucinationGuard'],
            getFileSystemFacts: () => ({
              existingFiles: new Set<string>(),
              existingDirectories: new Set(['src']),
              nonExistentPaths: new Set<string>(),
              directoryContents: new Map<string, string[]>(),
            }),
          }),
        );
        const callTool = vi.fn().mockImplementation(async () => {
          writeFileSync(join(projectRoot, 'src', 'a.ts'), content);
          return { success: true };
        });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        const result = await executor.executeStep(
          makeStep({ params: { path: 'src/a.ts', content } }),
          makeExecutionContext(),
        );

        // 落盘的正是被校验过的那份，所以写盘后不再跑第二次 guard
        expect(readFileSync(join(projectRoot, 'src', 'a.ts'), 'utf-8')).toBe(content);
        expect(validateCode).toHaveBeenCalledTimes(1);
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(result.stepResult.success).toBe(true);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
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
        expect(events.map((event) => event.type)).toContain('validation_failed');
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
            isCheckEnabled: () => true,
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
      // 写动作的工具失败仍要中止：继续跑的话，后续「引用该模块的另一个文件」的
      // 步骤会全绿收尾，整轮以「缺模块但步骤全成功」呈现。
      // （只读动作的工具失败才不中止——那条由 executor.test.ts 的 read_file 用例覆盖。）
      expect(result.needsRollback).toBe(true);
    });
  });

  describe('pre-write veto scope', () => {
    // 前置门禁只有语法失败才有否决权。import_validity 对「同一计划里后续步骤才创建的
    // 相对模块」必然判 block——若它也能否决写盘，多文件计划的第一个文件根本写不出来，
    // 而改动前这类文件是照常落盘、等后续步骤补齐后自洽的。
    // create_file 的 import_validity 仍然是阻塞的（本改动不动这条既有行为），
    // 所以这里断言的是「写盘没有被否决」——工具确实被调用了——而不是「步骤成功」。
    // 只断言 `Pre-write validation failed` 不出现会让人误读成后者。
    it('does not veto a create_file over a module a later step will create', async () => {
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
        expect(result.stepResult.error ?? '').not.toContain('Pre-write validation failed');
        // 关键：写工具返回了 snapshotId，若回滚触发口径没收窄，
        // create 快照的回滚会 unlinkSync 把这个刚写好的合法文件删掉。
        expect(callTool).not.toHaveBeenCalledWith('rollback', expect.anything());
        expect(result.rollbackFailed).toBeFalsy();
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('does not veto a create_file over a path-alias import', async () => {
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

        // 写盘发生了，这是本条要钉的。写盘后 create_file 的 import_validity 仍会
        // 判失败——那是既有行为，本改动只在 apply_patch 上把它降级。
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(result.stepResult.error ?? '').not.toContain('Pre-write validation failed');
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
            isCheckEnabled: () => true,
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
          expect(result.stepResult.error ?? '').not.toContain('Pre-write validation failed');
        } finally {
          rmSync(projectRoot, { recursive: true, force: true });
        }
      });
    }

    // 已知残留误报，钉住而不是假装不存在：判据是逐行正则，不识别上下文，所以
    // 一份把 markdown 示例放进多行模板字符串的合法 .ts（prompt 常量最容易长成
    // 这样）会被当成围栏挡下。#413 换成真 parser 后这条用例应当反转成「不再拦」。
    it('pins the known template-literal false positive', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-tmpl-fence-'));
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
              path: 'src/prompt.ts',
              // 合法 TS：围栏在模板字符串里面
              content: 'export const PROMPT = `\nReply with:\n```ts\nconst a = 1;\n```\n`;\n',
            },
          }),
          makeExecutionContext(),
        );

        // 当前行为：被挡下且中止剩余计划。这是取舍，不是意外。
        expect(callTool).not.toHaveBeenCalled();
        expect(result.stepResult.error).toContain('Markdown code fence');
        expect(result.needsRollback).toBe(true);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

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
    it('does not veto when syntaxValidity is disabled, so the guard stays ablatable', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-ablatable-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({
              projectRoot,
              enabledChecks: { syntaxValidity: false },
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
          makeStep({
            params: {
              path: 'src/Card.tsx',
              content: '```tsx\nexport const Card = () => null;\n```\n',
            },
          }),
          makeExecutionContext(),
        );

        // 执行器在 guard 之外复刻了一条检查；它若不受同一份配置管辖，
        // `syntaxValidity: false` 就关不掉写盘否决——正是 #386 让七月消融基准
        // guard 臂失效的机制。
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(result.stepResult.error ?? '').not.toContain('Markdown code fence');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('does not veto a markdown fence inside a yaml block scalar', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-yaml-'));
      try {
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
              path: 'docs.yaml',
              // 块标量里放一段 markdown 是完全合法的 YAML
              content: 'readme: |\n  ```ts\n  const a = 1;\n  ```\n',
            },
          }),
          makeExecutionContext(),
        );

        expect(callTool).toHaveBeenCalledTimes(1);
        expect(result.stepResult.error ?? '').not.toContain('Markdown code fence');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
    it('does not fail an apply_patch whose content merely contains an apostrophe', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-apos-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const target = join(projectRoot, 'src/a.ts');
        const original = 'export const msg = "old";\n';
        writeFileSync(target, original);

        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
          }),
        );
        // 之前 apply_patch 从不进入 validateCode；本 PR 让它进了，于是这个
        // 逐行数引号奇偶的检查器第一次能判 modify 步骤成败——而它对 "it's fine"
        // 必然判 block（issue #413 实测）。写盘后的 syntax_validity 判定因此被剔除。
        const patched = 'export const msg = "it\'s fine";\n';
        const callTool = vi.fn().mockImplementation(() => {
          writeFileSync(target, patched);
          return Promise.resolve({ success: true, snapshotId: 'snap-1' });
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
            params: {
              path: 'src/a.ts',
              patches: [
                {
                  operation: 'replace',
                  startLine: 1,
                  endLine: original.split('\n').length,
                  content: patched,
                },
              ],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.ts', original]]) },
          }),
        );

        expect(result.stepResult.success).toBe(true);
        expect(callTool).not.toHaveBeenCalledWith('rollback', expect.anything());
        expect(readFileSync(target, 'utf-8')).toBe(patched);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  // repo-guard 在 #402 上指出的三条空白。前两条锁住「哪些判据可以决定步骤成败」，
  // 第三条把中止语义从单步层推到调度层——它们各自对应一次真实的行为改变。
  describe('which verdicts may decide a write step', () => {
    // 修复前 apply_patch 的内容根本到不了 validateCode（计划 schema 不发 patches，
    // content 三个来源全 undefined），所以 import 检查从未约束过补丁路径。
    // resolveWriteContent 让整文件 replace 第一次可校验；如果顺手把 block 权也给
    // import_validity，一个合法的 modify 步骤就会失败，needsRollback 再把剩余计划
    // 整个跳过——而 @/x 与「后续步骤才创建的相对模块」正是它最常见的两类误报。
    const unresolvableImports = {
      'a path alias': "import { Card } from '@/components/Card';\n",
      'a module a later step will create': "import { Later } from './Later.js';\n",
    };

    for (const [name, header] of Object.entries(unresolvableImports)) {
      it(`lets a full-file replace patch land over ${name}`, async () => {
        const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-patch-import-'));
        try {
          mkdirSync(join(projectRoot, 'src'), { recursive: true });
          const target = join(projectRoot, 'src', 'a.ts');
          const original = 'export const a = 1;\n';
          writeFileSync(target, original);
          const patched = `${header}export const a = 2;\n`;

          const events: AgentEvent[] = [];
          const executor = new Executor(
            makeConfig({
              projectRoot,
              hallucinationGuard: new HallucinationGuard({ projectRoot }),
              emitEvent: (event) => events.push(event),
            }),
          );
          const callTool = vi.fn().mockImplementation(async (tool: string) => {
            if (tool === 'apply_patch') {
              writeFileSync(target, patched);
              return { success: true, snapshotId: 'snap-1' };
            }
            return { success: true };
          });
          executor.registerMCPClient('files', {
            callTool,
            listTools: vi.fn().mockResolvedValue([]),
          });
          executor.registerToolMapping('apply_patch', 'files');

          const result = await executor.executeStep(
            makeStep({
              action: 'apply_patch',
              tool: 'apply_patch',
              params: {
                path: 'src/a.ts',
                patches: [
                  {
                    operation: 'replace',
                    startLine: 1,
                    endLine: original.split('\n').length,
                    content: patched,
                  },
                ],
              },
            }),
            makeExecutionContext({
              collectedContext: { files: new Map([['src/a.ts', original]]) },
            }),
          );

          expect(result.stepResult.success).toBe(true);
          // 中止调度的是 !success && needsRollback；两者都不得因 import 判定成立。
          expect(result.needsRollback).toBe(false);
          expect(readFileSync(target, 'utf-8')).toBe(patched);
          expect(callTool).not.toHaveBeenCalledWith('rollback', expect.anything());
        } finally {
          rmSync(projectRoot, { recursive: true, force: true });
        }
      });
    }

    // 降级只覆盖 apply_patch。create_file 的 syntax_validity 修复前就是阻塞的，
    // 而 checkSyntaxValidity 只对 ts/js 走那条逐行引号奇偶的启发式——json 走的是
    // JSON.parse，判据完全可靠。按 action 一刀切降级会把后者一起关掉，一个非法的
    // package.json 就会落盘、步骤报成功、还不进重试。这条钉住「本 PR 不移除任何
    // 既有拦截」。
    it('still fails a create_file whose JSON does not parse', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-json-syntax-'));
      try {
        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            emitEvent: (event) => events.push(event),
          }),
        );
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const callTool = vi.fn().mockImplementation(async () => {
          writeFileSync(join(projectRoot, 'src', 'data.json'), '{ "name": ');
          return { success: true };
        });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        const result = await executor.executeStep(
          // 不用 package.json：安全层把它当敏感路径，会先要审批而走不到校验
          makeStep({ params: { path: 'src/data.json', content: '{ "name": ' } }),
          makeExecutionContext(),
        );

        expect(result.stepResult.success).toBe(false);
        expect(result.needsRollback).toBe(true);
        expect(
          events.filter(
            (event) => event.type === 'validation_failed' && event.stage === 'post_write',
          ),
        ).toHaveLength(1);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    // 反过来：apply_patch 上降级等于保持原状，那条路径此前内容根本到不了
    // validateCode，所以同一个语法错误不该让 modify 步骤失败。
    it('does not fail an apply_patch over a demoted syntax verdict', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-patch-syntax-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const target = join(projectRoot, 'src', 'a.ts');
        const original = 'export const a = 1;\n';
        writeFileSync(target, original);
        // 逐行启发式会对这行里的撇号判 block —— #413 的实测样本之一
        const patched = 'export const msg = "it\'s fine";\n';

        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            emitEvent: (event) => events.push(event),
          }),
        );
        const callTool = vi.fn().mockImplementation(async (tool: string) => {
          if (tool === 'apply_patch') {
            writeFileSync(target, patched);
            return { success: true, snapshotId: 'snap-1' };
          }
          return { success: true, content: readFileSync(target, 'utf-8') };
        });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('apply_patch', 'files');
        executor.registerToolMapping('read_file', 'files');

        const result = await executor.executeStep(
          makeStep({
            action: 'apply_patch',
            tool: 'apply_patch',
            params: {
              path: 'src/a.ts',
              patches: [
                {
                  operation: 'replace',
                  startLine: 1,
                  endLine: original.split('\n').length,
                  content: patched,
                },
              ],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.ts', original]]) },
          }),
        );

        expect(result.stepResult.success).toBe(true);
        expect(result.needsRollback).toBe(false);
        expect(readFileSync(target, 'utf-8')).toBe(patched);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    // 前置校验只覆盖「整文件 replace」——只改局部行的补丁最终内容要落盘才知道，
    // resolveFullFileReplaceContent 对它返回 undefined。#387 对补丁路径的保护
    // 因此是有条件的，该降级路径必须仍然落到写盘后判定，而不是静默变成「不校验」。
    it('falls back to post-write validation for a partial-line patch', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-patch-partial-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const target = join(projectRoot, 'src', 'a.ts');
        const original = 'export const a = 1;\nexport const b = 2;\n';
        writeFileSync(target, original);
        const fenced = 'export const a = 1;\n```ts\nexport const b = 3;\n```\n';

        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            security: { permissions: { allow: ['rollback'] } },
            emitEvent: (event) => events.push(event),
          }),
        );
        const callTool = vi.fn().mockImplementation(async (tool: string) => {
          if (tool === 'apply_patch') {
            writeFileSync(target, fenced);
            return { success: true, snapshotId: 'snap-1' };
          }
          return { success: true, content: readFileSync(target, 'utf-8') };
        });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('apply_patch', 'files');
        executor.registerToolMapping('read_file', 'files');

        const result = await executor.executeStep(
          makeStep({
            action: 'apply_patch',
            tool: 'apply_patch',
            params: {
              path: 'src/a.ts',
              // startLine 2：不是整文件替换，写盘前算不出最终内容
              patches: [
                { operation: 'replace', startLine: 2, endLine: 2, content: '```ts\nb\n```\n' },
              ],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.ts', original]]) },
          }),
        );

        // 写盘前没拦住（工具确实被调用了），但写盘后的围栏判据抓到并判失败。
        expect(callTool).toHaveBeenCalledWith('apply_patch', expect.anything());
        expect(result.stepResult.success).toBe(false);
        expect(result.stepResult.error).toContain('Markdown code fence');
        expect(
          events.filter(
            (event) => event.type === 'validation_failed' && event.stage === 'post_write',
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.type === 'validation_failed' && event.stage === 'pre_write',
          ),
        ).toHaveLength(0);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('abort semantics reach the scheduler', () => {
    // 单步层已经断言了 needsRollback；但真正的后果发生在调度层——
    // 写盘前否决之后，剩余步骤必须被标记为 skipped，否则计划会在一个没落盘的
    // 文件之上继续推演，整轮以「零文件产出」呈现为成功。
    it('skips the remaining steps after a pre-write veto', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-abort-'));
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

        const vetoed = makeStep({
          stepId: 'step-1',
          params: {
            path: 'src/Card.tsx',
            content: '```tsx\nexport const Card = () => null;\n```\n',
          },
        });
        const later = makeStep({
          stepId: 'step-2',
          params: { path: 'src/Page.tsx', content: 'export const Page = () => null;\n' },
        });

        const outputs = await executeStepsWithProgressEnforcement(
          [vetoed, later],
          makeExecutionContext(),
          { executeStep: (step, ctx) => executor.executeStep(step, ctx) },
        );

        expect(outputs).toHaveLength(1);
        expect(outputs[0].stepResult.success).toBe(false);
        expect(outputs[0].needsRollback).toBe(true);
        expect(later.status).toBe('skipped');
        // 被否决的那一步没有落盘，后续步骤也没有被执行
        expect(callTool).not.toHaveBeenCalled();
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('the write landed but could not be read back', () => {
    // 三处都表现为「无异常」：不尝试回滚、rollbackFailed 保持 false、内容校验被跳过。
    // 这是本改动里唯一完全静默的分支，所以它拼进 stepResult.error 的那句话就是
    // 唯一的可见信号——必须钉住，否则一次静默退化不会有任何人发现。
    it('says so in the error and does not attempt a rollback', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-unreadable-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: {
              validateFilePath: vi.fn().mockResolvedValue({ pass: true, type: 'file_existence' }),
              // 内容判定失败，但落盘内容读不回来（工具报成功却没有真的写）
              validateCode: vi.fn().mockResolvedValue({
                pass: false,
                results: [
                  {
                    pass: false,
                    type: 'import_validity',
                    severity: 'block',
                    message: 'Cannot resolve ./missing.js',
                  },
                ],
                blockedBy: ['Cannot resolve ./missing.js'],
              }),
              isCheckEnabled: () => true,
            } as unknown as ExecutorConfig['hallucinationGuard'],
            security: { permissions: { allow: ['rollback'] } },
          }),
        );
        // 带 snapshotId 才会走到「有快照但读不回」这条分支；没有它会先短路。
        const callTool = vi.fn().mockResolvedValue({ success: true, snapshotId: 'snap-1' });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        const result = await executor.executeStep(
          makeStep({
            params: { path: 'src/never-written.ts', content: "import './missing.js';\n" },
          }),
          makeExecutionContext(),
        );

        expect(result.stepResult.success).toBe(false);
        expect(result.stepResult.error).toContain('could not read back src/never-written.ts');
        expect(result.stepResult.error).toContain('rollback was not attempted');
        // 「读不回」不等于「回滚失败」——后者驱动中止语义，是更强的断言。
        expect(result.rollbackFailed).toBe(false);
        expect(callTool).not.toHaveBeenCalledWith('rollback', expect.anything());
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('a tool failure is not dressed up as a write-validation failure', () => {
    // 写工具可以先建快照再失败（EACCES 之类）。此前这种返回会命中「读不回」分支，
    // 把 `could not read back …; rollback was not attempted` 拼到一个与读回毫无
    // 关系的错误后面——而 runPhaseRecovery 正是拿 stepResult.error 去喂重试用的
    // 模型，等于把恢复引向错误方向。既有用例用的是不带 snapshotId 的返回，绕开了它。
    it('keeps the tool error intact when the failed tool still returned a snapshot', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-toolfail-snap-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            security: { permissions: { allow: ['rollback'] } },
            emitEvent: (event) => events.push(event),
          }),
        );
        const callTool = vi.fn().mockResolvedValue({
          success: false,
          error: 'EACCES: permission denied',
          snapshotId: 'snap-1',
        });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('create_file', 'files');

        const result = await executor.executeStep(
          makeStep({ params: { path: 'src/a.ts', content: 'export const a = 1;\n' } }),
          makeExecutionContext(),
        );

        expect(result.stepResult.success).toBe(false);
        expect(result.stepResult.error).toBe('EACCES: permission denied');
        expect(result.stepResult.error).not.toContain('could not read back');
        expect(result.rollbackFailed).toBe(false);
        expect(callTool).not.toHaveBeenCalledWith('rollback', expect.anything());
        // 工具失败不是校验拦截，不该污染 #388 的计数
        expect(events.filter((event) => event.type === 'validation_failed')).toHaveLength(0);
        // 写动作的工具失败照旧中止剩余计划
        expect(result.needsRollback).toBe(true);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe('post-write validation trusts only what actually landed', () => {
    // 复用写盘前的校验结果有一个前提：落盘的就是被校验过的那份。整文件判定依赖
    // collectedContext.files 的行数快照，而 apply_patch 成功后该 Map 不刷新——
    // 同一计划内二次改同一文件时，工具可能只替换了前 N 行并保留尾部，落盘内容
    // ≠ 被校验的 patch.content。这条重校验分支此前无覆盖，而它正是快照陈旧时
    // 唯一的正确性保障。
    //
    // 判据刻意不用围栏：围栏是**独立**于 postValidation 的失败来源，无论走复用
    // 还是重校验都会被抓到，用它做断言这条用例就测不到分支本身。改用只有
    // validateCode 才产出的 import 判定——它在 apply_patch 上被降级，所以步骤照常
    // 成功，但会出现在 validation_failed 的载荷里，那正是重校验唯一的可观测差异。
    it('revalidates against what landed, not against what was checked', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-stale-snapshot-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const target = join(projectRoot, 'src', 'a.ts');
        const original = 'export const a = 1;\n';
        writeFileSync(target, original);
        // 计划里的补丁内容不含 import；工具实际落盘的那份引了一个不存在的模块。
        const patchContent = 'export const a = 2;\n';
        const actuallyLanded = "import './definitely-missing.js';\nexport const a = 2;\n";

        const events: AgentEvent[] = [];
        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            emitEvent: (event) => events.push(event),
          }),
        );
        const callTool = vi.fn().mockImplementation(async (tool: string) => {
          if (tool === 'apply_patch') {
            writeFileSync(target, actuallyLanded);
            return { success: true, snapshotId: 'snap-1' };
          }
          return { success: true, content: readFileSync(target, 'utf-8') };
        });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('apply_patch', 'files');
        executor.registerToolMapping('read_file', 'files');

        const result = await executor.executeStep(
          makeStep({
            action: 'apply_patch',
            tool: 'apply_patch',
            params: {
              path: 'src/a.ts',
              patches: [
                {
                  operation: 'replace',
                  startLine: 1,
                  endLine: original.split('\n').length,
                  content: patchContent,
                },
              ],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.ts', original]]) },
          }),
        );

        // import 判定在 apply_patch 上被降级，所以步骤成功、文件留在磁盘上
        expect(result.stepResult.success).toBe(true);
        expect(readFileSync(target, 'utf-8')).toBe(actuallyLanded);

        // 但遥测必须反映**落盘的那份**：复用写盘前的结论会让这条判定完全消失，
        // 因为被校验的 patchContent 里根本没有 import。
        const failed = events.filter((event) => event.type === 'validation_failed');
        expect(failed).toHaveLength(1);
        const verdicts = (failed[0] as { result: { results: Array<{ type: string }> } }).result
          .results;
        expect(verdicts.some((entry) => entry.type === 'import_validity')).toBe(true);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    // 围栏判据判的是「**这次写入**引入了围栏」，不是「文件里有围栏」。局部行补丁
    // 只改几行却会拿到整份落盘文件，若不比对原文，文件别处早就存在的围栏会让一次
    // 无关的合法编辑失败并触发回滚——回滚虽能还原，但剩余计划会被跳过。
    it('does not veto a patch over a fence that was already in the file', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'frontagent-preexisting-fence-'));
      try {
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        const target = join(projectRoot, 'src', 'a.ts');
        // 补丁前文件里就有围栏，且是判据真的会命中的形态（行首 ```，
        // 而不是 `// ```ts` 那种——检测用的是 /^\s*```/，注释掉的围栏根本不命中，
        // 拿它当 fixture 会让这条用例无论有没有守卫都通过）。
        const original = '```\nexport const a = 1;\n';
        writeFileSync(target, original);
        const patched = '```\nexport const a = 2;\n';

        const executor = new Executor(
          makeConfig({
            projectRoot,
            hallucinationGuard: new HallucinationGuard({ projectRoot }),
            security: { permissions: { allow: ['rollback'] } },
          }),
        );
        const callTool = vi.fn().mockImplementation(async (tool: string) => {
          if (tool === 'apply_patch') {
            writeFileSync(target, patched);
            return { success: true, snapshotId: 'snap-1' };
          }
          return { success: true, content: readFileSync(target, 'utf-8') };
        });
        executor.registerMCPClient('files', {
          callTool,
          listTools: vi.fn().mockResolvedValue([]),
        });
        executor.registerToolMapping('apply_patch', 'files');
        executor.registerToolMapping('read_file', 'files');

        const result = await executor.executeStep(
          makeStep({
            action: 'apply_patch',
            tool: 'apply_patch',
            params: {
              path: 'src/a.ts',
              // 局部行替换：只改第 2 行，写盘前算不出最终内容
              patches: [
                { operation: 'replace', startLine: 2, endLine: 2, content: 'export const a = 2;' },
              ],
            },
          }),
          makeExecutionContext({
            collectedContext: { files: new Map([['src/a.ts', original]]) },
          }),
        );

        expect(result.stepResult.success).toBe(true);
        expect(result.needsRollback).toBe(false);
        expect(callTool).not.toHaveBeenCalledWith('rollback', expect.anything());
        expect(readFileSync(target, 'utf-8')).toBe(patched);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
