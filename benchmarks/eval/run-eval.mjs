// 架构消融评测编排器。
// 用法：node benchmarks/eval/run-eval.mjs --arm full|ablation|no-filesense
//         [--tasks smoke|all|<taskId>] [--fixture flat|deep] [--out benchmarks/eval/out]
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runFrontAgentTask } from '../../packages/runtime-node/dist/run.js';
import { createClaudeCliBackend, getUsageTally } from './claude-cli-backend.mjs';
import { runChecks } from './checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const ARM = args.arm;
const ARM_NAMES = ['full', 'ablation', 'no-filesense'];
if (!ARM_NAMES.includes(ARM)) throw new Error(`--arm ${ARM_NAMES.join('|')} 必填`);
const SCOPE = args.tasks ?? 'all';
const OUT_DIR = resolve(args.out ?? join(HERE, 'out'));
mkdirSync(OUT_DIR, { recursive: true });

/**
 * 夹具选择。
 *
 * - `flat`（默认，2026-07-12 那轮用的）：14 个源文件、最深 2 层。filesense 的预算闸
 *   在这个规模上**从不关闸**（实测 src depth=2 maxEntries=180 → 扫 17 条、未截断，
 *   而全仓一共 18 条），一次 `ls -R` 就能塞进上下文——按构造测不出按需导航的价值。
 * - `deep`：feature-sliced，242 个源文件 / 188 个目录 / 最深 5 层，且 `format.ts`、
 *   `Button.tsx`、`useToggle.ts` 各有 24 份散落在不同 feature 下。实测同样预算下
 *   扫 180 条即截断（全仓 430 条），定位必须靠语义而非文件名。
 *   噪音模块由 `fixture-deep/generate.mjs` 生成，跑评测前需先执行一次。
 */
const FIXTURE_KIND = args.fixture ?? 'flat';
if (!['flat', 'deep'].includes(FIXTURE_KIND)) throw new Error('--fixture flat|deep');
const FIXTURE = join(HERE, FIXTURE_KIND === 'deep' ? 'fixture-deep' : 'fixture');
const TASKS_FILE = join(HERE, FIXTURE_KIND === 'deep' ? 'tasks-deep.json' : 'tasks.json');
if (FIXTURE_KIND === 'deep' && !existsSync(join(FIXTURE, 'src', 'features', 'catalog'))) {
  throw new Error('深夹具尚未生成：先跑 node benchmarks/eval/fixture-deep/generate.mjs');
}
// 依赖缺失时 setupWorkspace 会建出悬空软链，typecheck / vitest 全部返回非 0，
// 整臂产出一串 FAIL——而唯一的中止启发式是「零成功 LLM 调用」，此时不会触发。
// 那就是「失败被记成数据」，必须在跑之前挡掉。
if (!existsSync(join(FIXTURE, 'node_modules'))) {
  throw new Error(`夹具依赖未安装：先在 ${FIXTURE} 下装依赖（或建好 node_modules 软链）`);
}

// 输出文件名带上夹具：两套夹具的任务 id 不冲突，断点续跑的去重只按 taskId，
// 先跑 flat 再跑 deep 会静默追加进同一个文件，报告会把两套夹具平均成一个数。
const OUT = join(OUT_DIR, `${ARM}${FIXTURE_KIND === 'deep' ? '-deep' : ''}.jsonl`);

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
  // filesense 单独消融：SDD 与 guard 与 full 臂完全相同，唯一变量是导航能力。
  // 这是回答「filesense 有没有用」的臂——full/ablation 两臂 filesense 都开着，
  // 它们之间的差异说明不了 filesense 的任何事情。
  'no-filesense': { sddPath: 'sdd.yaml', filesense: { enabled: false } },
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

// --tasks smoke|all|<taskId>（单任务用于诊断探针）
const scoped = JSON.parse(readFileSync(TASKS_FILE, 'utf8')).filter((t) => {
  if (SCOPE === 'smoke') return t.smoke;
  if (SCOPE === 'all') return true;
  return t.id === SCOPE;
});
if (scoped.length === 0) throw new Error(`--tasks ${SCOPE} 未匹配任何任务`);

// 断点续跑：OUT 里已有记录的任务跳过（中断后重新执行同一命令即接续）
const done = new Set(
  existsSync(OUT)
    ? readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).taskId)
    : [],
);
const tasks = scoped.filter((t) => !done.has(t.id));
if (done.size > 0) console.log(`resume: 跳过已完成 ${done.size} 条（${[...done].join(', ')}）`);

