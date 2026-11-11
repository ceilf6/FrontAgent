export type SyntaxLanguage = 'typescript' | 'javascript' | 'json' | 'yaml';

export function detectSyntaxLanguage(path: string): SyntaxLanguage | null {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return null;
  }
}
