import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 逐条执行任务 checks；返回 [{kind, ok, detail}]，全 ok 即任务 pass。
 *
 * `fixtureRoot` 是夹具原件目录，`file_unchanged` 用它做基准比对。
 */
export function runChecks(checks, { workspace, resultText, fixtureRoot }) {
  return checks.map((check) => {
    try {
      switch (check.kind) {
        case 'file_exists': {
          const ok = existsSync(join(workspace, check.path));
          return { kind: check.kind, ok, detail: check.path };
        }
        case 'file_contains': {
          const p = join(workspace, check.path);
          if (!existsSync(p)) return { kind: check.kind, ok: false, detail: `missing ${check.path}` };
          const ok = new RegExp(check.pattern).test(readFileSync(p, 'utf8'));
          return { kind: check.kind, ok, detail: check.pattern };
        }
        case 'result_contains': {
          const ok = new RegExp(check.pattern, 'i').test(resultText ?? '');
          return { kind: check.kind, ok, detail: check.pattern };
        }
        case 'typecheck': {
          const r = spawnSync('npx', ['tsc', '--noEmit'], { cwd: workspace, timeout: 120000 });
          return { kind: check.kind, ok: r.status === 0, detail: r.status === 0 ? '' : String(r.stdout).slice(0, 300) };
        }
        case 'file_unchanged': {
          // bugfix 任务的实质验收是「跑这个测试文件退出 0」。deep 任务集刻意不预置
          // `files`、也不点名源文件（预置等于把答案递过去），于是「改源码」与
          // 「改测试」在验收上不可区分——而两臂不会对称地走这条捷径，
          // 关掉导航的一臂更可能改测试，结论会被直接推向某个方向。
          if (!fixtureRoot) {
            return { kind: check.kind, ok: false, detail: 'fixtureRoot not provided' };
          }
          const original = join(fixtureRoot, check.path);
          const current = join(workspace, check.path);
          if (!existsSync(original) || !existsSync(current)) {
            return { kind: check.kind, ok: false, detail: `missing ${check.path}` };
          }
          const ok = readFileSync(original, 'utf8') === readFileSync(current, 'utf8');
          return { kind: check.kind, ok, detail: ok ? check.path : `modified ${check.path}` };
        }
        case 'cmd': {
          const [bin, ...rest] = check.argv;
          const r = spawnSync(bin, rest, { cwd: workspace, timeout: 180000 });
          return { kind: check.kind, ok: r.status === 0, detail: check.argv.join(' ') };
        }
        default:
          return { kind: check.kind, ok: false, detail: 'unknown check kind' };
      }
    } catch (error) {
      return { kind: check.kind, ok: false, detail: String(error).slice(0, 200) };
    }
  });
}
