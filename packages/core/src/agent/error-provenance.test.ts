import type { ExecutionStep } from '@frontagent/shared';
import { describe, expect, it, vi } from 'vitest';
import { Executor } from '../executor.js';
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

it('keeps retained planning events independent from subsequent execution errors', () => {
  const agent = agentWithFailure();
  const events: AgentEvent[] = [];
  agent.addEventListener((event) => events.push(event));
  const step: ExecutionStep = {
    stepId: 's1',
    description: 'read',
    action: 'read_file',
    tool: 'read_file',
    params: {},
    dependencies: [],
    validation: [],
    status: 'pending',
  };
  (agent as unknown as { emit(event: AgentEvent): void }).emit({
    type: 'planning_completed',
    plan: { steps: [step], reasoning: '', estimatedDuration: 0 },
  });
  step.result = { success: false, error: '[llm-request-failed] 401 Unauthorized', duration: 1 };
  expect(JSON.stringify(events)).not.toContain('[llm-request-failed]');
});

it('cleans validation diagnostics in completion and validation events', () => {
  const agent = agentWithFailure();
  const events: AgentEvent[] = [];
  agent.addEventListener((event) => events.push(event));
  const error = '[llm-request-failed] 401 Unauthorized';
  const validation = { pass: false, results: [], blockedBy: [error] };
  const emit = (event: AgentEvent) =>
    (agent as unknown as { emit(event: AgentEvent): void }).emit(event);
  emit({ type: 'validation_failed', stage: 'pre_write', result: validation });
  emit({
    type: 'task_completed',
    result: {
      success: false,
      taskId: 't',
      executedSteps: [],
      duration: 1,
      validations: [validation],
    },
  });
  expect(JSON.stringify(events)).not.toContain('[llm-request-failed]');
  expect(validation.blockedBy).toEqual([error]);
});

it('cleans failed-step validations in the returned task result', async () => {
  const agent = agentWithFailure();
  const events: AgentEvent[] = [];
  agent.addEventListener((event) => events.push(event));
  const error = '[llm-request-failed] 401 Unauthorized';
  const validation = { pass: false, results: [], blockedBy: [error] };
  const spy = vi
    .spyOn(Executor.prototype, 'executeStepsWithErrorFeedback')
    .mockImplementation(async (steps, _context, onStart, onComplete) => {
      const step = steps[0];
      onStart?.(step);
      const output = {
        stepResult: { success: false, error, duration: 1 },
        validation,
        needsRollback: true,
      };
      step.status = 'failed';
      step.result = output.stepResult;
      onComplete?.(step, output);
      return [output];
    });
  try {
    const result = await agent.execute('read file', {
      resume: {
        taskId: 't',
        taskDescription: 'read file',
        taskType: 'modify',
        messages: [],
        files: {},
        plan: {
          steps: [
            {
              stepId: 's1',
              description: 'read',
              action: 'read_file',
              tool: 'read_file',
              params: { path: 'src/a.ts' },
              dependencies: [],
              validation: [],
              status: 'pending',
            },
          ],
          reasoning: '',
          estimatedDuration: 0,
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.validations[0].blockedBy).toEqual(['401 Unauthorized']);
    expect(result.executedSteps[0].result?.error).toBe('401 Unauthorized');
    expect(isLLMRequestFailure(result.error ?? '')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('[llm-request-failed]');
    expect(validation.blockedBy).toEqual([error]);
  } finally {
    spy.mockRestore();
  }
});
