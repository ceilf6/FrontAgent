import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HallucinationGuard } from '@frontagent/hallucination-guard';
import type { ExecutionStep } from '@frontagent/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotManager } from '../../../mcp-file/src/snapshot.js';
import { type ApplyPatchParams, applyPatch } from '../../../mcp-file/src/tools/apply-patch.js';
import { type CreateFileParams, createFile } from '../../../mcp-file/src/tools/create-file.js';
import { type ReadFileParams, readFile } from '../../../mcp-file/src/tools/read-file.js';
import { generateCodeForFile, generateModifiedCode } from '../llm/code-generation.js';
import { Executor } from './executor.js';
import type { ExecutorConfig } from './types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(syntaxValidity = true, response?: string) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'fa-write-integration-'));
  roots.push(projectRoot);
  const manager = new SnapshotManager(projectRoot);
  const emitEvent = vi.fn();
  const executor = new Executor({
    projectRoot,
    parallelExecution: true,
    emitEvent,
    security: { permissions: { allow: ['create_file', 'apply_patch'] } },
    hallucinationGuard: new HallucinationGuard({
      projectRoot,
      enabledChecks: { syntaxValidity, importValidity: false },
    }),
    llmService: {
      generateCodeForFile: (options) => generateCodeForFile(options, generationDeps),
      generateModifiedCode: (options) => generateModifiedCode(options, generationDeps),
    } as ExecutorConfig['llmService'],
  });
  const generationDeps = {
    debugLog: () => {},
    debugWarn: () => {},
    debugError: () => {},
    generateText: async () => response ?? '',
    generateObject: async () => {
      throw new Error('Unexpected object generation');
    },
  };
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'create_file')
      return createFile(args as unknown as CreateFileParams, projectRoot, manager);
    if (name === 'apply_patch')
      return applyPatch(args as unknown as ApplyPatchParams, projectRoot, manager);
    if (name === 'read_file') return readFile(args as unknown as ReadFileParams, projectRoot);
    throw new Error(`Unexpected tool ${name}`);
  });
  executor.registerMCPClient('files', { callTool, listTools: async () => [] });
  for (const tool of ['create_file', 'apply_patch', 'read_file'])
    executor.registerToolMapping(tool, 'files');
  return { executor, projectRoot, callTool, emitEvent };
}
function step(
  id: string,
  action: 'create_file' | 'apply_patch',
  params: Record<string, unknown>,
): ExecutionStep {
  return {
    stepId: id,
    description: id,
    action,
    tool: action,
    params,
    dependencies: [],
    validation: [],
    status: 'pending',
    phase: 'build',
  };
}
function context(content?: string) {
  return {
    task: { id: 'task', type: 'modify' as const, description: 'test' },
    collectedContext: { files: new Map(content === undefined ? [] : [['a.ts', content]]) },
  };
}

