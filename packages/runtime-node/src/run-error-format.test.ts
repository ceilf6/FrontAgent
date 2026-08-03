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
  // #408 的原始复现。这条错误来自 apply_patch 技能自己
  // （executor-skills.ts: `Cannot apply patch: file not found in context: ${filePath}`），
  // 没有任何 LLM 调用失败——而它曾被改写成一次 404 供应商配置错误，还附上
  // 从配置里读来的 provider / model / baseURL。伪造的三元组让错误的故事看起来证据充分。
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
    // 原文必须保留：它是唯一准确的那部分，此前被整条替换掉
    expect(formatted).toContain('model does not exist');
    expect(formatted).toContain('Anthropic Messages API');
  });

  it('formats a real LLM auth failure and keeps the original message', () => {
    const formatted = formatRunError(fromLLM('401 Unauthorized: invalid api key'), input);

    expect(formatted).toContain('ANTHROPIC_API_KEY');
    expect(formatted).toContain('invalid api key');
  });

  // 打了标记但不属于已知的两类：仍然要说清是 LLM 失败，而不是默默退回首行——
  // 否则「来源已知」这条信息就白拿了。
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

  it('passes everything through untouched in debug mode', () => {
    const error = fromLLM('404 Not Found');

    expect(formatRunError(error, { ...input, debug: true })).toBe(error);
  });

  it('does not double-tag an already-tagged failure', () => {
    const once = fromLLM('404 Not Found');
    const twice = tagLLMRequestFailure(new Error(once));

    expect(twice instanceof Error ? twice.message : String(twice)).toBe(once);
  });
});
