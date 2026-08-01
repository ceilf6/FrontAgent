import type { AgentTask, ExecutionPlan } from '@frontagent/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContextManager } from '../context.js';
import { buildFinalOutput } from './answer-generation.js';

type ExecutionContext = NonNullable<ReturnType<ContextManager['getContext']>>;

function makeContext(
  overrides: Partial<ExecutionContext['collectedContext']> = {},
): ExecutionContext {
  return {
    collectedContext: {
      files: new Map<string, string>(),
      ...overrides,
    },
  } as unknown as ExecutionContext;
}

const queryTask = { id: 't1', type: 'query', description: '路由表在哪个文件？' } as AgentTask;
const noSteps: ExecutionPlan['steps'] = [];

/** 捕获送进 LLM 的 evidence 文本，断言它包含了该包含的东西 */
function makeDeps() {
  const generateText = vi.fn().mockResolvedValue('answer');
  return {
    deps: {
      llmService: { generateText },
      debugWarn: vi.fn(),
    } as unknown as Parameters<typeof buildFinalOutput>[0],
    generateText,
  };
}

describe('query answer evidence', () => {
  // filesenseContext 一路从 context-manager 传到这里，却从未被读取：
  // navigate 扫出 15 个带评分的候选路径，回答却报告「没有任何工作区证据」。
  // 与 #386/#400/#403/#388 同族——算了、传了、消费端不读（issue #415）。
  it('includes the filesense navigation result as evidence', async () => {
    const { deps, generateText } = makeDeps();

    await buildFinalOutput(
      deps,
      queryTask,
      noSteps,
      makeContext({ filesenseContext: 'src/app/routes 目录：路由定义' }),
    );

    expect(generateText).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(generateText.mock.calls[0]?.[0]);
    expect(prompt).toContain('src/app/routes');
    // 必须标注成结构证据：候选路径证明「路径存在」，不等于读过该文件的内容
    expect(prompt).toContain('结构证据');
  });

  it('omits the section entirely when navigation did not run', async () => {
    const { deps, generateText } = makeDeps();

    await buildFinalOutput(deps, queryTask, noSteps, makeContext());

    const prompt = JSON.stringify(generateText.mock.calls[0]?.[0]);
    expect(prompt).not.toContain('目录导航结果');
  });
});
