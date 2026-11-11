import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { navigate } from './engine.js';

/**
 * `factsDelta` 的跨包契约：清单**是否被裁剪**必须如实上报。
 *
 * 消费方（core 的 path-grounding）据此决定敢不敢把「不在清单里」读作
 * 「文件不存在」，进而改写计划里的路径。拿一份被悄悄截断的清单去否定
 * 一个真实存在的路径，会把本来能跑通的步骤改坏。
 *
 * 关键区别：`scanned.truncated` 只反映扫描有没有触到 maxEntries / 超时，
 * 与这里的定长裁剪**无关**——扫描顺利完成时，超过 200 条的目录照样被切尾。
 */

const roots: string[] = [];

function makeRepo(fileCount: number): string {
  // macOS 的 /var 是指向 /private/var 的符号链接，不规范化会撞边界检查
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'facts-delta-')));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(root, 'src', `mod${String(i).padStart(4, '0')}.ts`), 'export {}\n');
  }
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('factsDelta 裁剪契约', () => {
  it('reports an unabridged listing as untruncated', async () => {
    const root = makeRepo(5);

    const result = await navigate(root, { boundary: root, paths: ['src'], maxEntries: 1000 });

    expect(result.factsDelta.filesTruncated).toBe(false);
    expect(result.factsDelta.directoriesTruncated).toBe(false);
    expect(result.factsDelta.existingFiles.length).toBe(5);
  });

  // 这条是本契约存在的理由：扫描本身没被截断，清单却被切掉了尾巴。
  // 只看 scanned.truncated 的消费方会把这份残缺清单当成完整枚举。
  it('flags the 200-entry slice even when the scan itself completed', async () => {
    const root = makeRepo(260);

    const result = await navigate(root, { boundary: root, paths: ['src'], maxEntries: 5000 });

    expect(result.scanned.truncated).toBe(false);
    expect(result.factsDelta.existingFiles.length).toBe(200);
    expect(result.factsDelta.filesTruncated).toBe(true);
  });

  it('flags the further compaction applied past maxBytes', async () => {
    const root = makeRepo(150);

    const result = await navigate(root, {
      boundary: root,
      paths: ['src'],
      maxEntries: 5000,
      maxBytes: 2048,
    });

    expect(result.factsDelta.existingFiles.length).toBeLessThanOrEqual(80);
    expect(result.factsDelta.filesTruncated).toBe(true);
  });
});
