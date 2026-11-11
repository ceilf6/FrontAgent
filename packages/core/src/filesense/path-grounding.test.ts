import { describe, expect, it } from 'vitest';
import { groundStepPath, type PathGroundingFacts } from './path-grounding.js';

function facts(dirs: Record<string, string[]>): PathGroundingFacts {
  const directoryContents = new Map(Object.entries(dirs));
  const existingFiles = new Set(Object.values(dirs).flat());
  return { existingFiles, directoryContents };
}

const checkout = facts({
  'src/features/checkout/lib': [
    'src/features/checkout/lib/computeTotal.test.ts',
    'src/features/checkout/lib/computeTotal.ts',
    'src/features/checkout/lib/format.ts',
  ],
});

describe('groundStepPath', () => {
  // 2026-08-02 消融实验里实际出现的三个幻觉文件名，导航都看见了真实文件。
  it.each([
    ['src/features/checkout/lib/calculateTotal.ts', 'src/features/checkout/lib/computeTotal.ts'],
  ])('corrects the hallucinated %s', (ghost, real) => {
    const out = groundStepPath(ghost, 'read_file', checkout);
    expect(out.path).toBe(real);
    expect(out.corrected).toMatchObject({ from: ghost, to: real });
  });

  it('keeps a path that really exists', () => {
    const p = 'src/features/checkout/lib/computeTotal.ts';
    expect(groundStepPath(p, 'read_file', checkout)).toEqual({ path: p });
  });

  // create_file 的目标本来就不该存在。对它接地会把每一次新建改写成覆盖既有文件。
  it('never touches create_file, whose target is supposed to be absent', () => {
    const p = 'src/features/checkout/lib/truncate.ts';
    expect(groundStepPath(p, 'create_file', checkout)).toEqual({ path: p });
  });

  // 目录没被完整枚举过时，「不在清单里」不等于「不存在」——预算截断就是这种情况。
  it('declines when the directory was never fully enumerated', () => {
    const noListing: PathGroundingFacts = {
      existingFiles: new Set(),
      directoryContents: new Map(),
    };
    const p = 'src/features/checkout/lib/calculateTotal.ts';
    expect(groundStepPath(p, 'read_file', noListing)).toEqual({ path: p });
  });

  // 押一个次优候选，是把看得见的错误换成看不见的错误。
  it('declines when no candidate shares a token with the guess', () => {
    const entities = facts({
      'src/entities/coupon/model': [
        'src/entities/coupon/model/coupon.ts',
        'src/entities/coupon/model/guards.ts',
      ],
    });
    const p = 'src/entities/coupon/model/types.ts';
    const out = groundStepPath(p, 'read_file', entities);
    expect(out.path).toBe(p);
    expect(out.corrected).toBeUndefined();
    expect(out.declined?.reason).toBe('候选与原名无共同词元');
  });

  it('declines when two candidates score alike', () => {
    const tie = facts({
      'src/lib': ['src/lib/mergeLeft.ts', 'src/lib/mergeRight.ts'],
    });
    const out = groundStepPath('src/lib/mergeThing.ts', 'read_file', tie);
    expect(out.corrected).toBeUndefined();
    expect(out.declined?.reason).toBe('最佳候选未明显优于次佳');
  });

  // 实现文件不能被配到同名测试文件上。
  it('does not match an implementation guess to a .test file', () => {
    const out = groundStepPath('src/features/checkout/lib/computeTotals.ts', 'read_file', checkout);
    expect(out.path).toBe('src/features/checkout/lib/computeTotal.ts');
  });

  it('matches a test-file guess only against test files', () => {
    const out = groundStepPath(
      'src/features/checkout/lib/calculateTotal.test.ts',
      'read_file',
      checkout,
    );
    expect(out.path).toBe('src/features/checkout/lib/computeTotal.test.ts');
  });
});
