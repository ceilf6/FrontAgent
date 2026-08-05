import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotManager } from '../snapshot.js';
import { createFile } from './create-file.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('createFile', () => {
  it('does not replace an existing file when overwrite is false', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-file-create-'));
    roots.push(root);
    const target = join(root, 'existing.ts');
    writeFileSync(target, 'existing content', 'utf-8');

    const result = createFile(
      { path: 'existing.ts', content: 'replacement' },
      root,
      new SnapshotManager(root),
    );

    expect(result.success).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('existing content');
  });

  it('creates a new file without overwrite permission', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-file-create-'));
    roots.push(root);

    const result = createFile(
      { path: 'new.ts', content: 'export const value = 1;' },
      root,
      new SnapshotManager(root),
    );

    expect(result.success).toBe(true);
    expect(readFileSync(join(root, 'new.ts'), 'utf-8')).toBe('export const value = 1;');
  });
});
