import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultSDDConfig } from '@frontagent/sdd';
import { afterEach, describe, expect, it } from 'vitest';
import { HallucinationGuard } from './guard.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: string[], cannotImport = ['src/api/**']) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'fa-sdd-directory-'));
  roots.push(projectRoot);
  for (const file of files) {
    const path = join(projectRoot, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'export const value = 1;');
  }
  const config = structuredClone(defaultSDDConfig);
  config.moduleBoundaries = [{ from: 'src/components/**', canImport: [], cannotImport }];
  const guard = new HallucinationGuard({ projectRoot, sddConfig: config });
  return (specifier = '../api') =>
    guard.validateSDDCompliance({
      action: 'create_file',
      targetPath: 'src/components/Card.ts',
      content: `import { value } from '${specifier}'; export { value };`,
    });
}

describe('SDD relative directory entry resolution', () => {
  it('blocks the existing directory index entry', async () => {
    const validate = fixture(['src/api/index.ts']);
    expect((await validate()).pass).toBe(false);
  });

  it('selects the existing same-name file ahead of the directory index', async () => {
    const validate = fixture(['src/api.ts', 'src/api/index.ts']);
    expect((await validate()).pass).toBe(true);
  });

  it('resolves an explicit directory slash to the index despite a same-name file', async () => {
    const validate = fixture(['src/api.ts', 'src/api/index.ts']);
    expect((await validate('../api/')).pass).toBe(false);
  });

  it('retains rules written against the original specifier', async () => {
    const validate = fixture(['src/api.ts'], ['../api']);
    expect((await validate()).pass).toBe(false);
  });

  it('retains lexical module-path rules when an extension is resolved', async () => {
    const validate = fixture(['src/api.ts'], ['src/api']);
    expect((await validate()).pass).toBe(false);
  });

  it('does not infer index from a directory with no entry file', async () => {
    const validate = fixture(['src/api/unrelated.ts']);
    expect((await validate()).pass).toBe(true);
  });

  it('does not resolve aliases as relative modules', async () => {
    const validate = fixture(['src/api/index.ts']);
    expect((await validate('@/api')).pass).toBe(true);
  });
});
