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
  // 无 query 可退时**不做**字面量兜底：那会得到「成功 + 0 命中」，
  // phase-runner 判为 completed，模型既读不到 warning 也不进恢复流程，
  // 空结果于是被读成「仓库里没有」——比崩溃更难发现。
  it('returns an actionable failure when there is no query to fall back to', async () => {
    const result = await searchCode({ pattern: 'src/features/checkout/**' }, root);

    expect(result.success).toBe(false);
    expect(result.error).toContain('filePattern');
    expect(result.error).toContain('Nothing to repeat');
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

  it('still honours a valid regex', async () => {
    const result = await searchCode({ pattern: 'compute[A-Z]\\w+' }, root);

    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(result.matches?.length).toBeGreaterThan(0);
  });
});
