import { tagLLMRequestFailure } from '@frontagent/core';
import { describe, expect, it } from 'vitest';
import { formatRunError } from './run.js';

const input = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  baseURL: undefined,
  debug: false,
};

/** 一次真实 LLM 请求失败在到达这里时的形态：标记由 llm-service 打上，消息已被拍平。 */
function fromLLM(message: string): string {
  const tagged = tagLLMRequestFailure(new Error(message));
  return tagged instanceof Error ? tagged.message : String(tagged);
}

describe('formatRunError classifies by provenance, not by substring', () => {
  it('leaves a tool error that merely contains "not found" alone', () => {
    const error = 'Cannot apply patch: file not found in context: src/hooks/useDebounce.ts';

    const formatted = formatRunError(error, input);

    expect(formatted).toBe(error);
    expect(formatted).not.toContain('404');
    expect(formatted).not.toContain('claude-3-5-sonnet-20241022');
    expect(formatted).not.toContain('provider=');
  });

  it.each([
    ['Command failed: vitest run — 1 test not found', 'a failing test command'],
    ['ENOENT: no such file or directory, open "src/a.ts"', 'a filesystem error'],
    ['File src/a.ts does not exist (404 in the docs)', 'prose that mentions 404'],
  ])('leaves %s alone (%s)', (error) => {
    expect(formatRunError(error, input)).toBe(error);
  });

  it('formats a real LLM 404 and keeps the original message', () => {
    const formatted = formatRunError(fromLLM('404 Not Found: model does not exist'), input);

    expect(formatted).toContain('404 Not Found');
    expect(formatted).toContain('provider=anthropic');
    expect(formatted).toContain('model does not exist');
    expect(formatted).toContain('Anthropic Messages API');
  });

  it('formats a real LLM auth failure and keeps the original message', () => {
    const formatted = formatRunError(fromLLM('401 Unauthorized: invalid api key'), input);

    expect(formatted).toContain('ANTHROPIC_API_KEY');
    expect(formatted).toContain('invalid api key');
  });

  it('still reports an unclassified LLM failure as an LLM failure', () => {
    const formatted = formatRunError(fromLLM('socket hang up'), input);

    expect(formatted).toContain('LLM 请求失败');
    expect(formatted).toContain('socket hang up');
  });

  it('never leaks the machine tag into user-facing text', () => {
    for (const error of [fromLLM('404 Not Found'), fromLLM('401'), fromLLM('boom')]) {
      expect(formatRunError(error, input)).not.toContain('[llm-request-failed]');
    }
  });

  it('preserves full error detail without the transport tag in debug mode', () => {
    const error = fromLLM('404 Not Found\nprovider details');

    expect(formatRunError(error, { ...input, debug: true })).toBe(
      '404 Not Found\nprovider details',
    );
  });

  it('does not double-tag an already-tagged failure', () => {
    const once = fromLLM('404 Not Found');
    const twice = tagLLMRequestFailure(new Error(once));

    expect(twice instanceof Error ? twice.message : String(twice)).toBe(once);
  });
});

it.each(['404 Not Found', '401 Unauthorized'])(
  'formats contextualized %s without leaking tags',
  (cause) => {
    const formatted = formatRunError(`任务未能生成最终回答：${fromLLM(cause)}`, input);
    expect(formatted).toContain(cause);
    expect(formatted).toContain(
      cause.startsWith('404') ? 'provider=anthropic' : 'ANTHROPIC_API_KEY',
    );
    expect(formatted).not.toContain('[llm-request-failed]');
  },
);
