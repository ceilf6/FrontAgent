import { describe, expect, it } from 'vitest';
import {
  isLLMRequestFailure,
  stripLLMRequestTag,
  tagLLMRequestFailure,
} from './llm-request-error.js';

describe('LLM error transport', () => {
  it('recognizes and removes tags inside combined errors', () => {
    const message = '任务未能生成最终回答：[llm-request-failed] 404; [llm-request-failed] 401';
    expect(isLLMRequestFailure(message)).toBe(true);
    expect(stripLLMRequestTag(message)).toBe('任务未能生成最终回答：404; 401');
  });

  it('preserves Error subclass identity, metadata, cause and stack', () => {
    class ProviderError extends Error {
      statusCode = 429;
    }
    const cause = new Error('connection');
    const error = new ProviderError('rate limited', { cause });
    const stack = error.stack;
    expect(tagLLMRequestFailure(error)).toBe(error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.statusCode).toBe(429);
    expect(error.cause).toBe(cause);
    expect(error.stack).toBe(stack);
  });

  it('does not add another tag to a contextualized error', () => {
    const error = new Error('answer: [llm-request-failed] 404');
    expect(tagLLMRequestFailure(error)).toBe(error);
    expect(error.message).toBe('answer: [llm-request-failed] 404');
  });

  it('keeps untagged text byte-for-byte', () => {
    expect(stripLLMRequestTag('  file not found\n  details\n')).toBe(
      '  file not found\n  details\n',
    );
  });
});
