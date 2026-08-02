import type { ExecutionStep, ValidationResult } from '@frontagent/shared';
import { detectLanguage } from './phase-ordering.js';
import type { ExecutorCollectedContext } from './types.js';

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
 *
 * **已知残留误报**：判据是逐行正则，不识别上下文，所以一份把 markdown 示例放进
 * 多行模板字符串的合法 `.ts`（prompt 常量最容易长成这样）会被挡下。代价不对称：
 * `create_file` 上这条判据是**写盘否决**并置 `needsRollback`，会跳过剩余计划；
 * `apply_patch` 上只是回滚恢复。选择接受它是因为实测该形态在本仓 `packages/**`
 * 的 `.ts` 里零命中，而它要挡的失效（模型把整块 markdown 当文件内容写出来，
 * TS1127）在评测里真实发生过。要真正消除，需要 #413 换成真 parser——那时这条
 * 正则连同 `NON_DECIDING_CHECKS` 一起删。下面 `pins the known template-literal
 * false positive` 用例把当前行为钉住，让它可见而不是悄悄存在。
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
 * **只覆盖 `apply_patch`**，因为只有这个动作上「降级」等于「保持原状」：修复前
 * 补丁内容根本到不了 `validateCode`（计划 schema 不发 patches，`content` 三个
 * 来源全是 undefined），所以 `syntax_validity` / `import_validity` 从未约束过
 * 补丁路径。`resolveWriteContent` 让整文件 replace 的内容第一次可校验，如果顺手
 * 把 block 权也给这两条，一个合法的 modify 步骤就会因 `@/components/x`（判「包
 * 未安装」）或「后续步骤才会创建的相对模块」（判「无法解析」）而失败，
 * `needsRollback` 再把剩余计划整个跳过——正是本文件拒绝把写盘否决权交出去的
 * 那两类误报。
 *
 * `create_file` **不在表内**。它的 `syntax_validity` 修复前就是阻塞的，而
 * `checkSyntaxValidity` 只对 `typescript` / `javascript` 走那条逐行引号奇偶的
 * 启发式；`json` 走的是 `JSON.parse`，判据完全可靠。按 action 一刀切降级会把
 * 后者一起关掉——一个非法的 `package.json` 会落盘、步骤报成功、还不进重试，
 * 这是在 #387 的验收方向上倒退。真要缓解 #413 的误报，应当按 language 收窄，
 * 那属于 #413 的范围，不在这里顺手做。
 */
const NON_DECIDING_CHECKS: Record<string, ReadonlySet<string>> = {
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

/**
 * 解析出「写盘前即可确定的完整文件内容」；返回 null 表示该步骤无法前置校验
 * （如只改动局部行的补丁，最终内容要落盘后才知道）。
 */
export function resolveWriteContent(
  step: ExecutionStep,
  toolParams: Record<string, unknown>,
  /** 调用方已解析好的写入路径,写盘前后共用同一份 */
  path: string | undefined,
  context?: { collectedContext: ExecutorCollectedContext },
): {
  path: string;
  content: string;
  language: 'typescript' | 'javascript' | 'json' | 'yaml';
} | null {
  if (!WRITE_ACTIONS.includes(step.action)) {
    return null;
  }

  if (!path) {
    return null;
  }

  const content = resolveWriteActionContent(step, toolParams, {
    patchContent: () =>
      resolveFullFileReplaceContent(toolParams, context?.collectedContext.files.get(path)),
  });
  if (typeof content !== 'string') {
    return null;
  }

  const language = detectLanguage(path);
  return language ? { path, content, language } : null;
}

/**
 * 按 action 取「这次真正会被写入的内容」。写盘前后共用同一条分派规则。
 *
 * 不做跨动作兜底：`apply_patch` 写入的是 `patches`，而 `content` 在它的 params
 * 上是可达的残留字段（计划参数原样透传、技能整体 spread）。若允许它兜底，校验的
 * 就是一份**不会被写入**的内容，而真正落盘的补丁内容一次都不过 guard——比修复前
 * 更糟。这条不变量此前在写盘前后各实现了一遍，漏改一处不会有测试暴露，所以只留
 * 这一份。
 *
 * 两侧的差别只在补丁内容从哪来：写盘前从 `patches` 推导（只有整文件 replace 可
 * 推），写盘后直接读回磁盘（真实工具都不返回 content，局部补丁也没有 content
 * 参数，读回是唯一可靠来源）。这一步由调用方以 `patchContent` 注入。
 */
export function resolveWriteActionContent(
  step: ExecutionStep,
  toolParams: Record<string, unknown> | undefined,
  sources: {
    patchContent: () => string | undefined;
    /** 仅 create_file 使用：工具返回值里的 content，写盘后路径才有 */
    resultContent?: string | undefined;
    /**
     * 落盘内容。有它就一律优先——写盘**后**这一侧的职责是「校验真正落在磁盘上的
     * 那份」，而写工具可能对内容做过归一化（尾换行、EOL、格式化）。用 params 里的
     * 原始内容重跑一遍，得到的结论描述的不是磁盘上的东西，还白搭一次整文件 import
     * 解析。写盘前这一侧没有磁盘可读，不传。
     */
    landedContent?: string | undefined;
  },
): string | undefined {
  if (sources.landedContent !== undefined) {
    return sources.landedContent;
  }
  if (step.action !== 'create_file') {
    return sources.patchContent();
  }
  return (sources.resultContent ??
    toolParams?.content ??
    step.params.content ??
    sources.patchContent()) as string | undefined;
}
