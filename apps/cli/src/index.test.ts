import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliProgram } from './index.js';

async function parseWithCapturedOutput(program: Command, argv: string[]) {
  let stdout = '';
  let stderr = '';

  program.configureOutput({
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  });
  program.exitOverride();

  try {
    await program.parseAsync(['node', 'fa', ...argv], { from: 'node' });
  } catch (error) {
    const commanderError = error as { code?: string; exitCode?: number };
    if (commanderError.exitCode !== 0) {
      throw error;
    }
  }

  return { stdout, stderr };
}

describe('CLI command router', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the injected version without running command handlers', async () => {
    const program = createCliProgram({ version: '1.2.3' });

    const { stdout, stderr } = await parseWithCapturedOutput(program, ['--version']);

    expect(stdout.trim()).toBe('1.2.3');
    expect(stderr).toBe('');
  });

  it('prints the injected version from the version subcommand', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCliProgram({ version: '1.2.3' });

    await program.parseAsync(['node', 'fa', 'version'], { from: 'node' });

    expect(consoleLog).toHaveBeenCalledWith('1.2.3');
  });

  it('prints help for the root command without running command handlers', async () => {
    const program = createCliProgram({ version: '1.2.3' });

    const { stdout, stderr } = await parseWithCapturedOutput(program, ['--help']);

    expect(stdout).toContain('FrontAgent');
    expect(stdout).toContain('run [options] <task>');
    expect(stderr).toBe('');
  });

  it('parses representative run flags before delegating to the run handler', async () => {
    const runCalls: Array<{ task: string; options: Record<string, unknown> }> = [];
    const program = createCliProgram({
      version: '1.2.3',
      handlers: {
        run: async (task, options) => {
          runCalls.push({ task, options });
        },
      },
    });

    await program.parseAsync(
      [
        'node',
        'fa',
        'run',
        'ship it',
        '--type',
        'debug',
        '--files',
        'src/a.ts',
        'src/b.ts',
        '--model',
        'gpt-test',
        '--disable-rag',
        '--no-run-log',
        '--security-mode',
        'strict',
        '--rag-max-results',
        '7',
      ],
      { from: 'node' },
    );

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.task).toBe('ship it');
    expect(runCalls[0]?.options).toMatchObject({
      type: 'debug',
      files: ['src/a.ts', 'src/b.ts'],
      model: 'gpt-test',
      disableRag: true,
      runLog: false,
      securityMode: 'strict',
      ragMaxResults: '7',
    });
  });
});
