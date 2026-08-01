/**
 * search_code 工具
 * 在代码库中搜索
 */

import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { escapeRegex } from '@frontagent/shared';
import { glob } from 'glob';
import { getRealProjectRoot, isInsidePath, isUnsafeGlobPattern } from '../path-safety.js';

export interface SearchCodeParams {
  query?: string;
  pattern?: string;
  filePattern?: string;
  globOnly?: boolean;
  maxResults?: number;
  contextLines?: number;
}

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  content: string;
  context?: {
    before: string[];
    after: string[];
  };
}

export interface SearchCodeResult {
  success: boolean;
  files?: string[];
  totalFiles?: number;
  matches?: SearchMatch[];
  totalMatches?: number;
  truncated?: boolean;
  error?: string;
  /**
   * 降级说明。搜索成功但没有按调用方原本的意图执行时必须填——
   * 静默降级会让空结果被读成「仓库里没有」，而实际是「没按你说的搜」。
   */
  warnings?: string[];
}

/**
 * 把调用方给的 `pattern` 编译成正则；非法时退化为字面量匹配而不是抛出。
 *
 * 这里曾经是 `new RegExp(pattern, 'gi')`，没有 try/catch。模型很自然地把
 * 路径形状的东西写成 glob——同一个工具既收 `pattern`（正则）又收
 * `filePattern`（glob），命名上区分不出语义——而 `**` 在正则里恰好非法
 * （`Nothing to repeat`）。于是整次搜索硬失败，不是降级、不是空结果。
 *
 * 2026-08-02 消融实验里实测连崩四次：
 *
 *     Invalid regular expression: /src/features/checkout/**\/gi
 *     Invalid regular expression: /src/**\/gi
 *     Invalid regular expression: /**\/*.test.ts|**\/*.spec.ts/gi
 *
 * 失败信息还对模型无用：「Nothing to repeat」不提示该换哪个参数，
 * 于是它换着花样重试，四次撞同一堵墙，把重试预算烧光。
 * 而这条路径正是导航失手后的兜底（issue #433）。
 *
 * 降级顺序也重要：`pattern` 非法时优先改用 `query`。把 glob 当字面量去搜
 * 文件内容必然是空结果——不崩了，但空结果会被读成「仓库里没有」，
 * 比崩溃更难发现。只有在没有 `query` 可退时才退到字面量。
 */
function buildSearchRegex(
  pattern: string | undefined,
  query: string | undefined,
): { regex: RegExp; warning?: string } {
  if (!pattern) return { regex: new RegExp(escapeRegex(query!), 'gi') };
  try {
    return { regex: new RegExp(pattern, 'gi') };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const looksGlob = /\*\*|\*\./.test(pattern);
    const hint = looksGlob
      ? `pattern 看起来是 glob（${pattern}）——限定文件范围请用 filePattern，pattern 只接受正则。`
      : `pattern 不是合法正则（${why}）。`;

    if (query) {
      return {
        regex: new RegExp(escapeRegex(query), 'gi'),
        warning: `${hint} 已改用 query 搜索。`,
      };
    }
    return {
      regex: new RegExp(escapeRegex(pattern), 'gi'),
      warning: `${hint} 已退化为字面量搜索，结果可能为空。`,
    };
  }
}

/**
 * 搜索代码
 */
