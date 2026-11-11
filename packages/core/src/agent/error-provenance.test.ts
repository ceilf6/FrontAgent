import type { ExecutionStep } from '@frontagent/shared';
import { describe, expect, it, vi } from 'vitest';
import { isLLMRequestFailure, tagLLMRequestFailure } from '../llm/llm-request-error.js';
import { Planner } from '../planner.js';
import type { AgentEvent, AgentSessionSnapshot } from '../types.js';
import { createAgent } from './agent.js';

function agentWithFailure() {
  return createAgent({
    projectRoot: '/test',
    llm: {
      provider: 'openai',
      model: 'test',
      backend: {
        name: 'test',
        generateText: async () => {
          throw tagLLMRequestFailure(new Error('404 Not Found'));
        },
        generateObject: async () => {
          throw tagLLMRequestFailure(new Error('401 Unauthorized'));
        },
      },
    },
    subAgents: { codeQualityEvaluator: { enableLLMReview: false } },
  });
}

describe('agent error provenance at output boundaries', () => {
  it('retains answer failure provenance for runtime formatting and cleans the completion event', async () => {
    const agent = agentWithFailure();
    const events: AgentEvent[] = [];
    agent.addEventListener((event) => events.push(event));
    const resume: AgentSessionSnapshot = {
      taskId: 'query-1',
      taskDescription: 'explain this file',
      taskType: 'query',
      plan: { steps: [], reasoning: 'read context', estimatedDuration: 0 },
      messages: [],
      files: { 'src/a.ts': 'export const answer = 42;' },
    };
    const result = await agent.execute('explain this file', { resume });
    expect(result.success).toBe(false);
    expect(result.error).toContain('任务未能生成最终回答');
    expect(isLLMRequestFailure(result.error ?? '')).toBe(true);
    const completed = events.find((e) => e.type === 'task_completed');
    expect(completed).toBeDefined();
    expect(JSON.stringify(completed)).not.toContain('[llm-request-failed]');
    expect(JSON.stringify(completed)).toContain('404 Not Found');
  });

  it.each(['planOnly', 'execute'] as const)(
    'cleans %s failure events without mutating the returned error',
    async (method) => {
      const agent = agentWithFailure();
      const events: AgentEvent[] = [];
      agent.addEventListener((event) => events.push(event));
      const spy = vi
        .spyOn(Planner.prototype, 'plan')
        .mockRejectedValue(tagLLMRequestFailure(new Error('401 Unauthorized')));
      try {
        const result = await agent[method]('explain this file');
        expect(isLLMRequestFailure(result.error ?? '')).toBe(true);
        const failed = events.find((e) => e.type === 'task_failed');
        expect(failed).toMatchObject({ error: '401 Unauthorized' });
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('cleans nested step errors for listeners without changing the execution state', () => {
    const agent = agentWithFailure();
    const events: AgentEvent[] = [];
    agent.addEventListener((event) => events.push(event));
    const error = '[llm-request-failed] 401 Unauthorized';
    const step: ExecutionStep = {
      stepId: 's1',
      description: 'generate code',
      action: 'create_file',
      tool: 'create_file',
      params: {},
      dependencies: [],
      validation: [],
      status: 'failed',
      result: { success: false, error, duration: 1 },
    };
    const emit = (event: AgentEvent) =>
      (agent as unknown as { emit(event: AgentEvent): void }).emit(event);
    emit({ type: 'step_failed', step, error });
    emit({ type: 'step_started', step });
    emit({ type: 'step_completed', step, result: step.result! });
    emit({
      type: 'planning_completed',
      plan: { steps: [step], reasoning: '', estimatedDuration: 0 },
    });
    emit({
      type: 'task_completed',
      result: {
        success: false,
        taskId: 't1',
        executedSteps: [step],
        error,
        duration: 1,
        validations: [],
        plannerFallbackReason: error,
      },
    });
    expect(events).toHaveLength(5);
    expect(JSON.stringify(events)).not.toContain('[llm-request-failed]');
    expect(JSON.stringify(events)).toContain('401 Unauthorized');
    expect(step.result?.error).toBe(error);
  });
});
