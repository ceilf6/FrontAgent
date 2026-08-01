// 架构消融评测编排器。
// 用法：node benchmarks/eval/run-eval.mjs --arm full|ablation|no-filesense
//         [--tasks smoke|all|<taskId>] [--fixture flat|deep] [--out benchmarks/eval/out]
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

/**
 * 只钉死**忠实的 no-op** 两项。
 *
 * 数值预算刻意不钉：`planner-skills.ts` 里配置值是**替换**而非兜底
 * （`filesense?.maxEntries ?? decision.maxEntries`），而 trigger-policy 的预算是
 * 按 intent 分档的——`validate_freshness` 120、`prepare_create` 180、
 * `understand_structure` 250、`prepare_refactor` 500。统一钉成 300 会把
 * `prepare_refactor` **收紧**到 300、把 `validate_freshness` 放宽到 300 并让超时翻倍，
 * 测出来的就不再是产品的出厂策略。而「预算是否被截断」正是报告的结论行。
 *
 * 环境确定性改用另一种办法：启动时断言相关环境变量未设（见下）。
 * 这样既拿到臂间确定性，又保留按 intent 的真实预算。
 *
 * `output` / `writeMode` 则可以放心钉：`config.ts` 未设时返回 `undefined`，
 * 而 `planner-skills.ts` 的兜底恰好就是 `'summary'` / `'cache'`，钉死不改变行为。
 */
const FILESENSE_PINNED = {
  filesenseOutput: 'summary',
  filesenseWriteMode: 'cache',
};

// 数值预算必须来自 trigger-policy，不能被环境变量顶替——否则截断结论
// 变成操作者机器的属性。宁可拒跑，不可产出一个说不清来源的数。
const BUDGET_ENV_VARS = [
  'FRONTAGENT_FILESENSE_MAX_ENTRIES',
  'FRONTAGENT_FILESENSE_MAX_BYTES',
  'FRONTAGENT_FILESENSE_TIMEOUT_MS',
];
const setBudgetVars = BUDGET_ENV_VARS.filter((name) => process.env[name] !== undefined);
if (setBudgetVars.length > 0) {
  throw new Error(
    `以下环境变量会顶替 trigger-policy 的按 intent 预算，使「是否截断」不可归因，请先 unset：\n  ${setBudgetVars.join('\n  ')}`,
  );
}