export async function searchCode(
  params: SearchCodeParams,
  projectRoot: string,
): Promise<SearchCodeResult> {
  const defaultFilePattern = '**/*.{ts,tsx,js,jsx,json,yaml,yml,md,css,scss,html,vue,svelte}';
  const {
    query,
    pattern,
    filePattern = defaultFilePattern,
    globOnly = false,
    maxResults = 100,
    contextLines = 2,
  } = params;
  const effectiveFilePattern = filePattern.trim() || defaultFilePattern;
  const effectiveMaxResults = maxResults > 0 ? maxResults : 100;

  if (!query && !pattern && !globOnly) {
    return {
      success: false,
      error: 'Either query, pattern, or globOnly must be provided',
    };
  }

  try {
    if (isUnsafeGlobPattern(effectiveFilePattern)) {
      return {
        success: false,
        error: 'Unsafe filePattern: glob patterns must stay inside the project root',
      };
    }

    const realProjectRoot = getRealProjectRoot(projectRoot);
    // 使用 glob 查找文件
    const files = await glob(effectiveFilePattern, {
      cwd: realProjectRoot,
      nodir: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/coverage/**'],
    });
    const safeFiles = files.filter((file) =>
      isInsidePath(resolve(realProjectRoot, file), realProjectRoot),
    );

    if (globOnly) {
      return {
        success: true,
        files: safeFiles.slice(0, effectiveMaxResults),
        totalFiles: safeFiles.length,
        truncated: safeFiles.length > effectiveMaxResults,
      };
    }

    const matches: SearchMatch[] = [];
    const { regex: searchRegex, warning: regexWarning } = buildSearchRegex(pattern, query);

    for (const file of safeFiles) {
      if (matches.length >= effectiveMaxResults) {
        break;
      }

      const fullPath = resolve(realProjectRoot, file);

      // 跳过太大的文件
      const stat = statSync(fullPath);
      if (stat.size > 1024 * 1024) {
        // 1MB
        continue;
      }

      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (matches.length >= effectiveMaxResults) {
            break;
          }

          const line = lines[lineIdx];
          let match;
          searchRegex.lastIndex = 0;

          while ((match = searchRegex.exec(line)) !== null) {
            // 零宽匹配（如 pattern 为 `a*`、`(?=x)`）不会推进 lastIndex，
            // 手动前移避免死循环；空匹配本身没有可展示的内容，直接跳过
            if (match[0].length === 0) {
              searchRegex.lastIndex++;
              continue;
            }

            const searchMatch: SearchMatch = {
              file: relative(realProjectRoot, fullPath),
              line: lineIdx + 1,
              column: match.index + 1,
              content: line.trim(),
            };

            // 添加上下文
            if (contextLines > 0) {
              const beforeStart = Math.max(0, lineIdx - contextLines);
              const afterEnd = Math.min(lines.length, lineIdx + contextLines + 1);

              searchMatch.context = {
                before: lines.slice(beforeStart, lineIdx).map((l) => l.trim()),
                after: lines.slice(lineIdx + 1, afterEnd).map((l) => l.trim()),
              };
            }

            matches.push(searchMatch);

            if (matches.length >= effectiveMaxResults) {
              break;
            }
          }
        }
      } catch {
        // File read failed (e.g. binary file, permission denied) — skip silently
      }
    }

    return {
      success: true,
      matches,
      totalMatches: matches.length,
      truncated: matches.length >= effectiveMaxResults,
      ...(regexWarning ? { warnings: [regexWarning] } : {}),
    };
  } catch (error) {
    return {
      success: false,
      error: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 工具的 JSON Schema 定义
 */
export const searchCodeSchema = {
  name: 'search_code',
  description: '在代码库中搜索文本或正则表达式。返回匹配的行及其上下文。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: '要搜索的文本（会进行精确匹配）',
      },
      pattern: {
        type: 'string',
        description:
          '搜索文件内容用的正则（优先于 query）。只接受正则，不接受 glob——' +
          '要限定搜索的目录或文件类型请用 filePattern，把 "src/xxx/**" 写在这里是无效的。',
      },
      filePattern: {
        type: 'string',
        description:
          '限定搜索哪些文件的 glob（如 "src/features/checkout/**" 或 "**/*.test.ts"），' +
          '默认搜索常见代码文件。目录范围与文件类型都由它控制，不要写进 pattern。',
        default: '**/*.{ts,tsx,js,jsx,json,yaml,yml,md,css,scss,html,vue,svelte}',
      },
      globOnly: {
        type: 'boolean',
        description: '仅执行 glob 文件发现，不搜索文件内容。用于写入前先收集候选路径。',
        default: false,
      },
      maxResults: {
        type: 'number',
        description: '最大返回结果数，默认 100',
        default: 100,
      },
      contextLines: {
        type: 'number',
        description: '每个匹配显示的上下文行数，默认 2',
        default: 2,
      },
    },
    required: [],
  },
};
