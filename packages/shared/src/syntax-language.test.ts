import { describe, expect, it } from 'vitest';
import { detectSyntaxLanguage } from './syntax-language.js';

describe('detectSyntaxLanguage', () => {
  it.each([
    ['file.tsx', 'typescript'],
    ['file.cts', 'typescript'],
    ['file.jsx', 'javascript'],
    ['file.cjs', 'javascript'],
    ['package.json', 'json'],
    ['turbo.jsonc', 'json'],
    ['config.yml', 'yaml'],
    ['README.md', null],
  ] as const)('maps %s to %s', (path, expected) => {
    expect(detectSyntaxLanguage(path)).toBe(expected);
  });
});
