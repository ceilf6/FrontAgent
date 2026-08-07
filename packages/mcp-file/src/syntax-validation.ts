import { validateSourceSyntax } from '@frontagent/hallucination-guard';
import type { PatchResult } from '@frontagent/shared';

export function validateFileSyntax(content: string, filePath: string): PatchResult['validation'] {
  const language = detectSyntaxLanguage(filePath);
  if (!language) {
    return { syntaxValid: true, lintErrors: [], typeErrors: [] };
  }

  const result = validateSourceSyntax({ code: content, language, filePath });
  const errors =
    result.details && typeof result.details === 'object' && 'errors' in result.details
      ? (result.details.errors as Array<{
          line: number;
          column: number;
          message: string;
          code?: number;
        }>)
      : [];

  return {
    syntaxValid: result.pass,
    lintErrors: errors.map((error) => ({
      line: error.line,
      column: error.column,
      message: error.message,
      rule: error.code === undefined ? 'syntax/parser' : `syntax/TS${error.code}`,
      severity: 'error',
    })),
    typeErrors: [],
  };
}

export function syntaxValidationError(
  validation: PatchResult['validation'],
  filePath: string,
): string {
  const firstError = validation.lintErrors[0];
  if (!firstError) return `Syntax validation failed for ${filePath}`;
  return `Syntax validation failed for ${filePath}:${firstError.line}:${firstError.column}: ${firstError.message}`;
}

function detectSyntaxLanguage(filePath: string): 'typescript' | 'javascript' | 'json' | undefined {
  const extension = filePath.split('.').pop()?.toLowerCase();
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension ?? '')) return 'typescript';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension ?? '')) return 'javascript';
  if (extension === 'json') return 'json';
  return undefined;
}
