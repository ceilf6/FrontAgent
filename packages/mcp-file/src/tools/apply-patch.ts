import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyFilePatches, type FilePatch, type PatchResult } from '@frontagent/shared';
import * as Diff from 'diff';
import { assertWritableByPolicy, resolveWritePath } from '../path-safety.js';
import type { SnapshotManager } from '../snapshot.js';
import { syntaxValidationError, validateFileSyntax } from '../syntax-validation.js';

export interface ApplyPatchParams {
  path: string;
  patches: FilePatch[];
  dryRun?: boolean;
  __frontagentSecurityApproved?: boolean;
  __frontagentExpectedOriginalHash?: string;
  __frontagentSyntaxValidationEnabled?: boolean;
}

/**
 * Apply line-based patches after validating the original file and the complete
 * projected result. The expected hash binds executor preflight to this write.
 */
export function applyPatch(
  params: ApplyPatchParams,
  projectRoot: string,
  snapshotManager: SnapshotManager,
): PatchResult {
  const {
    path: filePath,
    patches,
    dryRun = false,
    __frontagentSecurityApproved = false,
    __frontagentExpectedOriginalHash,
    __frontagentSyntaxValidationEnabled = true,
  } = params;

  const safePath = resolveWritePath(filePath, projectRoot);
  if (!safePath.ok) return failure(safePath.error ?? `Cannot resolve path: ${filePath}`);

  const policyError = assertWritableByPolicy({
    relativePath: safePath.relativePath,
    approved: __frontagentSecurityApproved,
  });
  if (policyError) return failure(policyError);

  if (!existsSync(safePath.fullPath)) {
    return failure(`Cannot apply patch: file does not exist: ${filePath}`);
  }

  const originalContent = readFileSync(safePath.fullPath, 'utf-8');
  if (
    __frontagentExpectedOriginalHash !== undefined &&
    hashContent(originalContent) !== __frontagentExpectedOriginalHash
  ) {
    return failure(
      'Cannot apply patch: file changed since executor preflight; refusing to apply patches to a stale base',
      'stale_original_hash',
    );
  }

  const projected = applyFilePatches(originalContent, patches);
  if (!projected.ok) return failure(projected.error);

  const diff = Diff.createPatch(
    filePath,
    originalContent,
    projected.content,
    'original',
    'modified',
  );
  const originalValidation = __frontagentSyntaxValidationEnabled
    ? validateFileSyntax(originalContent, filePath)
    : { syntaxValid: true, lintErrors: [], typeErrors: [] };
  const validation = __frontagentSyntaxValidationEnabled
    ? validateFileSyntax(projected.content, filePath)
    : { syntaxValid: true, lintErrors: [], typeErrors: [] };
  if (!validation.syntaxValid && originalValidation.syntaxValid) {
    return {
      success: false,
      diff,
      validation,
      snapshotId: '',
      error: syntaxValidationError(validation, filePath),
    };
  }

  const snapshotId = dryRun ? '' : snapshotManager.createSnapshot(safePath.fullPath, 'modify');

  if (!dryRun) {
    const dir = dirname(safePath.fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(safePath.fullPath, projected.content, 'utf-8');
    snapshotManager.updateSnapshotContent(snapshotId, projected.content);
  }

  return {
    success: true,
    diff,
    validation,
    snapshotId,
  };
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function failure(error: string, errorCode?: PatchResult['errorCode']): PatchResult {
  return {
    success: false,
    diff: '',
    validation: { syntaxValid: false, lintErrors: [], typeErrors: [] },
    snapshotId: '',
    error,
    errorCode,
  };
}

/**
 * Tool JSON Schema. Internal consistency markers are deliberately omitted.
 */
export const applyPatchSchema = {
  name: 'apply_patch',
  description: '应用最小化代码补丁到指定文件。支持替换、插入、删除操作。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: '相对于项目根目录的文件路径',
      },
      patches: {
        type: 'array',
        description:
          '补丁列表。所有行号均相对原始文件内容（应用任何补丁之前），各补丁的行范围不得重叠',
        items: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['replace', 'insert', 'delete'],
              description: '操作类型：replace-替换, insert-插入, delete-删除',
            },
            startLine: {
              type: 'number',
              description: '起始行号（1-based）',
            },
            endLine: {
              type: 'number',
              description: '结束行号（1-based，包含）。对于 replace 和 delete 有效',
            },
            content: {
              type: 'string',
              description: '新内容。对于 replace 和 insert 必须提供',
            },
          },
          required: ['operation', 'startLine'],
        },
      },
      dryRun: {
        type: 'boolean',
        description: '是否仅预览不实际修改，默认 false',
        default: false,
      },
    },
    required: ['path', 'patches'],
  },
};
