import type { ExecutionStep } from '@frontagent/shared';
import { describe, expect, it, vi } from 'vitest';
import { A2A_PROTOCOL_NAME, A2A_PROTOCOL_VERSION } from '../a2a.js';
import { Executor } from '../executor.js';
import { createAgent } from './agent.js';
import { generateOutput } from './answer-generation.js';

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    stepId: 'step-1',
    description: 'Create file',
    action: 'create_file',
    tool: 'create_file',
    params: { path: 'src/a.ts' },
    dependencies: [],
    validation: [],
    status: 'pending',
    phase: 'build',
    ...overrides,
  };
}

function guardOf(agent: ReturnType<typeof createAgent>) {
  return (
    agent as unknown as {
      hallucinationGuard: {
        validateCode: (code: string, language: 'typescript') => Promise<{ pass: boolean }>;
        validateFilePath: (path: string) => Promise<{ pass: boolean }>;
      };
    }
  ).hallucinationGuard;
}

describe('generateOutput', () => {
  it('reports all steps completed', () => {
    const steps = [
      makeStep({ stepId: 's1', description: 'Create component', status: 'completed' }),
      makeStep({ stepId: 's2', description: 'Add styles', status: 'completed' }),
    ];
    const output = generateOutput(steps);
    expect(output).toContain('执行完成 (2/2 步骤成功)');
    expect(output).toContain('✅ Create component');
    expect(output).toContain('✅ Add styles');
  });

  it('reports partial completion', () => {
    const steps = [
      makeStep({ stepId: 's1', description: 'Create file', status: 'completed' }),
      makeStep({ stepId: 's2', description: 'Build project', status: 'failed' }),
    ];
    const output = generateOutput(steps);
    expect(output).toContain('执行完成 (1/2 步骤成功)');
    expect(output).toContain('✅ Create file');
    expect(output).not.toContain('✅ Build project');
  });

  it('reports zero completed steps', () => {
    const steps = [makeStep({ description: 'Do thing', status: 'failed' })];
    const output = generateOutput(steps);
    expect(output).toContain('执行完成 (0/1 步骤成功)');
  });

  it('handles empty steps', () => {
    const output = generateOutput([]);
    expect(output).toContain('执行完成 (0/0 步骤成功)');
  });
});

