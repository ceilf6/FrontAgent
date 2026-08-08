import { describe, expect, it } from 'vitest';
import { checkSyntaxValidity } from './syntax-validity.js';

describe('checkSyntaxValidity', () => {
  describe('typescript/javascript', () => {
    it('passes for valid code', async () => {
      const code = `function hello() {\n  return "world";\n}`;
      const result = await checkSyntaxValidity({ code, language: 'typescript' });
      expect(result.pass).toBe(true);
    });

    it('accepts valid strings, multiline templates, regexes, and TSX', async () => {
      const cases = [
        {
          code: `export const msg = "it's fine";`,
          language: 'typescript' as const,
          filePath: 'src/message.ts',
        },
        {
          code: 'export const message = `first line\nsecond line`;',
          language: 'typescript' as const,
          filePath: 'src/template.ts',
        },
        {
          code: 'export const pattern = /[{}()[\\]]/;',
          language: 'javascript' as const,
          filePath: 'src/pattern.js',
        },
        {
          code: `export const Card = () => <p>Don't panic</p>;`,
          language: 'typescript' as const,
          filePath: 'src/Card.tsx',
        },
      ];

      for (const input of cases) {
        await expect(checkSyntaxValidity(input)).resolves.toEqual(
          expect.objectContaining({ pass: true }),
        );
      }
    });

    it('uses the real extension to distinguish TSX and JSX', async () => {
      const tsx = await checkSyntaxValidity({
        code: 'export const Card = () => <div />;',
        language: 'typescript',
        filePath: 'src/Card.tsx',
      });
      const ts = await checkSyntaxValidity({
        code: 'export const Card = () => <div />;',
        language: 'typescript',
        filePath: 'src/Card.ts',
      });
      const jsx = await checkSyntaxValidity({
        code: 'export const Card = () => <div />;',
        language: 'javascript',
        filePath: 'src/Card.jsx',
      });
      const jsWithTypes = await checkSyntaxValidity({
        code: 'const value: number = 1;',
        language: 'javascript',
        filePath: 'src/value.js',
      });

      expect(tsx.pass).toBe(true);
      expect(ts.pass).toBe(false);
      expect(jsx.pass).toBe(true);
      expect(jsWithTypes.pass).toBe(false);
    });

    it('reports parser diagnostics with location and code', async () => {
      const result = await checkSyntaxValidity({
        code: 'const ok = 1;\nconst broken: number = ;',
        language: 'typescript',
        filePath: 'src/broken.ts',
      });

      expect(result.pass).toBe(false);
      expect(result.details).toEqual(
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({ line: 2, column: expect.any(Number), code: 1109 }),
          ]),
        }),
      );
    });

    it('rejects an outer markdown code fence but allows fences inside a template', async () => {
      const fenced = await checkSyntaxValidity({
        code: '```ts\nexport const value = 1;\n```',
        language: 'typescript',
        filePath: 'src/value.ts',
      });
      const template = await checkSyntaxValidity({
        code: 'export const markdown = `\n\\`\\`\\`md\ntext\n\\`\\`\\`\n`;',
        language: 'typescript',
        filePath: 'src/markdown.ts',
      });

      expect(fenced.pass).toBe(false);
      expect(fenced.details).toEqual(
        expect.objectContaining({
          errors: [
            expect.objectContaining({ message: expect.stringMatching(/markdown code fences/i) }),
          ],
        }),
      );
      expect(template.pass).toBe(true);
    });

    it('detects unclosed brackets', async () => {
      const code = `function hello() {\n  return "world";\n`;
      const result = await checkSyntaxValidity({ code, language: 'typescript' });
      expect(result.pass).toBe(false);
      expect(result.message).toMatch(/syntax errors/i);
    });

    it('detects mismatched brackets', async () => {
      const code = 'const arr = [1, 2, 3);';
      const result = await checkSyntaxValidity({ code, language: 'javascript' });
      expect(result.pass).toBe(false);
    });

    it('ignores brackets in strings', async () => {
      const code = `const s = "hello { world }";`;
      const result = await checkSyntaxValidity({ code, language: 'typescript' });
      expect(result.pass).toBe(true);
    });

    it('ignores brackets in comments', async () => {
      const code = '// this has { unclosed\nconst x = 1;';
      const result = await checkSyntaxValidity({ code, language: 'typescript' });
      expect(result.pass).toBe(true);
    });

    it('ignores brackets in multi-line comments', async () => {
      const code = '/* { unclosed */\nconst x = 1;';
      const result = await checkSyntaxValidity({ code, language: 'typescript' });
      expect(result.pass).toBe(true);
    });
  });

  describe('json', () => {
    it('passes for valid JSON', async () => {
      const code = `{"name": "test", "version": "1.0.0"}`;
      const result = await checkSyntaxValidity({ code, language: 'json' });
      expect(result.pass).toBe(true);
    });

    it('accepts JSONC only for known configuration paths', async () => {
      const jsonc = '{\n  // compiler settings\n  "compilerOptions": { "strict": true, },\n}';
      const paths = [
        'tsconfig.json',
        'configs/tsconfig.build.json',
        'jsconfig.web.json',
        '.vscode/settings.json',
        '.vscode/tasks.json',
        '.vscode/launch.json',
        '.vscode/extensions.json',
        '.vscode/mcp.json',
        '.devcontainer.json',
        '.devcontainer/devcontainer.json',
        '.devcontainer/node/devcontainer.json',
        '.eslintrc.json',
        'turbo.jsonc',
        'C:\\repo\\.vscode\\tasks.json',
      ];

      for (const filePath of paths) {
        await expect(
          checkSyntaxValidity({ code: jsonc, language: 'json', filePath }),
        ).resolves.toEqual(expect.objectContaining({ pass: true }));
      }
    });

    it('keeps package and application JSON strict', async () => {
      const jsonc = '{\n  // not valid strict JSON\n  "name": "test",\n}';

      for (const filePath of [
        'package.json',
        'nested/package.json',
        'data.json',
        'turbo.json',
        '.frontagent/settings.json',
        '.vscode/data.json',
        '.vscode/package.json',
      ]) {
        const result = await checkSyntaxValidity({ code: jsonc, language: 'json', filePath });
        expect(result.pass).toBe(false);
      }
    });

    it('rejects non-JSON values and unquoted keys in JSONC files', async () => {
      for (const code of ['{foo: 1}', '{"x": undefined}', '{"x": NaN}']) {
        const result = await checkSyntaxValidity({
          code,
          language: 'json',
          filePath: 'tsconfig.json',
        });
        expect(result.pass).toBe(false);
      }
    });

    it('reports malformed JSONC configuration syntax', async () => {
      const result = await checkSyntaxValidity({
        code: '{\n  "compilerOptions": {\n',
        language: 'json',
        filePath: 'tsconfig.json',
      });

      expect(result.pass).toBe(false);
      expect(result.details).toEqual(
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({ line: expect.any(Number), column: expect.any(Number) }),
          ]),
        }),
      );
    });

    it('detects invalid JSON', async () => {
      const code = `{name: "test"}`;
      const result = await checkSyntaxValidity({ code, language: 'json' });
      expect(result.pass).toBe(false);
      expect(result.type).toBe('syntax_validity');
    });

    it('detects trailing commas in JSON', async () => {
      const code = `{"a": 1,}`;
      const result = await checkSyntaxValidity({ code, language: 'json' });
      expect(result.pass).toBe(false);
    });
  });

  describe('yaml', () => {
    it('passes for any YAML (simplified check)', async () => {
      const code = 'key: value\nnested:\n  child: true';
      const result = await checkSyntaxValidity({ code, language: 'yaml' });
      expect(result.pass).toBe(true);
    });
  });

  it('includes filePath in error message when provided', async () => {
    const code = '{invalid';
    const result = await checkSyntaxValidity({
      code,
      language: 'typescript',
      filePath: 'src/broken.ts',
    });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('src/broken.ts');
  });
});
