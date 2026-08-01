#!/usr/bin/env node
/**
 * 确定性探针：修复前 / 修复后的写盘前校验对照。
 *
 * 这是 2026-07-31-validation-telemetry.md §二 那张对照表的可复现来源。
 * 零 LLM 消耗（stub backend）、输入固定、走评测 harness 同一入口
 * `runFrontAgentTask`，因此两次运行之间唯一的变量就是被测代码本身。
 *
 * 用法：
 *   node benchmarks/results/2026-07-31-smoke/probe-prewrite-validation.mjs
 *
 * 在待测提交上各跑一次并比较输出，例如：
 *   git checkout db42301 && pnpm build && node <此脚本>   # 修复前
 *   git checkout <PR#402> && pnpm build && node <此脚本>  # 修复后
 *
 * 判读：`validation_failed` 从 0 变 1、`badFileOnDisk` 从 true 变 false，
 * 而 `step_failed` 两侧都是 1 —— 这正是「检查一直在跑并判失败，只是不发事件、
 * 也不阻止落盘」的证据，也是「零拦截」结论属于观测假象的依据。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFrontAgentTask } from '../../../packages/runtime-node/dist/index.js';

/** 未闭合的 `{`：必然触发 guard 的括号匹配检查，不依赖任何模型行为 */
const BAD_CONTENT = 'export const Probe = () => {\n';
const TARGET = 'src/components/Probe.tsx';

function createStubBackend() {
  return {
    name: 'prewrite-validation-probe-stub',
    async generateText() {
      // 代码生成分支若被走到，同样返回那段坏内容——保证探针的唯一变量是被测代码
      return BAD_CONTENT;
    },
    async generateObject() {
      return {
        summary: 'Deterministic pre-write validation probe',
        steps: [
          {
            description: '写入一段语法非法的组件',
            action: 'create_file',
            tool: 'create_file',
            params: { path: TARGET, content: BAD_CONTENT },
            dependencies: [],
            validation: [],
            phase: '实现',
          },
        ],
        phases: [{ name: '实现', description: '写文件', stepIndices: [0] }],
        rollbackStrategy: {
          enabled: true,
          snapshotBeforeExecution: true,
          rollbackOnFailure: true,
          maxRollbackSteps: 3,
        },
      };
    },
  };
}

function setupWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'frontagent-prewrite-probe-'));
  mkdirSync(join(root, 'src', 'components'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'probe-fixture', private: true, type: 'module' }, null, 2),
  );
  return root;
}

const workspace = setupWorkspace();
const events = {};
let taskError = null;

try {
  const result = await runFrontAgentTask({
    projectRoot: workspace,
    task: `create ${TARGET}`,
    type: 'create',
    llmBackend: createStubBackend(),
    runLog: false,
    filterConsole: true,
    disableRag: true,
    onApprovalRequest: async () => true,
    onEvent: (event) => {
      events[event.type] = (events[event.type] ?? 0) + 1;
    },
  });
  taskError = result?.error ? String(result.error) : null;
} catch (error) {
  taskError = String(error);
}

const targetPath = join(workspace, TARGET);
const badFileOnDisk = existsSync(targetPath);

console.log(
  JSON.stringify(
    {
      validation_failed: events.validation_failed ?? 0,
      step_failed: events.step_failed ?? 0,
      rollback_started: events.rollback_started ?? 0,
      rollback_completed: events.rollback_completed ?? 0,
      rollback_failed: events.rollback_failed ?? 0,
      badFileOnDisk,
      badFileBytes: badFileOnDisk ? statSync(targetPath).size : 0,
      badFileContent: badFileOnDisk ? readFileSync(targetPath, 'utf8') : null,
      taskError: taskError?.slice(0, 300) ?? null,
      allEvents: events,
    },
    null,
    2,
  ),
);

rmSync(workspace, { recursive: true, force: true });
