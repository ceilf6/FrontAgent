import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type GuardConfig, HallucinationGuard } from '@frontagent/hallucination-guard';
import { defaultSDDConfig } from '@frontagent/sdd';
import type { ExecutionStep, SDDConfig } from '@frontagent/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotManager } from '../../../mcp-file/src/snapshot.js';
import { type ApplyPatchParams, applyPatch } from '../../../mcp-file/src/tools/apply-patch.js';
import { type CreateFileParams, createFile } from '../../../mcp-file/src/tools/create-file.js';
import { type ReadFileParams, readFile } from '../../../mcp-file/src/tools/read-file.js';
import type { AgentEvent } from '../types.js';
import { Executor } from './executor.js';
import type { ExecutorConfig } from './types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(): SDDConfig {
  const sdd = structuredClone(defaultSDDConfig);
  sdd.codeQuality.forbiddenPatterns = ['BANNED'];
  return sdd;
}

function setup(
  options: {
    sdd?: SDDConfig | null;
    checks?: GuardConfig['enabledChecks'];
    enabled?: boolean;
    security?: ExecutorConfig['security'];
    approvalHandler?: ExecutorConfig['approvalHandler'];
    landedContent?: string;
  } = {},
) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'fa-sdd-write-'));
  roots.push(projectRoot);
  const sdd = options.sdd === null ? undefined : (options.sdd ?? config());
  const guard = new HallucinationGuard({
    projectRoot,
    sddConfig: sdd,
    enabled: options.enabled,
    enabledChecks: { importValidity: false, ...options.checks },
  });
  const events: AgentEvent[] = [];
  const manager = new SnapshotManager(projectRoot);
  const executor = new Executor({
    projectRoot,
    hallucinationGuard: guard,
    sddConfig: sdd,
    llmService: {} as ExecutorConfig['llmService'],
    security: options.security,
    approvalHandler: options.approvalHandler,
    emitEvent: (event) => events.push(event),
  });
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'read_file') return readFile(args as unknown as ReadFileParams, projectRoot);
    const result =
      name === 'create_file'
        ? await createFile(args as unknown as CreateFileParams, projectRoot, manager)
        : await applyPatch(args as unknown as ApplyPatchParams, projectRoot, manager);
    if (result.success && options.landedContent !== undefined && args.dryRun !== true) {
      writeFileSync(join(projectRoot, args.path as string), options.landedContent);
    }
    return result;
  });
  executor.registerMCPClient('files', { callTool, listTools: async () => [] });
  for (const name of ['create_file', 'apply_patch', 'read_file'])
    executor.registerToolMapping(name, 'files');
  const context = {
    task: { id: 'sdd', type: 'modify' as const, description: 'SDD test' },
    collectedContext: { files: new Map<string, string>() },
  };
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(projectRoot, path)), { recursive: true });
    writeFileSync(join(projectRoot, path), content);
    context.collectedContext.files.set(path, content);
  };
  return { executor, guard, projectRoot, events, callTool, context, put };
}

function step(
  action: 'create_file' | 'apply_patch',
  params: Record<string, unknown>,
): ExecutionStep {
  return {
    stepId: 'write',
    description: 'write',
    action,
    tool: action,
    params,
    dependencies: [],
    validation: [],
    status: 'pending',
  };
}

