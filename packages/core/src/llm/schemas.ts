import { z } from 'zod';

const ACTION_ENUM = [
  'read_file',
  'list_directory',
  'create_file',
  'apply_patch',
  'search_code',
  'get_ast',
  'run_command',
  'browser_navigate',
  'get_page_structure',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'web_fetch',
] as const;

/**
 * 计划 schema 里所有非必需字段一律 `.optional()`。
 *
 * 上一轮只把 `params` 的 15 个字段放开，`phase` / `reasoning` /
 * `needsCodeGeneration` / `risks` / `alternatives` 仍是必填——模型照样漏填，
 * `generateObject` 照样重试耗尽抛错、照样静默退到规则生成、create 任务照样落到
 * 硬编码的 `src/new-file.ts`（实测 `["steps",0,"phase"] Required`）。
 * 半修等于没修：只要还有一个必填字段是模型可能省略的，整条链路就会重演。
 *
 * 下游对这些字段本来就有兜底（phase 有默认阶段名、needsCodeGeneration 判 falsy、
 * risks/alternatives 只用于展示），所以放开不改变执行语义。
 */

/**
 * 工具参数。**每个字段都是可选的**——一个步骤只会用到其中一两个。
 *
 * 曾经全部必填，靠 describe 里的「不适用时填空字符串/false/0」来要求模型补齐。
 * 模型不会那么做：它只填相关字段，于是 zod 对每个缺失字段各报一条 invalid_type，
 * `generateObject` 重试耗尽后抛错，规划**静默**退到规则生成——而规则生成给
 * create 任务的路径是硬编码的 `src/new-file.ts`。净效果是一次「步骤全绿、
 * 任务成功、文件写到错误位置」的运行（issue #417）。
 *
 * 让 schema 描述参数的真实形状，比让模型迁就一个不真实的形状可靠得多。
 */
const STEP_PARAMS_SCHEMA = z
  .object({
    path: z.string().optional().describe('文件或目录路径'),
    recursive: z.boolean().optional().describe('是否递归列出子目录'),
    query: z.string().optional().describe('文本搜索查询'),
    pattern: z.string().optional().describe('搜索模式'),
    filePattern: z.string().optional().describe('文件 glob 模式'),
    globOnly: z.boolean().optional().describe('是否仅执行 glob 文件发现'),
    maxResults: z.number().optional().describe('最大返回结果数'),
    directory: z.string().optional().describe('搜索目录'),
    command: z.string().optional().describe('要执行的终端命令'),
    url: z.string().optional().describe('URL'),
    selector: z.string().optional().describe('CSS选择器'),
    text: z.string().optional().describe('输入文本'),
    fullPage: z.boolean().optional().describe('是否全页截图'),
    codeDescription: z.string().optional().describe('要生成的代码的描述'),
    changeDescription: z.string().optional().describe('要做的修改描述'),
    allowed_domains: z
      .array(z.string())
      .nullish()
      .describe(
        '可选域名白名单，仅 web_fetch 适用。精确主机名匹配，子域需逐条列出；空数组视为不启用',
      ),
    blocked_domains: z
      .array(z.string())
      .nullish()
      .describe(
        '可选域名黑名单，仅 web_fetch 适用。精确主机名匹配，优先级高于 allowed_domains；空数组视为不启用',
      ),
  })
  .describe('工具参数 - 只填该步骤实际用到的字段，其余省略');

export const PlanOutlineSchema = z.object({
  summary: z.string().describe('计划的简要描述'),
  stepOutlines: z
    .array(
      z.object({
        description: z.string().describe('步骤简要描述'),
        action: z.enum(ACTION_ENUM).describe('执行动作类型'),
        phase: z
          .string()
          .optional()
          .describe(
            '所属阶段名称（如：阶段1-分析、阶段2-创建、阶段3-安装、阶段4-验证、阶段7-仓库管理）',
          ),
      }),
    )
    .describe('步骤概要列表 - 只需简单描述每个步骤要做什么'),
  risks: z.array(z.string()).optional().describe('潜在风险'),
  alternatives: z.array(z.string()).optional().describe('备选方案'),
});

export type PlanOutline = z.infer<typeof PlanOutlineSchema>;