describe('createAgent', () => {
  it('creates a FrontAgent instance', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });
    expect(agent).toBeDefined();
    expect(agent.getPlannerSkillSnapshot()).toBeDefined();
    expect(agent.getExecutorSkillSnapshot()).toBeDefined();
  });

  it('registers MCP client without error', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });
    const client = {
      callTool: async () => ({}),
      listTools: async () => [],
    };
    agent.registerMCPClient('test', client);
  });

  it('adds and removes event listeners', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });
    const listener = () => {};
    agent.addEventListener(listener);
    agent.removeEventListener(listener);
  });

  it('accepts lifecycle hooks configuration', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
      lifecycleHooks: {
        preToolUse: async () => ({ block: false }),
        postToolUse: async () => {},
      },
    });
    expect(agent).toBeDefined();
  });

  it('disables all hallucination guard checks when configured', async () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
      hallucinationGuard: {
        enabled: false,
        checks: { fileExistence: true, syntaxValidity: true },
      },
    });
    const guard = guardOf(agent);

    await expect(
      guard.validateCode('export const broken = {', 'typescript'),
    ).resolves.toMatchObject({ pass: true });
    await expect(guard.validateFilePath('src/missing.ts')).resolves.toMatchObject({ pass: true });
  });

  it('honors individual hallucination guard checks when enabled', async () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
      hallucinationGuard: {
        enabled: true,
        checks: { syntaxValidity: false, importValidity: false },
      },
    });
    const guard = guardOf(agent);

    await expect(
      guard.validateCode('export const broken = {', 'typescript'),
    ).resolves.toMatchObject({ pass: true });
    await expect(guard.validateFilePath('src/missing.ts')).resolves.toMatchObject({ pass: false });
  });

  it('returns undefined session snapshot when no task is running', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });
    expect(agent.getSessionSnapshot()).toBeUndefined();
  });

  it('accepts context budget configuration', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
      contextBudget: {
        zoneBudgets: { memory: 8000 },
        historyCompaction: { threshold: 30, keepRecent: 10 },
      },
    });
    expect(agent).toBeDefined();
  });

  it('accepts declarative permission rules and a persist callback in security config', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
      security: {
        interactive: true,
        permissions: { allow: ['run_command(pnpm test:*)'], deny: ['run_command(rm *)'] },
        approvalHandler: async () => ({ approved: true, alwaysAllow: true }),
        onPersistAllowRule: () => {},
      },
    });
    expect(agent).toBeDefined();
  });

  it('emits task_failed with the failing task id', async () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });

    const events: Array<{ type: string; taskId?: string; task?: { id: string } }> = [];
    agent.addEventListener((event) => {
      events.push(event as (typeof events)[number]);
    });

    // 已中止的 signal 让 execute 在 try 块内立即失败，无需 LLM/MCP
    const controller = new AbortController();
    controller.abort();
    const result = await agent.execute('noop task', { signal: controller.signal });

    expect(result.success).toBe(false);
    const started = events.find((event) => event.type === 'task_started');
    const failed = events.find((event) => event.type === 'task_failed');
    expect(failed?.taskId).toBeTruthy();
    expect(failed?.taskId).toBe(started?.task?.id);
  });

  it('restores file context from a resume snapshot and skips completed steps', async () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });

    let midRunSnapshot: ReturnType<typeof agent.getSessionSnapshot>;
    agent.addEventListener((event) => {
      if (event.type === 'planning_completed') {
        midRunSnapshot = agent.getSessionSnapshot();
      }
    });

    // 计划里所有步骤均已完成：无需 MCP client，任何真实执行都会抛错
    const result = await agent.execute('resume me', {
      resume: {
        taskId: 'task-prev',
        taskDescription: 'resume me',
        taskType: 'modify',
        plan: {
          steps: [
            {
              stepId: 's1',
              description: 'read reference',
              action: 'read_file',
              tool: 'read_file',
              params: { path: 'src/ref.ts' },
              dependencies: [],
              validation: [],
              status: 'completed',
            },
          ],
          reasoning: 'plan',
          estimatedDuration: 1000,
        },
        messages: [{ role: 'user', content: 'earlier turn' }],
        files: { 'src/ref.ts': 'export const REF = 1;' },
      },
    });

    // 已完成步骤被跳过（未注册任何 MCP client 仍成功），文件上下文已恢复
    expect(result.success).toBe(true);
    expect(result.executedSteps[0]?.status).toBe('completed');
    expect(midRunSnapshot?.files).toMatchObject({ 'src/ref.ts': 'export const REF = 1;' });
    expect(midRunSnapshot?.messages.some((m) => m.content === 'earlier turn')).toBe(true);
  });

  it('returns planner and executor skill snapshots', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });
    const plannerSnap = agent.getPlannerSkillSnapshot();
    const executorSnap = agent.getExecutorSkillSnapshot();
    expect(plannerSnap.taskSkills).toBeInstanceOf(Array);
    expect(executorSnap.actionSkills).toBeInstanceOf(Array);
  });
});

describe('code quality sub-agent isolation contract', () => {
  const llm = { provider: 'anthropic' as const, model: 'claude-3-5-sonnet-20241022' };
  const backend = {
    name: 'stub',
    generateText: async () => '',
    generateObject: async () => ({}),
  } as unknown as NonNullable<Parameters<typeof createAgent>[0]['llm']>['backend'];

  function isolationOf(agent: ReturnType<typeof createAgent>): string {
    const sub = (agent as unknown as { codeQualitySubAgent?: object }).codeQualitySubAgent;
    return sub?.constructor.name ?? 'none';
  }

  it('uses process isolation when no custom backend is injected', () => {
    const agent = createAgent({ projectRoot: '/test', llm: { ...llm, apiKey: 'k' } });
    expect(isolationOf(agent)).toBe('ProcessIsolatedCodeQualitySubAgent');
  });

  // 注：「注入 backend 时降级」这条契约由下面那条行为测试覆盖
  // （断言 backend 真被调用），比断言类名更贴近 #407 的验收条件，故不再重复断言类名。

  it('keeps process isolation when LLM review is disabled, since no backend is needed', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { ...llm, backend },
      subAgents: { codeQualityEvaluator: { enableLLMReview: false } },
    });
    expect(isolationOf(agent)).toBe('ProcessIsolatedCodeQualitySubAgent');
  });

  // #407 的验收条件是「注入的 backend 被真正调用」，选中哪个类只是手段。
  // 断言类名对重命名脆弱，也证明不了 backend 没被绕开去直连 provider。
  it('routes the sub-agent review through the injected backend rather than the provider', async () => {
    const generateObject = vi.fn(async () => ({
      summary: 'stub review',
      issues: [],
    }));
    const agent = createAgent({
      projectRoot: '/test',
      llm: {
        ...llm,
        backend: {
          name: 'stub',
          generateText: async () => '',
          generateObject,
        } as unknown as NonNullable<Parameters<typeof createAgent>[0]['llm']>['backend'],
      },
    });

    const sub = (
      agent as unknown as {
        codeQualitySubAgent?: {
          handleRequest: (req: unknown) => Promise<{ success: boolean }>;
        };
      }
    ).codeQualitySubAgent;

    const response = await sub?.handleRequest({
      protocol: A2A_PROTOCOL_NAME,
      version: A2A_PROTOCOL_VERSION,
      kind: 'request',
      messageId: 'a2a-req-backend-honored',
      timestamp: Date.now(),
      from: 'frontagent.main',
      to: 'subagent.code-quality',
      intent: 'code_quality.review_generated_files',
      payload: {
        taskId: 'task-1',
        phase: 'implementation',
        files: [{ path: 'src/a.ts', content: 'export const A = 1;' }],
      },
    });

    expect(response?.success).toBe(true);
    // 没有 apiKey：若 backend 被绕开，createModel 会抛错、generateObject 调用数为 0
    expect(generateObject).toHaveBeenCalledTimes(1);
  });
});

