import type { AgentTask, ExecutionPlan } from '@frontagent/shared';
import type { ContextManager } from '../context.js';
import type { LLMService } from '../llm.js';
import { FRONTAGENT_IDENTITY_CONTEXT, truncateForPrompt } from './helpers.js';

export interface AnswerGenerationDeps {
  llmService: LLMService;
  debugWarn: (...args: unknown[]) => void;
}

export function generateOutput(steps: ExecutionPlan['steps']): string {
  const completedSteps = steps.filter((s) => s.status === 'completed');
  const summary = completedSteps.map((s) => `✅ ${s.description}`).join('\n');
  return `执行完成 (${completedSteps.length}/${steps.length} 步骤成功)\n\n${summary}`;
}

export async function buildFinalOutput(
  deps: AnswerGenerationDeps,
  task: AgentTask,
  steps: ExecutionPlan['steps'],
  executionContext: NonNullable<ReturnType<ContextManager['getContext']>>,
): Promise<string | undefined> {
  if (task.type !== 'query') {
    return generateOutput(steps);
  }

  try {
    return await generateQueryAnswer(deps, task, executionContext, steps);
  } catch (error) {
    deps.debugWarn('[Agent] Failed to synthesize query answer:', error);
    throw error;
  }
}

async function generateQueryAnswer(
  deps: AnswerGenerationDeps,
  task: AgentTask,
  executionContext: NonNullable<ReturnType<ContextManager['getContext']>>,
  steps: ExecutionPlan['steps'],
): Promise<string | undefined> {
  const ragMatches = executionContext.collectedContext.ragMatches ?? [];
  const ragWarnings = executionContext.collectedContext.ragWarnings ?? [];
  const files = Array.from(executionContext.collectedContext.files.entries());

  const successfulSearches = steps.filter(
    (step) => step.action === 'search_code' && step.result?.success,
  );

  const searchEvidence = successfulSearches
    .flatMap((step) => {
      const output = step.result?.output as
        | {
            matches?: Array<{ file: string; line: number; content: string }>;
          }
        | undefined;
      return (output?.matches ?? [])
        .slice(0, 5)
        .map((match) => `${match.file}:${match.line} ${match.content}`);
    })
    .slice(0, 10);

  // 搜索的降级说明必须跟着结果一起进证据。
  //
  // 搜索「成功但按别的方式搜的」时，零命中不等于「仓库里没有」。
  // 不把这条说清楚，模型会把一次降级后的空结果当成否定性证据——
  // 这正是 #433 里比崩溃更难发现的那种失败。
  const searchWarnings = successfulSearches
    .flatMap((step) => (step.result?.output as { warnings?: string[] } | undefined)?.warnings ?? [])
    .slice(0, 5);

  const evidenceParts: string[] = [
    `## 智能体身份\n内置可信上下文，非 RAG 知识库条目，也非当前工作区文件。\n${FRONTAGENT_IDENTITY_CONTEXT}`,
  ];

  if (ragMatches.length > 0) {
    evidenceParts.push('## 知识库检索结果');
    for (const match of ragMatches.slice(0, 5)) {
      const location = match.path ? ` path=${match.path}` : '';
      evidenceParts.push(
        `- ${match.title}${location} source=${match.sourceUrl}\n${truncateForPrompt(match.snippet, 320)}`,
      );
    }
  }

  if (searchEvidence.length > 0) {
    evidenceParts.push('\n## 代码搜索命中');
    for (const item of searchEvidence) {
      evidenceParts.push(`- ${item}`);
    }
  }

  if (searchWarnings.length > 0) {
    evidenceParts.push(
      '\n## 代码搜索降级说明\n下列搜索没有按请求的方式执行，其零命中**不能**作为「不存在」的证据：',
    );
    for (const warning of searchWarnings) {
      evidenceParts.push(`- ${warning}`);
    }
  }

  // 目录导航的定位结果也是证据——只是**结构证据**，不是内容证据。
  // 不放进来的话，navigate 扫出的候选路径对回答完全不可见：任务问「路由表在哪个
  // 文件」，导航明明返回了带评分的候选，回答却只能说「没有工作区证据」。
  // 排在已读文件之后：候选路径的证据强度弱于真正读到的文件内容。
  const filesenseContext = executionContext.collectedContext.filesenseContext;
  if (filesenseContext) {
    evidenceParts.push(
      '\n## 目录导航结果（结构证据）\n' +
        '以下是按意图扫描当前工作区得到的结构信息与候选路径。' +
        '它证明这些路径**存在**及其用途推断，但**不含文件内容**——' +
        '引用时应说明是定位结果，不要当作读过该文件。\n' +
        truncateForPrompt(filesenseContext, 4000),
    );
  }

  if (files.length > 0) {
    evidenceParts.push('\n## 已读取文件');
    let remainingBudget = 16000;
    for (const [path, content] of files) {
      if (remainingBudget <= 0) {
        break;
      }
      const snippet = truncateForPrompt(content, Math.min(remainingBudget, 5000));
      remainingBudget -= snippet.length;
      evidenceParts.push(`\n### ${path}\n${snippet}`);
    }
  }

  if (evidenceParts.length === 0) {
    return undefined;
  }

  const warningText =
    ragWarnings.length > 0
      ? `\n已知检索告警：\n${ragWarnings.map((warning) => `- ${warning}`).join('\n')}\n`
      : '';

  return deps.llmService.generateText({
    system: `你是 FrontAgent 的查询问答总结器。
你必须基于提供的证据直接回答用户问题，而不是汇报执行步骤。
术语要求：
1. 远程 RAG 命中的资料统一称为"知识库"或"知识库条目"。
2. 只有当前工作区里实际读取到的本地文件，才称为"当前工作区文件"或"本地文件"。
3. 不要把知识库条目说成"当前仓库里的文件"或"仓库里的实现"。
4. "智能体身份"是内置可信上下文，只用于回答关于你是谁、你的身份、能力范围或工作方式的问题；不要把它当作项目技术事实或知识库证据。
回答要求：
1. 先直接给出结论。
2. 用简洁语言解释原理。
3. 如果引用到知识库证据，尽量点出文件路径或知识库条目。
4. 如果引用到当前工作区证据，明确说它来自当前工作区文件。
5. 当用户问"你是谁""你的身份""你能做什么"等身份或能力问题时，优先基于"智能体身份"回答，不要因为 RAG 或工作区文件没有身份定义而说无法确定身份。
6. 如果用户问题不是身份或能力问题，且除"智能体身份"外证据不足，明确说明不确定点。
7. 不要编造未出现在证据里的细节。${warningText}`,
    messages: [
      {
        role: 'user',
        content: `用户问题：${task.description}\n\n以下是可用证据：\n${evidenceParts.join('\n')}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 1800,
  });
}
