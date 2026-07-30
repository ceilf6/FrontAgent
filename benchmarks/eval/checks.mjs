import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 逐条执行任务 checks；返回 [{kind, ok, detail}]，全 ok 即任务 pass */
export function runChecks(checks, { workspace, resultText }) {
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
