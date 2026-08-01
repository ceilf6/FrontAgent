/**
 * 路径接地：拿导航扫出来的真实目录清单，校正计划里猜出来的文件名。
 *
 * 为什么需要它（#434）。导航步骤是**前插**到一份已生成的计划上的
 * （`planner-skills.ts` 的 `return [navigateStep, ...steps]`），计划里每一步的
 * `path` 在导航跑之前就定死了，而导航产出只进 `filesenseContext` 供答案生成用，
 * 没有任何一处回改步骤路径。
 *
 * 2026-08-02 消融实验实测：开臂每一条产生幻觉文件名的任务，导航都覆盖了
 * 真实文件所在目录且未截断——真实文件名确实在输出里——计划仍然读了一个
 * 不存在的同义词：
 *
 *     computeTotal.ts  ← 计划写 calculateTotal.ts
 *     mergeLines.ts    ← 计划写 mergeCartItem.ts
 *     estimateEta.ts   ← 计划写 estimateDeliveryDays.ts
 *
 * 关臂的幻觉是同一类。拿到答案的那一臂从不查阅它，所以开不开导航，
 * 猜错的方式一模一样，通过率 4/12 对 4/12。
 *
 * ## 两条不可越过的边界
 *
 * **只校正读取类动作。** `create_file` 的目标本来就不该存在，对它接地会把
 * 每一个新建都改写到一个既有文件上——把新增变成覆盖。
 *
 * **含糊时不改。** 匹配不明确就保持原样、让它自然失败。静默押一个次优候选，
 * 就是把一个看得见的错误换成一个看不见的错误——本仓库反复栽在这上面
 * （#386 #400 #403 #388 #415 #417 #432）。
 */

/** 会读取既有文件的动作。`create_file` 不在内且不能在内，理由见文件头。 */
const READ_LIKE_ACTIONS = new Set(['read_file', 'apply_patch', 'get_ast']);

export interface PathGroundingFacts {
  existingFiles: Set<string>;
  /** 目录 → 其下文件清单。只有完整枚举过（导航未截断）的目录才在这里。 */
  directoryContents: Map<string, string[]>;
}

export interface PathGroundingOutcome {
  /** 最终应当使用的路径；未改写时等于入参 */
  path: string;
  /** 发生了校正 */
  corrected?: { from: string; to: string; score: number };
  /** 判定为幻觉但没有足够把握校正——保持原样，把候选记下来供诊断 */
  declined?: { path: string; reason: string; candidates: string[] };
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

/** 后缀含 `.test` / `.spec` 这类中缀时一并保留，避免把实现文件配到测试文件上 */
function extension(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

/** camelCase / snake_case / kebab-case 一律拆成小写词元 */
function tokenize(name: string): Set<string> {
  const stem = name.slice(0, name.indexOf('.') === -1 ? undefined : name.indexOf('.'));
  return new Set(
    stem
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase()),
  );
}

/** Jaccard 相似度：交集 / 并集。全等为 1，无共同词元为 0。 */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * 校正一个步骤路径。
 *
 * 只有同时满足下列条件才会改写：
 * 1. 动作是读取类；
 * 2. 该路径不在已确认存在的文件里；
 * 3. 其父目录**被完整枚举过**（导航未截断），因而「不在清单里」才等于「不存在」；
 * 4. 同目录下存在同后缀候选；
 * 5. 最佳候选有共同词元，且明显优于次佳（≥1.5 倍）——并列即视为含糊。
 */
export function groundStepPath(
  path: string,
  action: string,
  facts: PathGroundingFacts,
): PathGroundingOutcome {
  if (!READ_LIKE_ACTIONS.has(action)) return { path };
  if (facts.existingFiles.has(path)) return { path };

  const dir = dirname(path);
  const listing = facts.directoryContents.get(dir);
  // 没有完整清单就没有判定权：可能是没扫过，也可能是扫了但被预算截断。
  // 两种情况都不能推断「不存在」。
  if (!listing?.length) return { path };

  const name = basename(path);
  const ext = extension(name);
  const wanted = tokenize(name);

  const scored = listing
    .filter((candidate) => candidate !== path && extension(basename(candidate)) === ext)
    .map((candidate) => ({ candidate, score: similarity(wanted, tokenize(basename(candidate))) }))
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return { path, declined: { path, reason: '同目录下无同后缀候选', candidates: listing } };
  }

  const [best, runnerUp] = scored;
  const decisive = best.score > 0 && (!runnerUp || best.score >= runnerUp.score * 1.5);
  if (!decisive) {
    return {
      path,
      declined: {
        path,
        reason: best.score === 0 ? '候选与原名无共同词元' : '最佳候选未明显优于次佳',
        candidates: scored.map((s) => s.candidate),
      },
    };
  }

  return {
    path: best.candidate,
    corrected: { from: path, to: best.candidate, score: Number(best.score.toFixed(3)) },
  };
}