const ARM_OPTIONS = {
  // 对照臂也必须钉死。一臂钉死、一臂随环境，操作者环境里存在该变量就会得到
  // 「两臂都关」的空结果，与 #386 废掉 guard 臂是同一类失真。
  full: { sddPath: 'sdd.yaml', filesenseEnabled: true, ...FILESENSE_PINNED },
  ablation: {
    // 指向不存在的文件 → run.ts existsSync 判定为无 SDD
    sddPath: 'sdd.disabled.yaml',
    // 与 full 臂同样钉死：三臂里只要有一臂随环境，臂间差异就不再只归因于被消融的那一项
    filesenseEnabled: true,
    ...FILESENSE_PINNED,
    hallucinationGuard: {
      enabled: false,
      checks: { fileExistence: false, importValidity: false, syntaxValidity: false, sddCompliance: false },
    },
  },
  // filesense 单独消融：SDD 与 guard 与 full 臂完全相同，唯一变量是导航能力。
  // 这是回答「filesense 有没有用」的臂——full/ablation 两臂 filesense 都开着，
  // 它们之间的差异说明不了 filesense 的任何事情。
  // 注意口径：这是关掉**注入式导航**（planner 不再注入 filesense_navigate 步骤），
  // 不是把 filesense 工具从注册表里摘掉。实际等价，因为计划 prompt 与 schema
  // 都不暴露 filesense 动作，模型点不到它——报告里的守卫会验证这一点。
  'no-filesense': { sddPath: 'sdd.yaml', filesenseEnabled: false, ...FILESENSE_PINNED },
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
/** 事件形状与 core 对不上时记在这里；主循环据此中止本臂，而不是继续产出假数据 */
const harnessFailures = [];

function collectEventDetail(details, event) {
  if (event.type === 'filesense_navigated') {
    // 这里跨包读 core 的 AgentEvent 字段，`.mjs` 拿不到类型约束。
    // core 一旦改名，entries 会静默变成 0、报告照样出「累计扫描条目 0」——
    // 正是本 harness 要根治的「空结果被当成证据」。宁可吵，不可静默。
    // 不能 throw：`Agent.emit` 对监听器异常是 try/catch + debug 级日志
    // （`agent.ts:307-315`），抛出去只会被静默吞掉——正是本 harness 要防的那种
    // 「守卫看起来加了、实际没生效」。改为记账，由主循环在写记录**之前**中止本臂。
    //
    // 每个被采集的字段都要查：只查 entries 的话，truncated 变成 undefined 会被
    // 当成 false、candidateCount 变成 undefined 会被当成 0，报告照样出「未截断、
    // 零候选」——同一种静默降级，只是换了个字段。
    for (const [field, expected] of [
      ['entries', 'number'],
      ['elapsedMs', 'number'],
      ['truncated', 'boolean'],
      ['candidateCount', 'number'],
    ]) {
      if (typeof event[field] !== expected) {
        harnessFailures.push(
          `filesense_navigated.${field} 应为 ${expected}，实际 ${typeof event[field]}——core 的事件形状可能已变`,
        );
      }
    }
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
  let plannerFallbackReason = null;
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
        // 带 stage 的事件另记一份分阶段计数：`validation_failed` 的两个阶段含义
        // 不同（post_write 时文件已经落盘了），只按 type 聚合的话，
        // 事件加了 stage 也等于白加。
        if (e.stage) {
          events[`${e.type}:${e.stage}`] = (events[`${e.type}:${e.stage}`] ?? 0) + 1;
        }
        collectEventDetail(eventDetails, e);
      },
    });
    resultText = result?.output ?? '';
    agentSuccess = result?.success ?? null;
    // 规划降级必须落盘：它表现为「步骤全绿、任务成功、文件写错地方」，
    // 不记的话这一轮的结果看不出任何异常（issue #417）。
    plannerFallbackReason = result?.plannerFallbackReason ?? null;
    agentError = result?.error ? String(result.error).slice(0, 300) : null;
    validationCount = result?.validations?.length ?? null;
  } catch (error) {
    runError = String(error).slice(0, 400);
  }
  const usageAfter = getUsageTally();
  const checkResults = runError ? [] : runChecks(task.checks, { workspace: ws, resultText, fixtureRoot: FIXTURE });
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
    taskSet: basename(TASKS_FILE),
    // 注意是**请求值**不是生效值：这里回读的是同进程的同一组常量，
    // 所以报告基于它的一致性校验是构造性结论，不是遥测验证。
    // 真正的生效值要等 core 在 filesense_navigated 载荷里回显 navigate 参数。
    filesenseConfigRequested: {
      enabled: ARM_OPTIONS[ARM].filesenseEnabled,
      ...FILESENSE_PINNED,
    },
    pass,
    agentSuccess,
    agentError,
    validationCount,
    plannerFallbackReason,
    runError,
    resultHead: resultText.slice(0, 200),
    checks: checkResults,
    events,
    eventDetails,
    // filesense 导航的汇总量：扫描条目、预算是否被截断——
    // 「按需供给 vs 全量倾倒」这条主张能不能拿数字说话，全靠这两个字段。
    filesenseEntries: eventDetails.filesense.reduce((sum, nav) => sum + (nav.entries ?? 0), 0),
    filesenseTruncated: eventDetails.filesense.some((nav) => nav.truncated),
    // 定位精度：探索了多少路径，其中多少落在任务声明的目标目录之外。
    // `targetDirs` 由任务自己在 tasks-deep.json 里声明，不是从结果反推的——
    // 否则就是拿答案去评分。通过率对「找得准不准」太不敏感：两臂都能靠
    // list_directory / search_code 慢慢摸出来，结果一样、代价不同，
    // 而代价才是导航能力的直接体现。
    exploredCount: eventDetails.explored.length,
    offTargetExplored: task.targetDirs
      ? eventDetails.explored.filter((e) => !task.targetDirs.some((d) => e.path.startsWith(d)))
          .length
      : null,
    elapsedMs: Math.round(performance.now() - t0),
    llmCalls,
    llmFailures,
    inputTokens: usageAfter.inputTokens - usageBefore.inputTokens,
    outputTokens: usageAfter.outputTokens - usageBefore.outputTokens,
  };
  // 必须在写盘之前中止：污染记录一旦落进 JSONL，续跑去重只看 taskId，
  // 修好后重跑会**跳过**这条，report 照常把它计入汇总——假数据就此永久固化。
  if (harnessFailures.length > 0) {
    console.error(
      `[${ARM}] ${task.id}: harness 与 core 的事件契约不符，不写记录、中止本臂：\n  - ` +
        harnessFailures.join('\n  - '),
    );
    process.exit(3);
  }

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
