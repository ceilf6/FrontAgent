import { describe, expect, it } from 'vitest';
import type { A2ARequest } from '../a2a.js';
import { A2A_PROTOCOL_NAME, A2A_PROTOCOL_VERSION } from '../a2a.js';
import type { LLMService } from '../llm/llm-service.js';
import type { CodeQualityReviewRequest } from './code-quality-subagent.js';
import { CodeQualitySubAgent } from './code-quality-subagent.js';

function buildRequest(): A2ARequest<CodeQualityReviewRequest> {
  return {
    protocol: A2A_PROTOCOL_NAME,
    version: A2A_PROTOCOL_VERSION,
    kind: 'request',
    messageId: 'a2a-req-test',
    timestamp: Date.now(),
    from: 'frontagent.main',
    to: 'subagent.code-quality',
    intent: 'code_quality.review_generated_files',
    payload: {
      taskId: 'task-1',
      phase: 'implementation',
      files: [{ path: 'src/a.ts', content: 'export const A = 1;' }],
    },
  };
}

describe('CodeQualitySubAgent LLM review timeout', () => {
  // 进程隔离分支靠 SIGKILL 兜底；in_memory 分支没有进程可杀，
  // 后端挂起时如果没有这层 race，整个阶段会无限期阻塞。
  it('falls back to the rule review when the LLM backend hangs past the timeout', async () => {
    let settled = false;
    const hangingLLM = {
      generateObject: () =>
        new Promise(() => {
          /* 永不 resolve：模拟后端挂起 */
        }),
    } as unknown as LLMService;

    const agent = new CodeQualitySubAgent({
      llmService: hangingLLM,
      reviewTimeoutMs: 50,
      enableRuleFallback: true,
    });

    const started = Date.now();
    const response = await agent.handleRequest(buildRequest());
    settled = true;

    expect(settled).toBe(true);
    expect(response.success).toBe(true);
    // 超时后走规则评审，而不是把挂起原样传播给调用方
    expect(response.payload?.summary).toContain('CodeQualitySubAgent reviewed');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('uses the LLM result when the backend answers within the timeout', async () => {
    const respondingLLM = {
      generateObject: async () => ({ summary: 'llm review', issues: [] }),
    } as unknown as LLMService;

    const agent = new CodeQualitySubAgent({
      llmService: respondingLLM,
      reviewTimeoutMs: 5000,
    });

    const response = await agent.handleRequest(buildRequest());
    expect(response.payload?.summary).toContain('llm review');
  });
});
