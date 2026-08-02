import { describe, expect, it } from 'vitest';
import { GeneratedPlanSchema, PlanOutlineSchema, StepExpansionSchema } from './schemas.js';

/**
 * 这些 schema 的必填字段直接决定「LLM 规划会不会静默降级」。
 *
 * 模型只填相关字段：一个 create_file 步骤给 action / tool / path / 描述，
 * 其余一概省略。任何一个它可能省略的字段只要是必填，zod 就逐条报
 * invalid_type，`generateObject` 重试耗尽抛错，规划静默退到规则生成——
 * 而规则生成给 create 的路径是硬编码的 `src/new-file.ts`，
 * 净效果是「步骤全绿、任务成功、文件写错地方」（#417）。
 *
 * 这个缺陷已经出现过两次：第一次是 params 的 15 个字段，
 * 修完只放开了 params，`phase` 仍必填，于是同一条链路原样重演。
 * 下面用「模型会给的最小对象」直接过 schema，防止第三次。
 */
describe('plan schemas accept a minimal, realistic model output', () => {
  const minimalStep = {
    description: '创建工具函数',
    action: 'create_file' as const,
    tool: 'create_file',
    params: { path: 'src/shared/lib/truncate.ts' },
  };

  it('GeneratedPlanSchema accepts a step without phase/reasoning/needsCodeGeneration', () => {
    const result = GeneratedPlanSchema.safeParse({
      summary: '新增 truncate',
      steps: [minimalStep],
    });
    expect(result.success).toBe(true);
  });

  it('StepExpansionSchema accepts the same minimal step', () => {
    const result = StepExpansionSchema.safeParse({ steps: [minimalStep] });
    expect(result.success).toBe(true);
  });

  it('PlanOutlineSchema accepts an outline without phase/risks/alternatives', () => {
    const result = PlanOutlineSchema.safeParse({
      summary: '新增 truncate',
      stepOutlines: [{ description: '创建文件', action: 'create_file' as const }],
    });
    expect(result.success).toBe(true);
  });

  it('still rejects a step missing the fields that carry real meaning', () => {
    // action / tool / description 决定这一步做什么，缺了就无法执行——
    // 放开它们等于让 schema 不再约束任何东西。
    expect(GeneratedPlanSchema.safeParse({ summary: 's', steps: [{}] }).success).toBe(false);
  });
});
