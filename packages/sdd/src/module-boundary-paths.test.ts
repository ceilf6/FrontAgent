import { describe, expect, it } from 'vitest';
import { defaultSDDConfig } from './schema.js';
import { SDDValidator } from './validator.js';

function validator() {
  const config = structuredClone(defaultSDDConfig);
  config.moduleBoundaries = [
    { from: 'src/components/**', canImport: ['src/utils/**'], cannotImport: ['src/api/**'] },
  ];
  return new SDDValidator(config);
}

describe('project-relative SDD module boundaries', () => {
  it('blocks a relative import into a forbidden module', () => {
    const result = validator().validate({
      type: 'create_file',
      targetPath: 'src/components/Card.ts',
      imports: ['../api/client'],
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'module_boundary', type: 'error' }),
    );
  });

  it('accepts a relative import into the allowed module without spurious warnings', () => {
    const result = validator().validate({
      type: 'apply_patch',
      targetPath: 'src/components/Card.ts',
      imports: ['../utils/format'],
    });
    expect(result.violations).toEqual([]);
  });

  it('still warns about a relative import outside the allowed modules', () => {
    const result = validator().validate({
      type: 'apply_patch',
      targetPath: 'src/components/Card.ts',
      imports: ['../other/format'],
    });
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'module_boundary', type: 'warning' }),
    );
  });

  it('keeps raw-specifier rules and external imports supported', () => {
    const config = structuredClone(defaultSDDConfig);
    config.moduleBoundaries = [{ from: 'src/**', canImport: [], cannotImport: ['../private/*'] }];
    const result = new SDDValidator(config).validate({
      type: 'create_file',
      targetPath: 'src/a.ts',
      imports: ['../private/key', 'react'],
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });
});
