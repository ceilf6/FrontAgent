/**
 * 幻觉防控器
 * 整合所有检查，验证 Agent 输出
 */

import { resolve } from 'node:path';
import type { AgentAction } from '@frontagent/sdd';
import type {
  ActionType,
  HallucinationCheckResult,
  SDDConfig,
  ValidationResult,
} from '@frontagent/shared';
import { checkFileExistence } from './checks/file-existence.js';
import { checkAllImports, extractImports } from './checks/import-validity.js';
import { isInsidePath } from './checks/path-containment.js';
import { checkSDDCompliance } from './checks/sdd-compliance.js';
import { checkSyntaxValidity } from './checks/syntax-validity.js';

/**
 * Agent 输出描述
 */
export interface AgentOutput {
  /** 操作类型 */
  action: ActionType;
  /** 目标文件路径 */
  targetPath?: string;
  /** 源文件路径（用于移动/复制） */
  sourcePath?: string;
  /** 代码内容 */
  content?: string;
  /** 代码语言 */
  language?: 'typescript' | 'javascript' | 'json' | 'yaml';
  /** 提取的导入（如果有） */
  imports?: string[];
  /** 提取的依赖（npm 包） */
  dependencies?: string[];
}

/**
 * 检查配置
 */
export interface GuardConfig {
  /** 项目根目录 */
  projectRoot: string;
  /** SDD 配置 */
  sddConfig?: SDDConfig;
  /**
   * 是否启用所有幻觉检查。
   *
   * 路径包含性校验不受此开关影响，但只覆盖接收路径的两个入口:`validate()` 与
   * `validateFilePath()`。`validateCode(code, language, filePath)` 对 `filePath`
   * 从不做包含性判断（底层的 checkSyntaxValidity / checkAllImports 也不做），
   * 所以别把这条读成「设了 enabled:false 之后所有路径面仍有 guard 兜底」。
   */
  enabled?: boolean;
  /** 启用的检查 */
  enabledChecks?: {
    fileExistence?: boolean;
    importValidity?: boolean;
    syntaxValidity?: boolean;
    sddCompliance?: boolean;
  };
}

/**
 * 幻觉防控器类
 */
export class HallucinationGuard {
  private config: GuardConfig;
  private readonly enabled: boolean;
  private enabledChecks: Required<NonNullable<GuardConfig['enabledChecks']>>;

  constructor(config: GuardConfig) {
    this.config = config;
    this.enabled = config.enabled ?? true;
    this.enabledChecks = {
      fileExistence: config.enabledChecks?.fileExistence ?? true,
      importValidity: config.enabledChecks?.importValidity ?? true,
      syntaxValidity: config.enabledChecks?.syntaxValidity ?? true,
      sddCompliance: config.enabledChecks?.sddCompliance ?? true,
    };
  }

  private validatePathContainment(path: string): HallucinationCheckResult | undefined {
    const resolvedRoot = resolve(this.config.projectRoot);
    if (isInsidePath(resolve(resolvedRoot, path), resolvedRoot)) return undefined;
    return {
      pass: false,
      type: 'file_existence',
      severity: 'block',
      message: `Security violation: Path "${path}" is outside project root`,
      details: { path, projectRoot: this.config.projectRoot },
    };
  }

  /**
   * 某项检查是否启用。
   *
   * 公开出来是必要的：执行器有自己的写盘前门禁，若它不查这份配置，
   * `enabledChecks` 就又变成「关不掉」——正是 #386 让消融基准的 guard 臂失效的机制。
   * 任何在 guard 之外复刻检查语义的调用方，都必须先问过这里。
   *
   * 全局 `enabled` 是与项：#400 让 `enabled: false` 能真正关停 agent 路径上的检查，
   * 少了这一项，单项开关全开时那个总开关就又失效了。
   */
  isCheckEnabled(check: keyof NonNullable<GuardConfig['enabledChecks']>): boolean {
    return this.enabled && this.enabledChecks[check];
  }