describe('executor with real file tools', () => {
  it.each(['create_file', 'apply_patch'] as const)(
    'preserves generated README Markdown when executing %s',
    async (action) => {
      const response =
        '# Project\n\nInstall dependencies:\n\n```sh\npnpm install\n```\n\nStart the app:\n\n```sh\npnpm dev\n```\n\nOpen the local development URL.';
      const { executor, projectRoot } = setup(true, response);
      const executionContext = context();
      if (action === 'apply_patch') {
        const original = '# Project\n\nSetup instructions coming soon.';
        writeFileSync(join(projectRoot, 'README.md'), original);
        executionContext.collectedContext.files.set('README.md', original);
      }

      const result = await executor.executeStep(
        step('readme', action, {
          path: 'README.md',
          codeDescription: 'Write a README with shell examples',
          changeDescription: 'Add installation and development instructions',
        }),
        executionContext,
      );

      expect(result.stepResult).toMatchObject({ success: true });
      expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe(response);
    },
  );

  it('passes rejected generation to the existing recovery callback', async () => {
    const response = '```ts\nexport const a = 1;\n```\n```ts\nexport const b = 2;\n```';
    const { executor, projectRoot } = setup(true, response);
    const recovered = 'export const a = 1;\nexport const b = 2;';
    const onPhaseError = vi.fn(async () => [
      step('recover', 'create_file', { path: 'a.ts', content: recovered }),
    ]);
    const results = await executor.executeStepsWithErrorFeedback(
      [step('generate', 'create_file', { path: 'a.ts', codeDescription: 'Add exports' })],
      context(),
      undefined,
      undefined,
      undefined,
      onPhaseError,
    );
    expect(onPhaseError).toHaveBeenCalledWith('build', [
      expect.objectContaining({ error: expect.stringMatching(/Markdown code fences/) }),
    ]);
    expect(results.map((result) => result.stepResult.success)).toEqual([false, true]);
    expect(readFileSync(join(projectRoot, 'a.ts'), 'utf8')).toBe(recovered);
  });

  it.each(['create_file', 'apply_patch'] as const)(
    'rejects multi-block generation before %s writes',
    async (action) => {
      const response = '```ts\nexport const a = 1;\n```\n```ts\nexport const b = 2;\n```';
      const { executor, projectRoot, callTool } = setup(true, response);
      const original = 'export const original = 1;';
      if (action === 'apply_patch') writeFileSync(join(projectRoot, 'a.ts'), original);
      const generatedStep = {
        ...step('generated', action, {
          path: 'a.ts',
          codeDescription: 'Add exports',
          changeDescription: 'Add exports',
        }),
        needsCodeGeneration: true,
      };
      const result = await executor.executeStep(
        generatedStep,
        context(action === 'apply_patch' ? original : undefined),
      );
      expect(result.stepResult.success).toBe(false);
      expect(result.stepResult.error).toMatch(/Markdown code fences/);
      expect(callTool).not.toHaveBeenCalledWith(action, expect.anything());
      if (action === 'apply_patch')
        expect(readFileSync(join(projectRoot, 'a.ts'), 'utf8')).toBe(original);
      else expect(existsSync(join(projectRoot, 'a.ts'))).toBe(false);
    },
  );

  it.each([
    ['a.ts', '这是一段说明文字，不是代码。'],
    ['formatDate.ts', '我需要先澄清一下：您提供的代码中没有具体说明要做什么修改。'],
    ['TodoList.tsx', '无法完成。您提供了原始代码和一般性的修改要求。'],
    ['residual.ts', 'export const a = 1;\n```ts\nexport const b = 2;\n```'],
  ])('blocks invalid content before creating %s', async (path, content) => {
    const { executor, projectRoot, callTool, emitEvent } = setup();
    const result = await executor.executeStep(
      step('invalid', 'create_file', { path, content }),
      context(),
    );
    expect(result.stepResult.success).toBe(false);
    expect(result.stepResult.error).toContain('Pre-write validation failed');
    expect(callTool).not.toHaveBeenCalled();
    expect(existsSync(join(projectRoot, path))).toBe(false);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'validation_failed',
        stage: 'pre_write',
        path,
      }),
    );
  });

  it('accepts markdown fences inside a JavaScript block comment', async () => {
    const { executor, projectRoot } = setup();
    const content = '/*\n```ts\nconst example = 1;\n```\n*/\nexport const value = 1;';
    const result = await executor.executeStep(
      step('comment', 'create_file', { path: 'a.ts', content }),
      context(),
    );
    expect(result.stepResult.success).toBe(true);
    expect(readFileSync(join(projectRoot, 'a.ts'), 'utf8')).toBe(content);
  });
  it.each([false, true])('honors fixture writes (explicit skip: %s)', async (skip) => {
    const { executor, projectRoot } = setup(skip);
    const result = await executor.executeStep(
      step('fixture', 'create_file', {
        path: 'a.ts',
        content: 'const broken = ;',
        skipSyntaxValidation: skip,
      }),
      context(),
    );
    expect(result.stepResult.success).toBe(true);
    expect(readFileSync(join(projectRoot, 'a.ts'), 'utf8')).toBe('const broken = ;');
  });
  it.each([false, true])(
    'compares the deferred patch base with actual content (first changes: %s)',
    async (changes) => {
      const { executor, projectRoot } = setup();
      const original = 'const value = 1;';
      writeFileSync(join(projectRoot, 'a.ts'), original);
      const steps = [
        step('first', 'apply_patch', {
          path: 'a.ts',
          patches: [
            {
              operation: 'replace',
              startLine: 1,
              content: changes ? 'const value = 2;' : original,
            },
          ],
        }),
        step('second', 'apply_patch', {
          path: 'a.ts',
          patches: [{ operation: 'replace', startLine: 1, content: 'const value = 3;' }],
        }),
      ];
      const results = await executor.executeStepsWithErrorFeedback(steps, context(original));
      expect(results[0].stepResult.success, results[0].stepResult.error).toBe(true);
      expect(results[1].stepResult.success).toBe(!changes);
      expect(readFileSync(join(projectRoot, 'a.ts'), 'utf8')).toBe(
        changes ? 'const value = 2;' : 'const value = 3;',
      );
      expect(steps[1].params).not.toHaveProperty('__frontagentDeferredSameTargetWrite');
      if (changes) expect(results[1].stepResult.error).toMatch(/changed after/);
    },
  );
  it('previews invalid syntax without changing the file or cache', async () => {
    const { executor, projectRoot } = setup();
    const original = 'const value = 1;';
    writeFileSync(join(projectRoot, 'a.ts'), original);
    const ctx = context(original);
    const result = await executor.executeStep(
      step('preview', 'apply_patch', {
        path: 'a.ts',
        dryRun: true,
        patches: [{ operation: 'replace', startLine: 1, content: 'const value = ;' }],
      }),
      ctx,
    );
    expect(result.stepResult.success).toBe(true);
    expect(result.stepResult.output).toMatchObject({
      validation: { syntaxChecked: true, syntaxValid: false },
    });
    expect(readFileSync(join(projectRoot, 'a.ts'), 'utf8')).toBe(original);
    expect(ctx.collectedContext.files.get('a.ts')).toBe(original);
  });
});
