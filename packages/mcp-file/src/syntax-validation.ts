import { validateSourceSyntax } from '@frontagent/hallucination-guard';
import { detectSyntaxLanguage, type PatchResult } from '@frontagent/shared';

export function validateFileSyntax(content: string, filePath: string): PatchResult['validation'] {
  const language = detectSyntaxLanguage(filePath);
  if (!language) {
    return { syntaxValid: true, lintErrors: [], typeErrors: [] };
  }

  const result = validateSourceSyntax({ code: content, language, filePath });
  const errors = result.details?.errors ?? [];

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
