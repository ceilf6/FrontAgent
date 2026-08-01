import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchCode } from './search-code.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'search-code-regex-'));
  mkdirSync(join(root, 'src/features/checkout/lib'), { recursive: true });
  writeFileSync(
    join(root, 'src/features/checkout/lib/computeTotal.ts'),
    'export function computeTotal(lines: number[]) {\n  return lines.length;\n}\n',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('search_code 面对非法正则', () => {
  // 实测的四连崩：模型把 glob 写进 pattern，`**` 在正则里是 `Nothing to repeat`。
  // 崩溃打击的正是导航失手后的兜底路径（issue #433）。
  it('does not fail the whole search when pattern is an invalid regex', async () => {
    const result = await searchCode({ pattern: 'src/features/checkout/**' }, root);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // 降级顺序：有 query 就用 query。把 glob 当字面量去搜内容必然是空结果，
  // 而空结果会被读成「仓库里没有」——比崩溃更难发现。
  it('falls back to query rather than to a literal glob', async () => {
    const result = await searchCode(
      { query: 'computeTotal', pattern: '**/*.test.ts|**/*.spec.ts' },
      root,
    );

    expect(result.success).toBe(true);
    expect(result.matches?.length).toBeGreaterThan(0);
    expect(result.matches?.[0]?.file).toContain('computeTotal.ts');
  });

  // 静默降级等于伪造证据，必须说出来，且要指明该换哪个参数。
  it('reports the downgrade and names the parameter to use instead', async () => {
    const result = await searchCode(
      { query: 'computeTotal', pattern: 'src/features/checkout/**' },
      root,
    );

    expect(result.warnings?.[0]).toContain('filePattern');
    expect(result.warnings?.[0]).toContain('已改用 query 搜索');
  });

  it('warns that a literal fallback may return nothing when there is no query', async () => {
    const result = await searchCode({ pattern: 'src/**' }, root);

    expect(result.success).toBe(true);
    expect(result.warnings?.[0]).toContain('字面量');
  });

  it('still honours a valid regex', async () => {
    const result = await searchCode({ pattern: 'compute[A-Z]\\w+' }, root);

    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(result.matches?.length).toBeGreaterThan(0);
  });
});