describe('SDD on the real executor write path', () => {
  it('blocks forbidden generated content before creating a file and emits one pre-write verdict', async () => {
    const test = setup();
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content: 'export const BANNED = 1;' }),
      test.context,
    );
    expect(result.stepResult.success).toBe(false);
    expect(result.validation.results).toContainEqual(
      expect.objectContaining({ type: 'sdd_compliance', severity: 'block', pass: false }),
    );
    expect(test.callTool).not.toHaveBeenCalled();
    expect(existsSync(join(test.projectRoot, 'a.ts'))).toBe(false);
    expect(test.events.filter((event) => event.type === 'validation_failed')).toEqual([
      expect.objectContaining({ stage: 'pre_write', path: 'a.ts' }),
    ]);
    expect(test.events.some((event) => event.type === 'rollback_started')).toBe(false);
  });

  it('keeps a successful SDD verdict on a legal create', async () => {
    const test = setup();
    const validation = vi.spyOn(test.guard, 'validateSDDCompliance');
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content: 'export const value = 1;' }),
      test.context,
    );
    expect(result.stepResult.success).toBe(true);
    expect(result.validation.results).toContainEqual(
      expect.objectContaining({ type: 'sdd_compliance', pass: true }),
    );
    expect(test.callTool).toHaveBeenCalledTimes(1);
    expect(validation).toHaveBeenCalledTimes(1);
  });

  it('allows an authorized create_file overwrite without a conflicting existence check', async () => {
    const test = setup({ security: { interactive: true }, approvalHandler: async () => true });
    test.put('a.ts', 'const value = 1;');
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content: 'const value = 2;', overwrite: true }),
      test.context,
    );
    expect(result.stepResult.success).toBe(true);
    expect(readFileSync(join(test.projectRoot, 'a.ts'), 'utf8')).toBe('const value = 2;');
  });

  it('checks final skill content and path instead of the planner input', async () => {
    const sdd = config();
    sdd.moduleBoundaries = [
      { from: 'src/components/**', canImport: [], cannotImport: ['src/api/**'] },
    ];
    const test = setup({ sdd });
    test.put('src/components/Existing.ts', 'export {};');
    test.executor.registerActionSkill({
      name: 'generated',
      action: 'create_file',
      prepareToolParams: async ({ params }) => ({
        ...params,
        path: 'src/components/../components/New.ts',
        content: "export { api } from '../api/client';",
      }),
    });
    const result = await test.executor.executeStep(
      step('create_file', { path: 'safe.ts', content: 'export {};' }),
      test.context,
    );
    expect(result.stepResult.success).toBe(false);
    expect(result.stepResult.error).toContain('cannot import');
    expect(test.callTool).not.toHaveBeenCalled();
  });

  it('checks the complete patch projection and never treats params.content as the patch result', async () => {
    const test = setup();
    const original = "const label = 'BAN';\nexport { label };";
    test.put('a.ts', original);
    const result = await test.executor.executeStep(
      step('apply_patch', {
        path: 'a.ts',
        content: 'export const safe = true;',
        patches: [{ operation: 'replace', startLine: 1, content: "const label = 'BANNED';" }],
      }),
      test.context,
    );
    expect(result.stepResult.success).toBe(false);
    expect(result.stepResult.error).toContain('SDD compliance');
    expect(test.callTool).toHaveBeenCalledTimes(1);
    expect(test.callTool).toHaveBeenCalledWith('read_file', expect.anything());
    expect(readFileSync(join(test.projectRoot, 'a.ts'), 'utf8')).toBe(original);
  });

  it.each(['.ts', '.json', '.yaml', '.md'])(
    'enforces content rules independently of syntax language %s',
    async (extension) => {
      const test = setup({ checks: { syntaxValidity: false } });
      const result = await test.executor.executeStep(
        step('create_file', {
          path: `a${extension}`,
          content: 'BANNED',
          skipSyntaxValidation: true,
        }),
        test.context,
      );
      expect(result.stepResult.success).toBe(false);
      expect(test.callTool).not.toHaveBeenCalled();
    },
  );

  it.each([{ enabled: false }, { checks: { sddCompliance: false } }, { sdd: null }])(
    'honors SDD availability and guard switches: %j',
    async (options) => {
      const test = setup(options);
      const result = await test.executor.executeStep(
        step('create_file', { path: 'a.ts', content: 'export const BANNED = 1;' }),
        test.context,
      );
      expect(result.stepResult.success).toBe(true);
      expect(result.validation.results.some((check) => check.type === 'sdd_compliance')).toBe(
        false,
      );
    },
  );

  it('uses updated guard constraints', async () => {
    const test = setup();
    const next = config();
    next.codeQuality.forbiddenPatterns = ['NEW_RULE'];
    test.guard.updateSDDConfig(next);
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content: 'export const NEW_RULE = 1;' }),
      test.context,
    );
    expect(result.stepResult.success).toBe(false);
    expect(test.callTool).not.toHaveBeenCalled();
  });

  it.each([
    "import x from 'lodash/map';",
    "export { x } from '@scope/pkg/subpath';",
    "const x = require('lodash/map');",
    "const x = import('@scope/pkg/subpath');",
  ])('checks imported package roots from source: %s', async (content) => {
    const sdd = config();
    sdd.techStack.forbiddenPackages = ['lodash', '@scope/pkg'];
    const test = setup({ sdd });
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content }),
      test.context,
    );
    expect(result.stepResult.success).toBe(false);
    expect(result.stepResult.error).toContain('forbidden by SDD');
    expect(test.callTool).not.toHaveBeenCalled();
  });

  it('does not interpret comments, strings, or execution step IDs as imported packages', async () => {
    const sdd = config();
    sdd.techStack.forbiddenPackages = ['lodash', 'step-before'];
    const test = setup({ sdd });
    const write = step('create_file', {
      path: 'a.ts',
      content: '// import x from "lodash";\nexport const example = "require(\'lodash\')";',
    });
    write.dependencies = ['step-before'];
    const result = await test.executor.executeStep(write, test.context);
    expect(result.stepResult.success).toBe(true);
  });

  it.each(['create_file', 'apply_patch'] as const)(
    'rechecks changed disk content after %s without broadening automatic rollback',
    async (action) => {
      const test = setup({ landedContent: 'export const BANNED = 1;' });
      const validation = vi.spyOn(test.guard, 'validateSDDCompliance');
      if (action === 'apply_patch') test.put('a.ts', 'const before = 1;');
      const params =
        action === 'create_file'
          ? { path: 'a.ts', content: 'export const allowed = 1;' }
          : {
              path: 'a.ts',
              patches: [
                { operation: 'replace', startLine: 1, content: 'export const allowed = 1;' },
              ],
            };
      const result = await test.executor.executeStep(step(action, params), test.context);
      expect(result.stepResult.success).toBe(false);
      expect(result.validation.results).toContainEqual(
        expect.objectContaining({ type: 'sdd_compliance', pass: false }),
      );
      expect(readFileSync(join(test.projectRoot, 'a.ts'), 'utf8')).toContain('BANNED');
      expect(test.events.filter((event) => event.type === 'validation_failed')).toEqual([
        expect.objectContaining({ stage: 'post_write' }),
      ]);
      expect(test.events.some((event) => event.type === 'rollback_started')).toBe(false);
      expect(test.context.collectedContext.files.has('a.ts')).toBe(false);
      expect(validation).toHaveBeenCalledTimes(2);
    },
  );

  it('preserves dry-run previews without enforcing content rules or changing file/cache', async () => {
    const test = setup();
    test.put('a.ts', 'const value = 1;');
    const result = await test.executor.executeStep(
      step('apply_patch', {
        path: 'a.ts',
        dryRun: true,
        patches: [{ operation: 'replace', startLine: 1, content: 'const BANNED = ;' }],
      }),
      test.context,
    );
    expect(result.stepResult.success).toBe(true);
    expect(readFileSync(join(test.projectRoot, 'a.ts'), 'utf8')).toBe('const value = 1;');
    expect(test.context.collectedContext.files.get('a.ts')).toBe('const value = 1;');
    expect(test.events.some((event) => event.type === 'validation_failed')).toBe(false);
  });

  it('reports ordinary SDD warnings without failing the write', async () => {
    const sdd = config();
    sdd.codeQuality.maxFileLines = 1;
    const test = setup({ sdd });
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content: 'const a = 1;\nexport { a };' }),
      test.context,
    );
    expect(result.stepResult.success).toBe(true);
    expect(result.validation.warnings?.join(' ') ?? '').toContain('maximum lines');
    expect(test.events.some((event) => event.type === 'validation_failed')).toBe(false);
  });

  it('keeps approval in SecurityManager without converting an approved write into a guard failure', async () => {
    const sdd = config();
    sdd.modificationRules.requireApproval = [{ pattern: 'a.ts', reason: 'review a' }];
    const approvalHandler = vi.fn(async () => true);
    const test = setup({ sdd, security: { interactive: true }, approvalHandler });
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content: 'export {};' }),
      test.context,
    );
    expect(result.stepResult.success).toBe(true);
    expect(approvalHandler).toHaveBeenCalledTimes(1);
    expect(result.validation.warnings?.join(' ') ?? '').toContain('approval');
    expect(test.events.some((event) => event.type === 'validation_failed')).toBe(false);
  });

  it('still fails closed when SDD approval is unavailable', async () => {
    const sdd = config();
    sdd.modificationRules.requireApproval = [{ pattern: 'a.ts', reason: 'review a' }];
    const test = setup({ sdd });
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content: 'export {};' }),
      test.context,
    );
    expect(result.stepResult.success).toBe(false);
    expect(result.stepResult.error).toContain('no interactive approval');
    expect(test.callTool).not.toHaveBeenCalled();
  });

  it('keeps security protected paths enforced with SDD guard checks disabled', async () => {
    const sdd = config();
    sdd.modificationRules.protectedFiles = ['a.ts'];
    const test = setup({ sdd, checks: { sddCompliance: false } });
    const result = await test.executor.executeStep(
      step('create_file', { path: 'a.ts', content: 'export {};' }),
      test.context,
    );
    expect(result.stepResult.success).toBe(false);
    expect(test.callTool).not.toHaveBeenCalled();
  });

  it.each(['create_file', 'apply_patch'] as const)(
    'preserves staged-import behavior for %s',
    async (action) => {
      const test = setup({ checks: { importValidity: true } });
      test.put('old.ts', 'export const value = 1;');
      const content = "import { next } from './next';\nexport { next };";
      const params =
        action === 'create_file'
          ? { path: 'new.ts', content }
          : { path: 'old.ts', patches: [{ operation: 'replace', startLine: 1, content }] };
      const result = await test.executor.executeStep(step(action, params), test.context);
      expect(test.callTool).toHaveBeenCalledWith(action, expect.anything());
      expect(result.stepResult.success).toBe(action === 'apply_patch');
      expect(result.validation.results).toContainEqual(
        expect.objectContaining({ type: 'sdd_compliance', pass: true }),
      );
      expect(test.events.some((event) => event.type === 'rollback_started')).toBe(false);
    },
  );
});
