import path from 'node:path';
import type { AgentTask, ExecutionStep } from '@frontagent/shared';

export type FilesenseNavigationIntent =
  | 'locate'
  | 'understand_structure'
  | 'find_conventions'
  | 'prepare_refactor'
  | 'prepare_create'
  | 'validate_freshness';

export interface FilesenseDecision {
  enabled: boolean;
  intent?: FilesenseNavigationIntent;
  paths: string[];
  depth: number;
  maxEntries: number;
  maxBytes: number;
  timeoutMs: number;
  reason: string;
}

const DEFAULT_DECISION: Omit<FilesenseDecision, 'enabled' | 'reason' | 'intent'> = {
  paths: ['.'],
  depth: 2,
  maxEntries: 300,
  maxBytes: 128 * 1024,
  timeoutMs: 3000,
};

const FILE_ACTIONS = new Set([
  'create_file',
  'apply_patch',
  'read_file',
  'list_directory',
  'search_code',
]);

function skip(reason: string): FilesenseDecision {
  return { enabled: false, reason, ...DEFAULT_DECISION };
}

function enable(
  intent: FilesenseNavigationIntent,
  reason: string,
  overrides: Partial<Omit<FilesenseDecision, 'enabled' | 'reason' | 'intent'>> = {},
): FilesenseDecision {
  return {
    enabled: true,
    intent,
    reason,
    ...DEFAULT_DECISION,
    ...overrides,
  };
}

