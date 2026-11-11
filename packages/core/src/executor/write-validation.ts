import type { ExecutionStep, ValidationResult } from '@frontagent/shared';

export const WRITE_ACTIONS = ['apply_patch', 'create_file'];

// A patch may refer to modules created by a later step; imports remain telemetry.
const NON_DECIDING_CHECKS: Record<string, Set<string>> = {
  apply_patch: new Set(['import_validity']),
};

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

/** Read actual disk content when available; patch params.content is never a patch result. */
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
