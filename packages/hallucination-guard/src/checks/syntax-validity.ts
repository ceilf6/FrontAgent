import { extname } from 'node:path';
import type { HallucinationCheckResult } from '@frontagent/shared';
import ts from 'typescript';

export interface SyntaxValidityCheckInput {
  code: string;
  language: 'typescript' | 'javascript' | 'json' | 'yaml';
  filePath?: string;
}

export interface SyntaxErrorDetail {
  line: number;
  column: number;
  message: string;
  code?: number;
}

interface ParsedSourceFile extends ts.SourceFile {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
}

/** Validate source syntax synchronously for callers that run inside file tools. */
export function validateSourceSyntax(input: SyntaxValidityCheckInput): HallucinationCheckResult {
  const { code, language, filePath } = input;

  try {
    let errors: SyntaxErrorDetail[] = [];

    switch (language) {
      case 'typescript':
      case 'javascript':
        errors = checkJavaScriptSyntax(code, language, filePath);
        break;
      case 'json':
        errors = checkJsonSyntax(code);
        break;
      case 'yaml':
        // YAML parsing is intentionally outside the current validation scope.
        errors = [];
        break;
    }

    if (errors.length > 0) {
      return {
        pass: false,
        type: 'syntax_validity',
        severity: 'block',
        message: `Syntax errors found in ${filePath ?? 'code'}`,
        details: { errors, language },
      };
    }

    return {
      pass: true,
      type: 'syntax_validity',
      severity: 'info',
      message: `Syntax is valid for ${language}`,
    };
  } catch (error) {
    return {
      pass: false,
      type: 'syntax_validity',
      severity: 'block',
      message: `Syntax check failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { error: String(error) },
    };
  }
}

/**
 * Check source syntax while preserving the package's existing asynchronous API.
 */
export async function checkSyntaxValidity(
  input: SyntaxValidityCheckInput,
): Promise<HallucinationCheckResult> {
  return validateSourceSyntax(input);
}

function checkJavaScriptSyntax(
  code: string,
  language: 'typescript' | 'javascript',
  filePath?: string,
): SyntaxErrorDetail[] {
  const fenceError = checkOuterMarkdownFence(code);
  if (fenceError) return [fenceError];

  const fileName = filePath ?? (language === 'typescript' ? 'source.ts' : 'source.js');
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    false,
    getScriptKind(language, filePath),
  ) as ParsedSourceFile;

  const diagnostics = [...sourceFile.parseDiagnostics];

  // The parser intentionally accepts TypeScript-only constructs in JavaScript
  // mode. transpileModule adds the grammar diagnostics that distinguish JS/JSX
  // from TS/TSX without requiring a project-wide type check.
  if (language === 'javascript') {
    diagnostics.push(
      ...(ts.transpileModule(code, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          jsx: ts.JsxEmit.Preserve,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.Latest,
        },
      }).diagnostics ?? []),
    );
  }

  const seen = new Set<string>();
  return diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => formatDiagnostic(sourceFile, diagnostic))
    .filter((diagnostic) => {
      const key = `${diagnostic.code}:${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getScriptKind(language: 'typescript' | 'javascript', filePath?: string): ts.ScriptKind {
  switch (filePath ? extname(filePath).toLowerCase() : '') {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  }
}

function formatDiagnostic(sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic): SyntaxErrorDetail {
  const start = diagnostic.start ?? 0;
  const location = sourceFile.getLineAndCharacterOfPosition(
    Math.min(start, sourceFile.text.length),
  );
  return {
    line: location.line + 1,
    column: location.character + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    code: diagnostic.code,
  };
}

function checkOuterMarkdownFence(code: string): SyntaxErrorDetail | undefined {
  const lines = code.trim().split(/\r?\n/);
  if (lines.length < 2) return undefined;

  const first = lines[0].trim();
  const last = lines[lines.length - 1].trim();
  if (/^```[^`]*$/.test(first) && last === '```') {
    return {
      line: 1,
      column: 1,
      message: 'Markdown code fences are not valid file content',
    };
  }

  return undefined;
}

function checkJsonSyntax(code: string): SyntaxErrorDetail[] {
  try {
    JSON.parse(code);
    return [];
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      return [{ line: 1, column: 1, message: String(error) }];
    }

    const explicitLocation = error.message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (explicitLocation) {
      return [
        {
          line: Number.parseInt(explicitLocation[1], 10),
          column: Number.parseInt(explicitLocation[2], 10),
          message: error.message,
        },
      ];
    }

    const positionMatch = error.message.match(/(?:at position|position)\s+(\d+)/i);
    const position = positionMatch ? Number.parseInt(positionMatch[1], 10) : 0;
    const location = offsetToLocation(code, position);
    return [{ ...location, message: error.message }];
  }
}

function offsetToLocation(code: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < Math.min(offset, code.length); index++) {
    if (code[index] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
