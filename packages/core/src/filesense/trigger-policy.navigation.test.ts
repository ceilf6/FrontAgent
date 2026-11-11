import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTask, ExecutionStep } from '@frontagent/shared';
import { expect, it } from 'vitest';
import { handleFilesenseTool } from '../../../mcp-filesense/src/tools.js';
import { decideFilesense } from './trigger-policy.js';

it.each(['search_code', 'list_directory'] as const)(
  'discovers nested files at the planned depth for a dotted %s directory',
  async (action) => {
    const root = await mkdtemp(join(tmpdir(), 'fa-policy-navigation-'));
    const directory = 'src/features/cart.v2';
    const file = `${directory}/lib/utils/merge.ts`;
    try {
      await mkdir(join(root, directory, 'lib/utils'), { recursive: true });
      await writeFile(join(root, file), 'export const merge = () => 1;');
      const decision = decideFilesense(
        { type: 'query', description: 'Explain responsibilities here' } as AgentTask,
        [
          { action, params: { [action === 'search_code' ? 'directory' : 'path']: directory } },
        ] as ExecutionStep[],
      );
      const result = await handleFilesenseTool(
        'filesense_navigate',
        { ...decision, writeMode: 'none' },
        root,
      );
      expect(result).toMatchObject({
        success: true,
        data: {
          factsDelta: { existingFiles: [file] },
          scanned: { paths: [directory], depth: 2, truncated: false },
          warnings: [],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