export const StepExpansionSchema = z.object({
  steps: z
    .array(
      z.object({
        description: z.string().describe('步骤描述 - 说明要做什么'),
        action: z.enum(ACTION_ENUM).describe('执行动作'),
        tool: z.string().describe('要调用的工具'),
        phase: z.string().optional().describe('所属阶段名称（与Phase 1中的阶段名称保持一致）'),
        params: STEP_PARAMS_SCHEMA,
        reasoning: z.string().optional().describe('为什么需要这个步骤'),
        needsCodeGeneration: z.boolean().optional().describe('此步骤是否需要在执行时生成代码'),
      }),
    )
    .describe('展开后的详细步骤列表'),
});

export const GeneratedPlanSchema = z.object({
  summary: z.string().describe('计划的简要描述'),
  steps: z
    .array(
      z.object({
        description: z.string().describe('步骤描述 - 说明要做什么'),
        action: z.enum(ACTION_ENUM).describe('执行动作'),
        tool: z.string().describe('要调用的工具'),
        phase: z
          .string()
          .optional()
          .describe(
            '所属阶段名称（如：阶段1-分析、阶段2-创建、阶段3-安装、阶段4-验证、阶段7-仓库管理）',
          ),
        params: STEP_PARAMS_SCHEMA,
        reasoning: z.string().optional().describe('为什么需要这个步骤'),
        needsCodeGeneration: z.boolean().optional().describe('此步骤是否需要在执行时生成代码'),
      }),
    )
    .describe('执行步骤列表'),
  risks: z.array(z.string()).optional().describe('潜在风险'),
  alternatives: z.array(z.string()).optional().describe('备选方案'),
});

export type GeneratedPlan = z.infer<typeof GeneratedPlanSchema>;

export const ErrorRecoveryPlanSchema = z.object({
  canRecover: z.boolean().describe('是否可以通过生成修复步骤来解决问题'),
  analysis: z.string().describe('错误分析：为什么会出现这些错误'),
  recoverySteps: z
    .array(
      z.object({
        description: z.string().describe('修复步骤描述'),
        action: z.enum(ACTION_ENUM).describe('修复动作'),
        tool: z.string().describe('工具名称'),
        phase: z.string().describe('所属阶段'),
        params: z
          .object({
            path: z.string().describe('文件或目录路径（不适用时填空字符串）'),
            recursive: z.boolean().describe('是否递归列出子目录，不适用时填false'),
            pattern: z.string().describe('搜索模式（不适用时填空字符串）'),
            directory: z.string().describe('搜索目录（不适用时填空字符串）'),
            command: z.string().describe('要执行的终端命令（不适用时填空字符串）'),
            url: z.string().describe('URL（不适用时填空字符串）'),
            selector: z.string().describe('CSS选择器（不适用时填空字符串）'),
            text: z.string().describe('输入文本（不适用时填空字符串）'),
            fullPage: z.boolean().describe('是否全页截图，不适用时填false'),
            codeDescription: z.string().describe('要生成的代码的描述（不适用时填空字符串）'),
            changeDescription: z.string().describe('要做的修改描述（不适用时填空字符串）'),
            allowed_domains: z
              .array(z.string())
              .nullish()
              .describe('可选域名白名单，仅 web_fetch 适用，可省略'),
            blocked_domains: z
              .array(z.string())
              .nullish()
              .describe('可选域名黑名单，仅 web_fetch 适用，可省略'),
          })
          .describe('工具参数'),
        reasoning: z.string().describe('为什么需要这个修复步骤'),
        needsCodeGeneration: z.boolean().describe('此步骤是否需要代码生成'),
      }),
    )
    .describe('修复步骤列表'),
  recommendation: z.string().describe('给用户的建议'),
});

export type ErrorRecoveryPlan = z.infer<typeof ErrorRecoveryPlanSchema>;

export const GeneratedCodeSchema = z.object({
  code: z.string().describe('生成的代码'),
  language: z.string().describe('编程语言'),
  explanation: z.string().describe('代码说明'),
});

export type GeneratedCode = z.infer<typeof GeneratedCodeSchema>;

export const GeneratedPatchSchema = z.object({
  originalCode: z.string().describe('原始代码片段'),
  modifiedCode: z.string().describe('修改后的代码片段'),
  explanation: z.string().describe('修改说明'),
  startLine: z.number().optional().describe('修改起始行号'),
  endLine: z.number().optional().describe('修改结束行号'),
});

export type GeneratedPatch = z.infer<typeof GeneratedPatchSchema>;
