import type { FilePatch } from './types/mcp.js';

export type ApplyFilePatchesResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * Project a patch set against the original file content without touching disk.
 * All line numbers are 1-based and refer to the original content.
 */
export function applyFilePatches(
  originalContent: string,
  patches: readonly FilePatch[],
): ApplyFilePatchesResult {
  const lines = originalContent.split('\n');
  const boundsError = validatePatchBounds(patches, lines.length);
  if (boundsError) return { ok: false, error: boundsError };

  const sortedPatches = [...patches].sort((a, b) => b.startLine - a.startLine);
  const newLines = [...lines];

  for (const patch of sortedPatches) {
    const startIdx = patch.startLine - 1;
    const endIdx = (patch.endLine ?? patch.startLine) - 1;

    switch (patch.operation) {
      case 'replace':
        if (patch.content !== undefined) {
          newLines.splice(startIdx, endIdx - startIdx + 1, ...patch.content.split('\n'));
        }
        break;
      case 'insert':
        if (patch.content !== undefined) {
          newLines.splice(startIdx, 0, ...patch.content.split('\n'));
        }
        break;
      case 'delete':
        newLines.splice(startIdx, endIdx - startIdx + 1);
        break;
    }
  }

  return { ok: true, content: newLines.join('\n') };
}

function validatePatchBounds(patches: readonly FilePatch[], lineCount: number): string | null {
  for (const patch of patches) {
    const { operation, startLine, endLine } = patch;

    if (!Number.isInteger(startLine) || startLine < 1) {
      return `Invalid patch (${operation}): startLine ${startLine} must be an integer >= 1`;
    }

    if (operation === 'insert') {
      if (startLine > lineCount + 1) {
        return `Invalid patch (insert): startLine ${startLine} exceeds file length + 1 (${lineCount} lines)`;
      }
      if (endLine !== undefined) {
        return 'Invalid patch (insert): endLine is not supported for insert operations';
      }
      continue;
    }

    if (startLine > lineCount) {
      return `Invalid patch (${operation}): startLine ${startLine} exceeds file length (${lineCount} lines)`;
    }

    if (endLine !== undefined) {
      if (!Number.isInteger(endLine) || endLine < startLine) {
        return `Invalid patch (${operation}): endLine ${endLine} must be an integer >= startLine (${startLine})`;
      }
      if (endLine > lineCount) {
        return `Invalid patch (${operation}): endLine ${endLine} exceeds file length (${lineCount} lines)`;
      }
    }
  }

  return validatePatchOverlap(patches);
}

function validatePatchOverlap(patches: readonly FilePatch[]): string | null {
  const describe = (patch: FilePatch): string =>
    patch.operation === 'insert'
      ? `insert at line ${patch.startLine}`
      : `${patch.operation} at lines ${patch.startLine}-${patch.endLine ?? patch.startLine}`;

  for (let index = 0; index < patches.length; index++) {
    for (let otherIndex = index + 1; otherIndex < patches.length; otherIndex++) {
      const first = patches[index];
      const second = patches[otherIndex];
      if (first.operation === 'insert' && second.operation === 'insert') continue;

      let conflict: boolean;
      if (first.operation === 'insert' || second.operation === 'insert') {
        const point = first.operation === 'insert' ? first : second;
        const range = first.operation === 'insert' ? second : first;
        conflict =
          point.startLine >= range.startLine &&
          point.startLine <= (range.endLine ?? range.startLine);
      } else {
        conflict =
          first.startLine <= (second.endLine ?? second.startLine) &&
          second.startLine <= (first.endLine ?? first.startLine);
      }

      if (conflict) {
        return `Invalid patch set: ${describe(first)} overlaps ${describe(second)}; line numbers refer to the original file content and patch ranges must not overlap`;
      }
    }
  }

  return null;
}
