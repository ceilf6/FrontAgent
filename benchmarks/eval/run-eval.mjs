// 架构消融评测编排器。
// 用法：node benchmarks/eval/run-eval.mjs --arm full|ablation [--tasks smoke|all] [--out benchmarks/eval/out]
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runFrontAgentTask } from '../../packages/runtime-node/dist/run.js';
import { createClaudeCliBackend, getUsageTally } from './claude-cli-backend.mjs';
import { runChecks } from './checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const ARM = args.arm;
if (ARM !== 'full' && ARM !== 'ablation') throw new Error('--arm full|ablation 必填');
const SCOPE = args.tasks ?? 'all';
const OUT_DIR = resolve(args.out ?? join(HERE, 'out'));
mkdirSync(OUT_DIR, { recursive: true });
const OUT = join(OUT_DIR, `${ARM}.jsonl`);

const ARM_OPTIONS = {
  full: { sddPath: 'sdd.yaml' },
  ablation: {
    // 指向不存在的文件 → run.ts existsSync 判定为无 SDD
    sddPath: 'sdd.disabled.yaml',
    hallucinationGuard: {
      enabled: false,
      checks: { fileExistence: false, importValidity: false, syntaxValidity: false, sddCompliance: false },
    },
  },
};

function setupWorkspace(taskId) {
  const ws = join('/tmp', 'frontagent-eval', ARM, taskId);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  cpSync(FIXTURE, ws, {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  });
  symlinkSync(join(FIXTURE, 'node_modules'), join(ws, 'node_modules'));
  return ws;
}

const tasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).filter((t) =>
  SCOPE === 'smoke' ? t.smoke : true,
);

console.log(`arm=${ARM} scope=${SCOPE} tasks=${tasks.length} out=${OUT}`);
const backend = createClaudeCliBackend();

for (const task of tasks) {
  const ws = setupWorkspace(task.id);
  const events = {};
  const t0 = performance.now();
  const usageBefore = getUsageTally();
  let resultText = '';
  let agentSuccess = null;
  let validationCount = null;
  let runError = null;
  try {
    const result = await runFrontAgentTask({
      projectRoot: ws,
      task: task.task,
      type: task.type,
      files: task.files,
      llmBackend: backend,
      runLog: false,
      filterConsole: true,
      // 评测工作区是 /tmp 下的隔离沙箱副本：覆写等 ask 级安全决策一律放行，
      // 否则 balanced 模式下 bugfix/refactor 的文件覆写会被静默拒绝
      onApprovalRequest: async () => true,
      ...ARM_OPTIONS[ARM],
      onEvent: (e) => {
        events[e.type] = (events[e.type] ?? 0) + 1;
      },
    });
    resultText = result?.output ?? '';
    agentSuccess = result?.success ?? null;
    validationCount = result?.validations?.length ?? null;
  } catch (error) {
    runError = String(error).slice(0, 400);
  }
  const usageAfter = getUsageTally();
  const checkResults = runError ? [] : runChecks(task.checks, { workspace: ws, resultText });
  const pass = !runError && checkResults.length > 0 && checkResults.every((c) => c.ok);
  const llmCalls = usageAfter.calls - usageBefore.calls;
  const llmFailures = usageAfter.failures - usageBefore.failures;
  const record = {
    taskId: task.id,
    category: task.category,
    arm: ARM,
    pass,
    agentSuccess,
    validationCount,
    runError,
    checks: checkResults,
    events,
    elapsedMs: Math.round(performance.now() - t0),
    llmCalls,
    llmFailures,
    inputTokens: usageAfter.inputTokens - usageBefore.inputTokens,
    outputTokens: usageAfter.outputTokens - usageBefore.outputTokens,
  };
  appendFileSync(OUT, `${JSON.stringify(record)}\n`);
  console.log(
    `[${ARM}] ${task.id}: ${pass ? 'PASS' : 'FAIL'} (${record.elapsedMs}ms, ${llmCalls} calls, ${llmFailures} failures, events=${JSON.stringify(events)})`,
  );
  // 后端一次成功调用都没有 = 环境坏了（登录态过期等），继续跑只会产出降级噪音
  if (llmCalls === 0) {
    console.error(`[${ARM}] ${task.id} 零成功 LLM 调用（失败 ${llmFailures} 次）——判定后端环境异常，中止本臂评测`);
    process.exit(2);
  }
}
console.log('done. total usage:', JSON.stringify(getUsageTally()));
