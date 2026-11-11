import { resolve } from 'node:path';
import { defaultSDDConfig } from '@frontagent/sdd';
import { describe, expect, it } from 'vitest';
import { HallucinationGuard } from './guard.js';

describe('SDD-only guard validation', () => {
  it('does not check file existence, import availability, or syntax', async () => {
    const guard = new HallucinationGuard({
      projectRoot: '/project',
      sddConfig: structuredClone(defaultSDDConfig),
    });
    const result = await guard.validateSDDCompliance({
      action: 'create_file',
      targetPath: 'new.ts',
      content: "import x from './later'; const invalid = ;",
    });
    expect(result.pass).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe('sdd_compliance');
  });

  it('normalizes absolute and dot-segment target paths for SDD patterns', async () => {
    const config = structuredClone(defaultSDDConfig);
    config.moduleBoundaries = [
      { from: 'src/components/**', canImport: [], cannotImport: ['src/api/**'] },
    ];
    const guard = new HallucinationGuard({ projectRoot: '/project', sddConfig: config });
    for (const targetPath of [
      resolve('/project/src/components/Component.ts'),
      './src/components/../components/Component.ts',
    ]) {
      const result = await guard.validateSDDCompliance({
        action: 'create_file',
        targetPath,
        content: "import { api } from '../api/client';",
      });
      expect(result.pass).toBe(false);
      expect(result.blockedBy?.join(' ')).toContain('cannot import');
    }
  });

  it('extracts type imports and import-equals without interpreting source examples as dependencies', async () => {
    const config = structuredClone(defaultSDDConfig);
    config.techStack.forbiddenPackages = ['bad'];
    const guard = new HallucinationGuard({ projectRoot: '/project', sddConfig: config });
    for (const content of [
      "import type { T } from 'bad/types';",
      "import x = require('bad/subpath');",
      "type T = import('bad/types').T;",
    ]) {
      const result = await guard.validateSDDCompliance({
        action: 'create_file',
        targetPath: 'a.ts',
        content,
      });
      expect(result.pass).toBe(false);
    }
  });

  it('keeps explicit dependency metadata supported for callers without source content', async () => {
    const config = structuredClone(defaultSDDConfig);
    config.techStack.forbiddenPackages = ['bad'];
    const guard = new HallucinationGuard({ projectRoot: '/project', sddConfig: config });
    const result = await guard.validateSDDCompliance({
      action: 'create_file',
      dependencies: ['bad'],
    });
    expect(result.pass).toBe(false);
  });

  it('shares SDD behavior with the integrated entry point', async () => {
    const config = structuredClone(defaultSDDConfig);
    config.codeQuality.forbiddenPatterns = ['BANNED'];
    const guard = new HallucinationGuard({
      projectRoot: '/project',
      sddConfig: config,
      enabledChecks: { fileExistence: false, syntaxValidity: false, importValidity: false },
    });
    const output = {
      action: 'create_file' as const,
      targetPath: 'a.ts',
      content: 'const BANNED = 1;',
    };
    expect(await guard.validate(output)).toEqual(await guard.validateSDDCompliance(output));
    guard.setCheckEnabled('sddCompliance', false);
    expect(await guard.validateSDDCompliance(output)).toEqual({ pass: true, results: [] });
  });
});