  /**
   * 验证 Agent 输出
   */
  async validate(output: AgentOutput): Promise<ValidationResult> {
    const results: HallucinationCheckResult[] = [];

    // 1. 文件存在性检查
    if (this.isCheckEnabled('fileExistence') && output.targetPath) {
      const shouldExist = ['read_file', 'apply_patch', 'delete_file'].includes(output.action);
      const fileCheck = await checkFileExistence({
        path: output.targetPath,
        projectRoot: this.config.projectRoot,
        shouldExist,
      });
      results.push(fileCheck);
    } else if (output.targetPath) {
      const containmentCheck = this.validatePathContainment(output.targetPath);
      if (containmentCheck) results.push(containmentCheck);
    }

    // 2. 导入有效性检查
    if (this.isCheckEnabled('importValidity') && output.content && output.targetPath) {
      const imports = output.imports ?? extractImports(output.content);
      if (imports.length > 0) {
        const importChecks = await checkAllImports(
          output.content,
          output.targetPath,
          this.config.projectRoot,
        );
        results.push(...importChecks);
      }
    }

    // 3. 语法有效性检查
    if (this.isCheckEnabled('syntaxValidity') && output.content && output.language) {
      const syntaxCheck = await checkSyntaxValidity({
        code: output.content,
        language: output.language,
        filePath: output.targetPath,
      });
      results.push(syntaxCheck);
    }

    // 4. SDD 合规性检查
    if (this.isCheckEnabled('sddCompliance') && this.config.sddConfig) {
      const agentAction: AgentAction = {
        type: output.action,
        targetPath: output.targetPath,
        sourcePath: output.sourcePath,
        content: output.content,
        imports: output.imports,
        dependencies: output.dependencies,
      };

      const sddCheck = await checkSDDCompliance({
        action: agentAction,
        sddConfig: this.config.sddConfig,
      });
      results.push(sddCheck);
    }

    // 汇总结果
    const blockedBy = results
      .filter((r) => !r.pass && r.severity === 'block')
      .map((r) => r.message ?? r.type);

    const warnings = results.filter((r) => r.severity === 'warn').map((r) => r.message ?? r.type);

    return {
      pass: blockedBy.length === 0,
      results,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * 快速验证文件路径
   */
  async validateFilePath(path: string, shouldExist = true): Promise<HallucinationCheckResult> {
    if (!this.isCheckEnabled('fileExistence')) {
      // 包含性判断是安全边界而非幻觉检查，禁用 fileExistence 时仍需生效
      const containmentCheck = this.validatePathContainment(path);
      if (containmentCheck) return containmentCheck;
      return {
        pass: true,
        type: 'file_existence',
        severity: 'info',
        message: 'File existence check is disabled',
        details: { path, shouldExist },
      };
    }

    return checkFileExistence({
      path,
      projectRoot: this.config.projectRoot,
      shouldExist,
    });
  }

  /**
   * 快速验证代码
   */
  async validateCode(
    code: string,
    language: 'typescript' | 'javascript' | 'json' | 'yaml',
    filePath?: string,
  ): Promise<ValidationResult> {
    const results: HallucinationCheckResult[] = [];

    // 语法检查
    if (this.isCheckEnabled('syntaxValidity')) {
      const syntaxCheck = await checkSyntaxValidity({ code, language, filePath });
      results.push(syntaxCheck);
    }

    // 导入检查（仅 TS/JS）
    if (
      this.isCheckEnabled('importValidity') &&
      (language === 'typescript' || language === 'javascript') &&
      filePath
    ) {
      const importChecks = await checkAllImports(code, filePath, this.config.projectRoot);
      results.push(...importChecks);
    }

    const blockedBy = results
      .filter((r) => !r.pass && r.severity === 'block')
      .map((r) => r.message ?? r.type);

    return {
      pass: blockedBy.length === 0,
      results,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
    };
  }

  /**
   * 更新 SDD 配置
   */
  updateSDDConfig(sddConfig: SDDConfig): void {
    this.config.sddConfig = sddConfig;
  }

  /**
   * 启用/禁用单项检查。
   *
   * 全局 `enabled: false` 优先：此时把某一项设为 true 不会让它重新生效，
   * 该字段是 readonly 且没有全局重启入口。调用方拿不到任何失败反馈，
   * 所以优先级写在这里。
   */
  setCheckEnabled(check: keyof NonNullable<GuardConfig['enabledChecks']>, enabled: boolean): void {
    this.enabledChecks[check] = enabled;
  }
}

/**
 * 创建幻觉防控器实例
 */
export function createHallucinationGuard(config: GuardConfig): HallucinationGuard {
  return new HallucinationGuard(config);
}