function stringParam(step: ExecutionStep, key: string): string | undefined {
  const value = step.params[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeDir(input: string): string {
  const normalized = input.replace(/\\/g, '/');
  if (!normalized || normalized === '.') return '.';
  if (normalized.endsWith('/')) return normalized.replace(/\/+$/, '') || '.';
  const ext = path.posix.extname(normalized);
  return ext ? path.posix.dirname(normalized) || '.' : normalized;
}

function uniqueDirs(dirs: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const dir of dirs) {
    const normalized = normalizeDir(dir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output.length > 0 ? output : ['.'];
}

function isKnownSingleFileTask(steps: ExecutionStep[]): boolean {
  const fileSteps = steps.filter((step) => FILE_ACTIONS.has(step.action));
  if (fileSteps.length !== 1) return false;

  const [step] = fileSteps;
  if (!['read_file', 'apply_patch', 'create_file'].includes(step.action)) return false;

  const targetPath = stringParam(step, 'path');
  return Boolean(targetPath && path.posix.extname(targetPath.replace(/\\/g, '/')));
}

function taskMentionsLocationNeed(task: AgentTask): boolean {
  const text = task.description.toLowerCase();
  return /where|which file|locate|find|入口|在哪|哪个文件|查找|寻找|定位/.test(text);
}

function taskMentionsStructureNeed(task: AgentTask): boolean {
  const text = task.description.toLowerCase();
  return /architecture|structure|overview|map|架构|结构|目录|模块|梳理|理解/.test(text);
}

function collectTargetDirs(steps: ExecutionStep[]): string[] {
  const dirs: string[] = [];
  for (const step of steps) {
    const pathParam = stringParam(step, 'path');
    if (pathParam) dirs.push(pathParam);
  }
  return uniqueDirs(dirs, 5);
}

const FOCUS_DIRS = [
  'src',
  'components',
  'hooks',
  'api',
  'services',
  'pages',
  'routes',
  'views',
  'store',
  'stores',
];

function taskMentionedFocusDirs(task: AgentTask): string[] {
  const text = task.description.toLowerCase();
  return FOCUS_DIRS.filter((dir) => new RegExp(`(^|[^a-z0-9_-])${dir}([^a-z0-9_-]|$)`).test(text));
}

/**
 * 合并「任务文本里提到的目录名」与「计划步骤里的真实目录」。
 *
 * 提到的名字是**裸名**（`hooks` / `components` / `api`），不是路径，此前它们排在
 * 计划推导出的真实目录**前面**。engine 对不存在的路径只是跳过并记 warning
 * （已实测），所以不会毁掉整次扫描——但 `paths` 上限是 5，一个不解析的名字
 * 就白占一个名额，把真正该扫的目录挤出预算。实测
 * `deep-create-checkout-hook` 的 `paths: ["hooks", "src/features/checkout",
 * "src/features/checkout/hooks"]` 即为此形（issue #420）。
 *
 * 现在：① 计划推导出的真实目录排前面——那是即将写入的位置，证据强度高于
 * 从散文里捞到的名字；② 额外补上拼接变体（`src/features/checkout` + `hooks`
 * → `src/features/checkout/hooks`），这才是裸名真正想表达的位置；
 * ③ 裸名本身排最后，仍保留（在根下确有同名目录的仓库里它是对的）。
 */
function mergeFocusDirs(task: AgentTask, dirs: string[], limit = 5): string[] {
  const mentioned = taskMentionedFocusDirs(task);
  const realDirs = uniqueDirs(dirs, limit);

  const derived: string[] = [];
  for (const base of realDirs) {
    if (base === '.') continue;
    for (const name of mentioned) {
      derived.push(`${base}/${name}`);
    }
  }

  return uniqueDirs([...realDirs, ...derived, ...mentioned], limit);
}

function taskMentionsFreshnessNeed(task: AgentTask): boolean {
  const text = task.description.toLowerCase();
  return /fresh|stale|changed|变化|变更|最新|新鲜|过期|找不到/.test(text);
}

export function decideFilesense(task: AgentTask, steps: ExecutionStep[]): FilesenseDecision {
  if (!steps.some((step) => FILE_ACTIONS.has(step.action))) {
    return skip('no file-system exploration or mutation steps');
  }

  if (task.type === 'query') {
    if (taskMentionsFreshnessNeed(task)) {
      return enable(
        'validate_freshness',
        'query asks for fresh repository layout or missing paths',
        {
          paths: mergeFocusDirs(task, collectTargetDirs(steps), 3),
          depth: 1,
          maxEntries: 120,
          maxBytes: 48 * 1024,
          timeoutMs: 1500,
        },
      );
    }

    if (taskMentionsStructureNeed(task) || taskMentionsLocationNeed(task)) {
      return enable('understand_structure', 'query requires repository structure', {
        paths: mergeFocusDirs(task, ['.'], 3),
        depth: 2,
        maxEntries: 250,
        maxBytes: 96 * 1024,
      });
    }
    return skip('query task without repository-structure need');
  }

  if (isKnownSingleFileTask(steps)) {
    return skip('known single-file task can use direct file tools');
  }

  if (taskMentionsLocationNeed(task)) {
    return enable('locate', 'task needs locating files or entrypoints', {
      paths: mergeFocusDirs(task, ['.']),
      depth: 2,
      maxEntries: 300,
    });
  }

  if (task.type === 'create') {
    return enable('prepare_create', 'create task benefits from nearby placement conventions', {
      paths: mergeFocusDirs(task, collectTargetDirs(steps)),
      depth: 1,
      maxEntries: 180,
      maxBytes: 64 * 1024,
    });
  }

  if (
    task.type === 'refactor' ||
    steps.filter((step) => step.action === 'apply_patch' || step.action === 'create_file').length >
      1
  ) {
    return enable('prepare_refactor', 'multi-file change benefits from local directory map', {
      paths: mergeFocusDirs(task, collectTargetDirs(steps)),
      depth: 2,
      maxEntries: 500,
      maxBytes: 160 * 1024,
    });
  }

  if (task.type === 'debug' || taskMentionsStructureNeed(task)) {
    return enable('understand_structure', 'debug or structure task benefits from lightweight map', {
      paths: mergeFocusDirs(task, collectTargetDirs(steps)),
      depth: 2,
      maxEntries: 300,
    });
  }

  return skip('no clear filesense benefit');
}
