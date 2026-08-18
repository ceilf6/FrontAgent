import { createHash } from 'node:crypto';
import type { ExecutionStep } from '@frontagent/shared';
import { applyFilePatches, type FilePatch, type ValidationResult } from '@frontagent/shared';
import { detectLanguage } from './phase-ordering.js';

/** Narrow slice of HallucinationGuard that write preflight depends on. */
export interface WritePreflightGuard {
  validateSyntax(
    code: string,
    language: 'typescript' | 'javascript' | 'json' | 'yaml',
    filePath?: string,
  ): Promise<ValidationResult>;
}

export interface WritePreflightOutcome {
  path: string;
  content: string;
  validation: ValidationResult;
  toolParams: Record<string, unknown>;
}

export function buildWriteValidationFailure(type: string, message: string): ValidationResult {
  return {
    pass: false,
    results: [
      {
        pass: false,
        type,
        severity: 'block',
        message,
      },
    ],
    blockedBy: [message],
  };
}

/**
 * Validate a write against its projected content before any tool touches disk.
 * create_file is checked directly; apply_patch is projected through the same
 * line-range logic the file tool uses, then syntax-checked. The validated
 * original content is bound to the tool call as an expected SHA-256 so a
 * concurrent change after preflight cannot land a stale patch.
 */
export async function validateWriteBeforeExecution(
  guard: WritePreflightGuard,
  step: ExecutionStep,
  toolParams: Record<string, unknown>,
  files: Map<string, string>,
): Promise<WritePreflightOutcome | undefined> {
  if (step.action !== 'create_file' && step.action !== 'apply_patch') return undefined;

  const path = typeof toolParams.path === 'string' ? toolParams.path : undefined;
  if (!path) return undefined;
  const language = detectLanguage(path);

  if (step.action === 'create_file') {
    if (typeof toolParams.content !== 'string') {
      return {
        path,
        content: '',
        validation: buildWriteValidationFailure(
          'write_preflight_input',
          `Cannot preflight create_file: content for ${path} must be a string`,
        ),
        toolParams,
      };
    }
    return {
      path,
      content: toolParams.content,
      validation:
        language && language !== 'yaml'
          ? await guard.validateSyntax(toolParams.content, language, path)
          : { pass: true, results: [] },
      toolParams,
    };
  }

  const originalContent = files.get(path);
  if (!Array.isArray(toolParams.patches)) {
    return {
      path,
      content: '',
      validation: buildWriteValidationFailure(
        'write_preflight_input',
        `Cannot preflight patch: patches for ${path} must be an array`,
      ),
      toolParams,
    };
  }
  const patches = toolParams.patches as FilePatch[];
  if (originalContent === undefined) {
    return {
      path,
      content: '',
      validation: buildWriteValidationFailure(
        'write_preflight_input',
        `Cannot preflight patch: original content for ${path} is unavailable`,
      ),
      toolParams,
    };
  }

  const projected = applyFilePatches(originalContent, patches);
  if (!projected.ok) {
    return {
      path,
      content: '',
      validation: buildWriteValidationFailure('patch_projection', projected.error),
      toolParams,
    };
  }

  const originalSyntaxValidation =
    language && language !== 'yaml'
      ? await guard.validateSyntax(originalContent, language, path)
      : { pass: true, results: [] };
  const projectedSyntaxValidation =
    language && language !== 'yaml'
      ? await guard.validateSyntax(projected.content, language, path)
      : { pass: true, results: [] };

  return {
    path,
    content: projected.content,
    validation:
      !projectedSyntaxValidation.pass && originalSyntaxValidation.pass
        ? projectedSyntaxValidation
        : { pass: true, results: [] },
    toolParams: {
      ...toolParams,
      __frontagentExpectedOriginalHash: createHash('sha256')
        .update(originalContent, 'utf8')
        .digest('hex'),
    },
  };
}
