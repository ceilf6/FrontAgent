import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { handleFilesenseTool } from './tools.js';

it('warns for a missing first scan path and still scans subsequent existing roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fa-navigation-'));
  try {
    await mkdir(join(root, 'src/features/checkout/hooks'), { recursive: true });
    await writeFile(
      join(root, 'src/features/checkout/hooks/useTotal.ts'),
      'export const total = 1;',
    );
    const result = await handleFilesenseTool(
      'filesense_navigate',
      {
        paths: ['hooks', 'src/features/checkout'],
        depth: 2,
        writeMode: 'none',
      },
      root,
    );
    expect(result).toMatchObject({
      success: true,
      data: { warnings: ['Path does not exist: hooks'] },
    });
    expect((result.data as { scanned: { entries: number } }).scanned.entries).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps relative scan paths anchored to the project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fa-navigation-'));
  try {
    await mkdir(join(root, 'src/features/checkout'), { recursive: true });
    await writeFile(join(root, 'src/features/checkout/index.ts'), 'export const total = 1;');
    const result = await handleFilesenseTool(
      'filesense_navigate',
      {
        paths: ['src/features/checkout'],
        depth: 1,
        writeMode: 'none',
      },
      root,
    );
    expect(result).toMatchObject({ success: true, data: { warnings: [] } });
    expect((result.data as { scanned: { entries: number } }).scanned.entries).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
