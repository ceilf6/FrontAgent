import { statSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';

const EXPLORATION_ACTIONS = new Set(['read_file', 'list_directory', 'search_code']);
const normalize = (value) => posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/u, '');

/** Capture filesystem and tool observations before subsequent steps can change the workspace. */
export function observeExploration(event, workspace) {
  if (!['step_completed', 'step_failed'].includes(event.type)) return undefined;
  const action = event.step?.action;
  if (!EXPLORATION_ACTIONS.has(action)) return undefined;
  const params = event.step.params ?? {};
  const requestedPath = String(params.path ?? params.directory ?? params.filePattern ?? '.');
  const pattern = action === 'search_code';
  const path = relative(workspace, resolve(workspace, requestedPath)).replaceAll('\\', '/') || '.';
  let exists = null;
  let existenceError;
  if (!pattern && path !== '..' && !path.startsWith('../')) {
    try {
      // A missing workspace is unavailable evidence, not a missing target file.
      if (statSync(workspace).isDirectory()) {
        try {
          statSync(resolve(workspace, requestedPath));
          exists = true;
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) exists = false;
          else existenceError = error.code ?? String(error);
        }
      }
    } catch (error) {
      existenceError = error.code ?? String(error);
    }
  }
  const result = event.result ?? event.step.result;
  const output = result?.output;
  return {
    action, path, requestedPath, pattern,
    ok: event.type === 'step_completed',
    exists,
    ...(existenceError ? { existenceError } : {}),
    resultSuccess: typeof result?.success === 'boolean' ? result.success : null,
    toolSuccess: typeof output?.success === 'boolean' ? output.success : null,
    skipped: output?.skipped === true,
    contentLength: typeof output?.content === 'string' ? output.content.length : null,
  };
}

export function classifyExploration(step, targetDirs) {
  if (step.action === 'search_code' || step.pattern === true) return 'glob';
  if (step.exists === false) return 'ghost';
  if (step.exists !== true) return 'unknown';
  if (step.ok === false || step.resultSuccess === false || step.toolSuccess === false || step.skipped) return 'miss';
  if (step.ok !== true || step.resultSuccess !== true) return 'unknown';
  if (step.action === 'read_file' && !(typeof step.contentLength === 'number' && step.contentLength >= 0)) return 'miss';
  if (!targetDirs?.length) return 'unknown';
  const path = normalize(step.path);
  const onTarget = targetDirs.some((dir) => {
    const target = normalize(dir);
    return target === '.' ? path !== '..' && !path.startsWith('../') : path === target || path.startsWith(`${target}/`);
  });
  return onTarget ? 'hit' : 'offTarget';
}

export function summarizeExploration(steps, targetDirs) {
  const counts = { hit: 0, ghost: 0, offTarget: 0, glob: 0, miss: 0, unknown: 0 };
  for (const step of steps ?? []) counts[classifyExploration(step, targetDirs)]++;
  const recorded = Array.isArray(steps);
  return {
    exploredCount: recorded ? steps.length : null,
    exploredHit: recorded && targetDirs?.length ? counts.hit : null,
    exploredGhost: recorded ? counts.ghost : null,
    offTargetExplored: recorded && targetDirs?.length ? counts.offTarget : null,
    globExplored: recorded ? counts.glob : null,
    exploredMiss: recorded ? counts.miss : null,
    exploredUnknown: recorded ? counts.unknown : null,
  };
}
