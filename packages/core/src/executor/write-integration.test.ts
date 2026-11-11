import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HallucinationGuard } from '@frontagent/hallucination-guard';
import type { ExecutionStep } from '@frontagent/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotManager } from '../../../mcp-file/src/snapshot.js';
import { type ApplyPatchParams, applyPatch } from '../../../mcp-file/src/tools/apply-patch.js';
import { type CreateFileParams, createFile } from '../../../mcp-file/src/tools/create-file.js';
import { type ReadFileParams, readFile } from '../../../mcp-file/src/tools/read-file.js';
import { Executor } from './executor.js';
import type { ExecutorConfig } from './types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(syntaxValidity = true) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'fa-write-integration-'));
  roots.push(projectRoot);
  const manager = new SnapshotManager(projectRoot);
  const executor = new Executor({
    projectRoot,
    parallelExecution: true,
    security: { permissions: { allow: ['create_file', 'apply_patch'] } },
    hallucinationGuard: new HallucinationGuard({
      projectRoot,
      enabledChecks: { syntaxValidity, importValidity: false },
    }),
    llmService: {} as ExecutorConfig['llmService'],
  });
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
  return { executor, projectRoot, callTool };
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
