import { relative, resolve } from 'node:path';
import type { AgentAction } from '@frontagent/sdd';
import { detectSyntaxLanguage, normalizePath } from '@frontagent/shared';
import ts from 'typescript';
import type { AgentOutput } from '../guard.js';

/** Static module references only: comments and string examples are not dependencies. */
function sourceImports(content: string, filePath: string): string[] {
  const imports = new Set<string>();
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) imports.add(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isExternalModuleReference(node)) {
      add(node.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...imports];
}

function packageRoot(specifier: string): string | undefined {
  if (/^[./#]|^[a-z][\w+.-]*:/i.test(specifier)) return undefined;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments[0].length > 1 && segments[1] ? segments.slice(0, 2).join('/') : undefined;
  }
  return segments[0] || undefined;
}

/** SDD paths are project-relative; module availability is checked separately after writes. */
export function createSDDAction(output: AgentOutput, projectRoot: string): AgentAction {
  const targetPath = output.targetPath
    ? normalizePath(relative(resolve(projectRoot), resolve(projectRoot, output.targetPath)))
    : undefined;
  const language = output.language ?? (targetPath ? detectSyntaxLanguage(targetPath) : undefined);
  const extracted =
    output.content !== undefined && (language === 'typescript' || language === 'javascript')
      ? sourceImports(
          output.content,
          targetPath ?? (language === 'typescript' ? 'output.ts' : 'output.js'),
        )
      : [];
  const imports = [...new Set([...(output.imports ?? []), ...extracted])];
  const dependencies = [
    ...new Set([
      ...(output.dependencies ?? []),
      ...imports.map(packageRoot).filter((name): name is string => name !== undefined),
    ]),
  ];
  return {
    type: output.action,
    targetPath,
    sourcePath: output.sourcePath,
    content: output.content,
    imports,
    dependencies,
  };
}
