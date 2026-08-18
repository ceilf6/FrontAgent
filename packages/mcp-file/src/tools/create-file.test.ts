import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('rejects invalid source content before creating a file or snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-file-create-'));
    roots.push(root);
    const manager = new SnapshotManager(root);

    const result = createFile({ path: 'broken.ts', content: 'const value = ;' }, root, manager);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/syntax validation failed/i);
    expect(existsSync(join(root, 'broken.ts'))).toBe(false);
    expect(manager.getFileSnapshots(join(root, 'broken.ts'))).toHaveLength(0);
  });

  it('allows trusted in-process callers to disable syntax validation', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-file-create-'));
    roots.push(root);

    const result = createFile(
      {
        path: 'broken.ts',
        content: 'const value = ;',
        __frontagentSyntaxValidationEnabled: false,
      },
      root,
      new SnapshotManager(root),
    );

    expect(result.success).toBe(true);
    expect(readFileSync(join(root, 'broken.ts'), 'utf-8')).toBe('const value = ;');
  });

  it('accepts JSONC for known configuration paths and keeps ordinary JSON strict', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-file-create-'));
    roots.push(root);
    const manager = new SnapshotManager(root);
    const jsonc = '{\n  // compiler settings\n  "compilerOptions": { "strict": true, },\n}';

    expect(createFile({ path: 'tsconfig.json', content: jsonc }, root, manager).success).toBe(true);
    expect(createFile({ path: 'package.json', content: jsonc }, root, manager).success).toBe(false);
    expect(existsSync(join(root, 'package.json'))).toBe(false);
  });

  it('preserves a file created concurrently before the exclusive write', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-file-create-'));
    roots.push(root);
    const target = join(root, 'raced.ts');

    class RacingSnapshotManager extends SnapshotManager {
      override createSnapshot(filePath: string, operation: 'create' | 'modify' | 'delete'): string {
        const snapshotId = super.createSnapshot(filePath, operation);
        writeFileSync(target, 'concurrent writer', 'utf-8');
        return snapshotId;
      }
    }

    const manager = new RacingSnapshotManager(root);
    const result = createFile(
      { path: 'raced.ts', content: 'export const ours = true;' },
      root,
      manager,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/appeared concurrently/i);
    expect(readFileSync(target, 'utf-8')).toBe('concurrent writer');
    expect(manager.getFileSnapshots(target)).toHaveLength(0);
    expect(readdirSync(join(root, '.frontagent', 'snapshots'))).toHaveLength(0);
  });

  it('honors overwrite intent when a file appears between the check and the write', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-file-create-'));
    roots.push(root);
    const target = join(root, 'raced.ts');

    class RacingSnapshotManager extends SnapshotManager {
      override createSnapshot(filePath: string, operation: 'create' | 'modify' | 'delete'): string {
        const snapshotId = super.createSnapshot(filePath, operation);
        writeFileSync(target, 'concurrent writer', 'utf-8');
        return snapshotId;
      }
    }

    const manager = new RacingSnapshotManager(root);
    const result = createFile(
      {
        path: 'raced.ts',
        content: 'export const ours = true;',
        overwrite: true,
        __frontagentSecurityApproved: true,
      },
      root,
      manager,
    );

    expect(result.success).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('export const ours = true;');
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
