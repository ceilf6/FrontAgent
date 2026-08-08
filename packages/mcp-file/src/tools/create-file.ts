/**
 * create_file 工具
 * 创建新文件
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertWritableByPolicy, resolveWritePath } from '../path-safety.js';
import type { SnapshotManager } from '../snapshot.js';
import { syntaxValidationError, validateFileSyntax } from '../syntax-validation.js';

export interface CreateFileParams {
  path: string;
  content: string;
  overwrite?: boolean;
  __frontagentSecurityApproved?: boolean;
  __frontagentSyntaxValidationEnabled?: boolean;
}

export interface CreateFileResult {
  success: boolean;
  path?: string;
  snapshotId?: string;
  error?: string;
}

/**
 * 创建文件
 */
export function createFile(
  params: CreateFileParams,
  projectRoot: string,
  snapshotManager: SnapshotManager,
): CreateFileResult {
  const {
    path: filePath,
    content,
    overwrite = false,
    __frontagentSecurityApproved = false,
    __frontagentSyntaxValidationEnabled = true,
  } = params;

  const safePath = resolveWritePath(filePath, projectRoot);
  if (!safePath.ok) {
    return {
      success: false,
      error: safePath.error,
    };
  }

  const policyError = assertWritableByPolicy({
    relativePath: safePath.relativePath,
    overwrite,
    approved: __frontagentSecurityApproved,
  });
  if (policyError) {
    return {
      success: false,
      error: policyError,
    };
  }

  if (typeof content !== 'string') {
    return { success: false, error: 'File content must be a string' };
  }

  if (__frontagentSyntaxValidationEnabled) {
    const syntaxValidation = validateFileSyntax(content, filePath);
    if (!syntaxValidation.syntaxValid) {
      return { success: false, error: syntaxValidationError(syntaxValidation, filePath) };
    }
  }

  const existedBeforeWrite = existsSync(safePath.fullPath);
  if (existedBeforeWrite && !overwrite) {
    return {
      success: false,
      error: `File already exists: ${filePath}. Set overwrite=true to overwrite.`,
    };
  }

  // 创建快照
  const snapshotId = snapshotManager.createSnapshot(
    safePath.fullPath,
    existedBeforeWrite ? 'modify' : 'create',
  );

  let writeCompleted = false;
  try {
    // 确保目录存在
    const dir = dirname(safePath.fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Use exclusive creation for non-overwrite writes so a file created after
    // the initial existence check cannot be overwritten by a race.
    if (overwrite && existedBeforeWrite) {
      writeFileSync(safePath.fullPath, content, 'utf-8');
    } else {
      writeFileSync(safePath.fullPath, content, { encoding: 'utf-8', flag: 'wx' });
    }
    writeCompleted = true;
    snapshotManager.updateSnapshotContent(snapshotId, content);

    return {
      success: true,
      path: filePath,
      snapshotId,
    };
  } catch (error) {
    const lostExclusiveRace = isAlreadyExistsError(error) && !existedBeforeWrite;
    if (lostExclusiveRace) {
      snapshotManager.discardSnapshot(snapshotId);
    } else if (overwrite || writeCompleted) {
      snapshotManager.rollback(snapshotId);
    } else {
      snapshotManager.discardSnapshot(snapshotId);
    }

    if (lostExclusiveRace) {
      return {
        success: false,
        error: `File appeared concurrently: ${filePath}. Retry after reading the current file.`,
      };
    }

    return {
      success: false,
      error: `Failed to create file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * 工具的 JSON Schema 定义
 */
export const createFileSchema = {
  name: 'create_file',
  description: '创建新文件。如果目录不存在会自动创建。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: '相对于项目根目录的文件路径',
      },
      content: {
        type: 'string',
        description: '文件内容',
      },
      overwrite: {
        type: 'boolean',
        description: '是否覆盖已存在的文件，默认 false',
        default: false,
      },
    },
    required: ['path', 'content'],
  },
};