console.log(`arm=${ARM} scope=${SCOPE} tasks=${tasks.length} out=${OUT}`);
const backend = createClaudeCliBackend();

/**
 * 事件计数不足以回答任何「效果」问题：
 * - `filesense_navigated` 只计数，就丢掉了 scanned.entries / 预算是否截断 /
 *   候选数——「省了多少上下文」这个最有说服力的量根本算不出来。
 * - `validation_failed` 只计数，就分不出「guard 真拦下了坏代码」和「工具自己报错」，
 *   拦截数是复合值（2026-07-31 遥测报告 §三 因此无法定论）。
 * 所以除计数外，另存这两类事件的载荷。载荷体积很小，一次跑至多几十条。
 */
function collectEventDetail(details, event) {
  if (event.type === 'filesense_navigated') {
    details.filesense.push({
      intent: event.intent ?? null,
      paths: event.paths ?? [],
      entries: event.entries,
      elapsedMs: event.elapsedMs,
      truncated: event.truncated,
      candidateCount: event.candidateCount,
      warnings: event.warnings ?? [],
    });
    return;
  }
  // 注意：`validation_failed` 的 emit 站点由 PR #402 引入，在它合入 develop 之前
  // 这个数组恒为空。**空数组的含义是「事件未接线」，不是「零拦截」**——
  // 2026-07-12 报告的缺陷 3 与后续项 3 说的正是这件事。
  if (event.type === 'validation_failed') {
    details.validationFailed.push({
      // 判失败的检查项：区分「真·内容拦截」与「纯工具失败」的唯一依据
      failedChecks: (event.result?.results ?? [])
        .filter((r) => !r.pass)
        .map((r) => ({ type: r.type, severity: r.severity, message: r.message?.slice(0, 200) })),
      blockedBy: (event.result?.blockedBy ?? []).map((b) => String(b).slice(0, 200)),
    });
    return;
  }
  // `rollback_started` / `rollback_completed` 是既有事件，一定会到；
  // `rollback_failed` 随 #402 才进入 AgentEvent 联合类型，在它合入前不会出现。
  // 三者一起记，才能判定「撤销成功」与「拦到了但没撤销掉」——只看 started
  // 分不出这两种，而后者意味着坏文件还在工作区里。
  if (
    event.type === 'rollback_started' ||
    event.type === 'rollback_completed' ||
    event.type === 'rollback_failed'
  ) {
    details.rollback.push({
      outcome: event.type.replace('rollback_', ''),
      snapshotId: event.snapshotId,
      error: event.error ? String(event.error).slice(0, 200) : undefined,
    });
  }
}

for (const task of tasks) {
  const ws = setupWorkspace(task.id);
  const events = {};
  const eventDetails = { filesense: [], validationFailed: [], rollback: [] };
  const t0 = performance.now();
  const usageBefore = getUsageTally();
  let resultText = '';
  let agentSuccess = null;
  let agentError = null;
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
      // 外部 RAG 仓库（默认拉 ceilf6/Lab）与夹具无关：检索噪音混入 query 上下文
      // 且消耗 token，评测两臂一律关闭
      disableRag: true,
      // 评测工作区是 /tmp 下的隔离沙箱副本：覆写等 ask 级安全决策一律放行，
      // 否则 balanced 模式下 bugfix/refactor 的文件覆写会被静默拒绝
      onApprovalRequest: async () => true,
      ...ARM_OPTIONS[ARM],
      onEvent: (e) => {
        events[e.type] = (events[e.type] ?? 0) + 1;
        collectEventDetail(eventDetails, e);
      },
    });
    resultText = result?.output ?? '';
    agentSuccess = result?.success ?? null;
    agentError = result?.error ? String(result.error).slice(0, 300) : null;
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
    // 报告器据此断言两臂用的是同一套夹具与任务集——否则会拿 flat 的方法学
    // 去描述 deep 的产物，正是 #410 撤回结论的同一类失真。
    fixture: FIXTURE_KIND,
    taskSet: TASKS_FILE.split('/').pop(),
    pass,
    agentSuccess,
    agentError,
    validationCount,
    runError,
    resultHead: resultText.slice(0, 200),
    checks: checkResults,
    events,
    eventDetails,
    // filesense 导航的汇总量：扫描条目、预算是否被截断——
    // 「按需供给 vs 全量倾倒」这条主张能不能拿数字说话，全靠这两个字段。
    filesenseEntries: eventDetails.filesense.reduce((sum, nav) => sum + (nav.entries ?? 0), 0),
    filesenseTruncated: eventDetails.filesense.some((nav) => nav.truncated),
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
