import type { ValidationResult } from '@frontagent/shared';

/** 会把内容写到磁盘的动作——校验必须发生在调用它们之前 */
export const WRITE_ACTIONS = ['apply_patch', 'create_file'];

/**
 * 写盘否决判据：代码文件里出现 markdown 围栏。
 *
 * **为什么不用 guard 的 `syntax_validity`**：它是逐行数引号奇偶 + 括号栈的启发式
 * （`checks/syntax-validity.ts`），对合法代码会误判 block——实测 `"it's fine"`、
 * 多行模板字符串、JSX 里的撇号全部判失败。把否决写盘的权力交给它，等于让任何
 * 含撇号的字符串都写不出来，比它要修的缺陷严重得多。
 *
 * 围栏判据则是高精度的：以 ``` 开头的行在 .ts/.tsx/.js 里永远不是合法代码，
 * 而这正是评测里实际观测到的失效形态（TS1127: Invalid character，模型把
 * markdown 代码块原样当成文件内容写了出来）。宁可只挡确定的那一类，
 * 也不要用一个会误伤的判据去挡「所有语法错误」。
 *
 * 其余校验结论照旧留给写盘后判定。启发式本身的误判是既有缺陷，跟踪于 issue #413。
 */
function detectMarkdownFence(content: string): { line: number; text: string } | undefined {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      return { line: i + 1, text: lines[i].trim().slice(0, 40) };
    }
  }
  return undefined;
}

/**
 * 判定不可靠到不能决定步骤成败的检查项。
 *
 * `syntax_validity`（所有写动作）：见上，逐行启发式对合法代码误判 block。
 *
 * `import_validity`（仅 `apply_patch`）：它对 `@/components/x` 判「包未安装 →
 * block」，对「后续步骤才会创建的相对模块」判「无法解析 → block」——正是本文件
 * 拒绝把写盘否决权交出去的那两类误报。修复前 `apply_patch` 的内容根本到不了
 * `validateCode`（计划 schema 不发 patches，`content` 三个来源全是 undefined），
 * 所以补丁路径从未受这条判定约束；`resolveWriteContent` 让整文件 replace 的内容
 * 第一次可校验，如果顺手把 block 权也给它，一个合法的 modify 步骤就会失败，
 * `needsRollback` 再把剩余计划整个跳过。
 *
 * `create_file` 的 `import_validity` 保持原样：修复前它就是阻塞的，这里不顺手改。
 */
const NON_DECIDING_CHECKS: Record<string, ReadonlySet<string>> = {
  create_file: new Set(['syntax_validity']),
  apply_patch: new Set(['syntax_validity', 'import_validity']),
};

/**
 * 把不可靠的判定降级为「记录但不否决」，而不是删掉。
 *
 * 删掉会让一个真的语法错误既不失败、也不出现在 `validation.results` 里，
 * 于是 `validation_failed:post_write` 的载荷和消融基准都看不到它——一个静默
 * 退化。保留条目、只把它排除出 `pass` / `blockedBy`，等价于就地降级为 warn：
 * 步骤照常成功，遥测照常可见。
 *
 * 同一份判据在两处不能有两套可信度：既然它不可靠到不能否决写盘，就不能反手
 * 让它决定步骤成败——`needsRollback` 会因此为真，`progress-enforcement` 跳过
 * 全部剩余步骤，agent 主路径白耗 recovery 次数。
 *
 * #413 落地（换真 parser）后 `syntax_validity` 应从这张表里删除。
 */
export function demoteNonDecidingVerdicts(
  validation: ValidationResult,
  action: string,
): ValidationResult {
  const demoted = NON_DECIDING_CHECKS[action];
  if (!demoted) return validation;

  const blockedBy = validation.results
    .filter(
      (result) => !result.pass && result.severity === 'block' && !demoted.has(String(result.type)),
    )
    .map((result) => result.message ?? result.type);
  return {
    pass: blockedBy.length === 0,
    results: validation.results,
    blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
  };
}

/**
 * 围栏判据只适用于 TS/JS 家族。`.yaml` 的块标量里放一段 markdown（含围栏）
 * 是完全合法的内容，`.json` 的字符串同理——对它们套用这条判据就是误伤。
 */
const FENCE_VETO_LANGUAGES = new Set(['typescript', 'javascript']);

/** 把围栏检出结果表达成 ValidationResult，好让事件与错误文案与其余校验同形。 */
export function buildFenceVeto(content: string, path: string, language: string): ValidationResult {
  if (!FENCE_VETO_LANGUAGES.has(language)) {
    return { pass: true, results: [] };
  }
  const fence = detectMarkdownFence(content);
  if (!fence) {
    return { pass: true, results: [] };
  }
  const message = `Markdown code fence written into ${path} at line ${fence.line}: ${fence.text}`;
  return {
    pass: false,
    results: [{ pass: false, type: 'syntax_validity', severity: 'block', message }],
    blockedBy: [message],
  };
}

/**
 * codegen 生成的 apply_patch 是「覆盖整文件的单个 replace」——
 * 计划 schema 不产出 patches，所有 modify 步骤都走这条路（executor-skills 的
 * apply_patch 分支固定发 {operation:'replace', startLine:1, endLine:原文件行数}）。
 * 这类补丁的最终内容在写盘前完全已知，理应和 create_file 一样受前置校验保护。
 * 只改局部行的补丁仍返回 undefined，落回写盘后判定。
 */
export function resolveFullFileReplaceContent(
  toolParams: Record<string, unknown>,
  originalContent: string | undefined,
): string | undefined {
  const patches = toolParams.patches;
  if (!Array.isArray(patches) || patches.length !== 1) {
    return undefined;
  }
  const patch = patches[0] as {
    operation?: string;
    startLine?: number;
    endLine?: number;
    content?: string;
  };
  if (patch.operation !== 'replace' || typeof patch.content !== 'string') {
    return undefined;
  }
  if (patch.startLine !== 1 || originalContent === undefined) {
    return undefined;
  }
  const originalLines = originalContent.split('\n').length;
  return typeof patch.endLine === 'number' && patch.endLine >= originalLines
    ? patch.content
    : undefined;
}