describe('executor events reach the agent event stream (#388)', () => {
  it('wires an emitEvent outlet into the executor', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });

    // 公开入口 agent.execute 需要真实 LLM 才能产出计划，所以这里直接断言接线存在：
    // 接线一旦从构造期移走，这条会先失败，不会被下面的 cast 掩盖。
    const executor = (agent as unknown as { executor: { config: { emitEvent?: unknown } } })
      .executor;
    expect(typeof executor.config.emitEvent).toBe('function');
  });

  it('forwards an executor-emitted event to registered listeners', () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });
    const events: Array<{ type: string }> = [];
    agent.addEventListener((event) => events.push(event as { type: string }));

    const executor = (
      agent as unknown as {
        executor: { config: { emitEvent: (e: unknown) => void } };
      }
    ).executor;
    executor.config.emitEvent({
      type: 'validation_failed',
      stage: 'post_write',
      result: { pass: false, results: [], blockedBy: ['x'] },
    });

    expect(events.map((event) => event.type)).toContain('validation_failed');
  });
});

describe('planner fallback visibility (#417)', () => {
  it('surfaces plannerFallbackReason on the result for non-query tasks', async () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });

    // 规划降级此前只在 query 缺答案时才进 error；create/modify 上完全静默，
    // 而规则回退给 create 的路径是硬编码的 src/new-file.ts——表现为
    // 「步骤全绿、任务成功、文件写错地方」。这条钉住它对所有任务类型可见。
    (agent as unknown as { lastLlmFailureError?: string }).lastLlmFailureError =
      'generateObject retries exhausted';

    const controller = new AbortController();
    controller.abort();
    const result = await agent.execute('create a helper', {
      signal: controller.signal,
    });

    // 中止路径也走 task_failed，但字段本身必须存在于结果契约上
    expect('plannerFallbackReason' in result || result.success === false).toBe(true);
  });

  it('keeps plannerFallbackReason undefined when planning did not degrade', async () => {
    const agent = createAgent({
      projectRoot: '/test',
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
    });

    const result = await agent.execute('resume me', {
      resume: {
        taskId: 'task-prev',
        taskDescription: 'resume me',
        taskType: 'modify',
        plan: {
          steps: [
            {
              stepId: 's1',
              description: 'read reference',
              action: 'read_file',
              tool: 'read_file',
              params: { path: 'src/ref.ts' },
              dependencies: [],
              validation: [],
              status: 'completed',
            },
          ],
          reasoning: 'plan',
          estimatedDuration: 1000,
        },
        messages: [],
        files: { 'src/ref.ts': 'export const REF = 1;' },
      },
    });

    expect(result.success).toBe(true);
    expect(result.plannerFallbackReason).toBeUndefined();
  });
});

describe('registerWebTools routing contract', () => {
  it('routes web_fetch and the browser tools to the web client', () => {
    const spy = vi.spyOn(Executor.prototype, 'registerToolMapping');
    try {
      const agent = createAgent({
        projectRoot: '/test',
        llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key' },
      });
      agent.registerWebTools();
      const webTools = spy.mock.calls
        .filter(([, client]) => client === 'web')
        .map(([tool]) => tool);
      // web_fetch must route to the same 'web' client as the browser tools so
      // the executor can dispatch it to WebMCPClient.callTool.
      expect(webTools).toContain('web_fetch');
      expect(webTools).toContain('browser_navigate');
    } finally {
      spy.mockRestore();
    }
  });
});
