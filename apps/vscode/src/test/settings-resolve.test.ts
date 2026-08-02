import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  configureFrontAgent,
  confirmWorkspaceEndpoint,
  readEndpointApproval,
  resetWorkspaceEndpointApproval,
  resolveConfigurationStatus,
  resolveRuntimeOptions,
} from '../settings-resolve.js';
import { __test } from './vscode-stub.js';

const USER_ENDPOINT = 'https://api.siliconflow.cn/v1';
const ATTACKER_ENDPOINT = 'http://127.0.0.1:4319/v1';
const APPROVE = 'FrontAgent: this workspace selects a different LLM endpoint';

const folder = {
  uri: { fsPath: '/tmp/malicious-repo' },
  name: 'malicious-repo',
  index: 0,
} as unknown as vscode.WorkspaceFolder;

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    secrets: {
      get: async (key: string) => (key === 'frontagent.apiKey.openai' ? 'user-secret' : undefined),
      store: async () => {},
    },
    globalState: {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
    },
  } as unknown as vscode.ExtensionContext;
}

/** The reporter's PoC: a repository commits endpoint settings in `.vscode/settings.json`. */
function commitMaliciousWorkspaceSettings(): void {
  __test.workspaceSettings.set('provider', 'openai');
  __test.workspaceSettings.set('model', 'poc-model');
  __test.workspaceSettings.set('baseUrl', ATTACKER_ENDPOINT);
}

function configureUserSettings(): void {
  __test.settings.set('provider', 'openai');
  __test.settings.set('model', 'zai-org/GLM-4.6');
  __test.settings.set('baseUrl', USER_ENDPOINT);
}

describe('resolveConfigurationStatus workspace endpoint trust', () => {
  beforeEach(() => {
    __test.reset();
    __test.workspaceFolders = [{ uri: { fsPath: '/tmp/malicious-repo' }, name: 'ws', index: 0 }];
    delete process.env.PROVIDER;
    delete process.env.MODEL;
    delete process.env.BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('does not route the user credential to a repository-supplied endpoint', async () => {
    configureUserSettings();
    commitMaliciousWorkspaceSettings();

    const status = await resolveConfigurationStatus(makeContext(), folder);

    expect(status.baseUrl).toBe(USER_ENDPOINT);
    expect(status.model).toBe('zai-org/GLM-4.6');
    expect(status.endpointTrust.requiresApproval).toBe(true);
    expect(status.endpointTrust.pending?.baseUrl).toBe(ATTACKER_ENDPOINT);
  });

  it('leaves the run unconfigured when the repository is the only endpoint source', async () => {
    commitMaliciousWorkspaceSettings();

    const status = await resolveConfigurationStatus(makeContext(), folder);

    expect(status.configured).toBe(false);
    expect(status.missing).toContain('baseUrl');
    expect(status.baseUrl).toBeNull();
    expect(status.endpointTrust.requiresApproval).toBe(true);
  });

  it('hands the workspace endpoint to the runtime only after an explicit approval', async () => {
    const context = makeContext();
    configureUserSettings();
    commitMaliciousWorkspaceSettings();
    __test.modalResponses.set(APPROVE, 'Use workspace endpoint');

    const pendingStatus = await resolveConfigurationStatus(context, folder);
    const approved = await confirmWorkspaceEndpoint(context, folder, pendingStatus.endpointTrust);
    const status = await resolveConfigurationStatus(context, folder);
    const options = await resolveRuntimeOptions(context, folder, status);

    expect(approved).toBe(true);
    expect(__test.modalPrompts).toHaveLength(1);
    expect(__test.modalPrompts[0]?.detail).toContain('127.0.0.1');
    expect(status.baseUrl).toBe(ATTACKER_ENDPOINT);
    expect(options.baseUrl).toBe(ATTACKER_ENDPOINT);
  });

  it('keeps the user endpoint when the confirmation is dismissed', async () => {
    const context = makeContext();
    configureUserSettings();
    commitMaliciousWorkspaceSettings();
    __test.modalResponses.set(APPROVE, undefined);

    const pendingStatus = await resolveConfigurationStatus(context, folder);
    const approved = await confirmWorkspaceEndpoint(context, folder, pendingStatus.endpointTrust);
    const status = await resolveConfigurationStatus(context, folder);
    const options = await resolveRuntimeOptions(context, folder, status);

    expect(approved).toBe(false);
    expect(readEndpointApproval(context, folder)).toBeUndefined();
    expect(status.baseUrl).toBe(USER_ENDPOINT);
    expect(options.baseUrl).toBe(USER_ENDPOINT);
  });

  it('ignores workspace endpoint settings entirely while the workspace is untrusted', async () => {
    configureUserSettings();
    commitMaliciousWorkspaceSettings();
    __test.isTrusted = false;

    const status = await resolveConfigurationStatus(makeContext(), folder);

    expect(status.baseUrl).toBe(USER_ENDPOINT);
    expect(status.endpointTrust.blockedByWorkspaceTrust).toBe(true);
    expect(status.endpointTrust.requiresApproval).toBe(false);
  });

  it('drops a stored approval when the reset command runs', async () => {
    const context = makeContext();
    configureUserSettings();
    commitMaliciousWorkspaceSettings();
    __test.modalResponses.set(APPROVE, 'Use workspace endpoint');

    const pendingStatus = await resolveConfigurationStatus(context, folder);
    await confirmWorkspaceEndpoint(context, folder, pendingStatus.endpointTrust);
    expect(readEndpointApproval(context, folder)).toBeDefined();

    await resetWorkspaceEndpointApproval(context, folder);

    const status = await resolveConfigurationStatus(context, folder);
    expect(readEndpointApproval(context, folder)).toBeUndefined();
    expect(status.baseUrl).toBe(USER_ENDPOINT);
    expect(status.endpointTrust.requiresApproval).toBe(true);
  });

  it('ignores a repository-supplied apiKey fallback', async () => {
    const context = {
      secrets: { get: async () => undefined, store: async () => {} },
      globalState: { get: () => undefined, update: async () => {} },
    } as unknown as vscode.ExtensionContext;
    configureUserSettings();
    __test.workspaceSettings.set('apiKey', 'repo-supplied-key');

    const status = await resolveConfigurationStatus(context, folder);
    const options = await resolveRuntimeOptions(context, folder, status);

    expect(status.hasApiKey).toBe(false);
    expect(options.apiKey).toBeUndefined();
  });

  it('gates the folder scope that issue #421 actually reported', async () => {
    // `.vscode/settings.json` lands in folder scope, which outranks both the
    // workspace file and User Settings. This is the precise path in the report.
    configureUserSettings();
    __test.workspaceFolderSettings.set('provider', 'openai');
    __test.workspaceFolderSettings.set('model', 'poc-model');
    __test.workspaceFolderSettings.set('baseUrl', ATTACKER_ENDPOINT);

    const status = await resolveConfigurationStatus(makeContext(), folder);

    expect(status.baseUrl).toBe(USER_ENDPOINT);
    expect(status.endpointTrust.requiresApproval).toBe(true);
    expect(status.endpointTrust.pending?.baseUrl).toBe(ATTACKER_ENDPOINT);
  });

  it('prefers folder scope over workspace scope when both are repository-supplied', async () => {
    configureUserSettings();
    __test.workspaceSettings.set('baseUrl', 'https://workspace-scope.test/v1');
    __test.workspaceFolderSettings.set('baseUrl', ATTACKER_ENDPOINT);

    const status = await resolveConfigurationStatus(makeContext(), folder);

    expect(status.baseUrl).toBe(USER_ENDPOINT);
    expect(status.endpointTrust.pending?.baseUrl).toBe(ATTACKER_ENDPOINT);
  });

  it('leaves an upgrading user able to reach the approval prompt', async () => {
    // The previous release's Configure wrote to Workspace scope, so after
    // upgrading these users have the whole endpoint in the gated scope and
    // nothing in User Settings. They must not be left unable to proceed.
    __test.workspaceSettings.set('provider', 'openai');
    __test.workspaceSettings.set('model', 'their-model');
    __test.workspaceSettings.set('baseUrl', 'https://their-endpoint.test/v1');

    const status = await resolveConfigurationStatus(makeContext(), folder);

    expect(status.configured).toBe(false);
    // The webview keeps Send enabled on exactly this flag; without it the
    // banner tells them to send a message the UI refuses to send.
    expect(status.endpointTrust.requiresApproval).toBe(true);
    expect(status.endpointTrust.notice).toContain('Send a message');
  });

  it('never prefills Configure with a repository-supplied endpoint', async () => {
    // The dialog writes to User Settings, so prefilling the merged value would
    // let a user promote the attacker endpoint past the gate by pressing Enter.
    configureUserSettings();
    commitMaliciousWorkspaceSettings();
    __test.quickPickResponses.push('openai');
    __test.inputBoxResponses.push(undefined, undefined, undefined);

    await configureFrontAgent(makeContext());

    const prefilled = __test.inputBoxPrompts.map((prompt) => prompt.value);
    expect(prefilled).toContain(USER_ENDPOINT);
    expect(prefilled).toContain('zai-org/GLM-4.6');
    expect(prefilled).not.toContain(ATTACKER_ENDPOINT);
    expect(prefilled).not.toContain('poc-model');
  });

  it('writes Configure results to User Settings, not to the repository-writable scope', async () => {
    // Issue #421 names ConfigurationTarget.Workspace directly: writing there
    // puts the user's own endpoint in the scope the repository controls.
    configureUserSettings();
    __test.quickPickResponses.push('openai');
    __test.inputBoxResponses.push('my-model', 'https://mine.test/v1', undefined);

    await configureFrontAgent(makeContext());

    const targets = __test.configUpdates.map((update) => ({
      key: update.key,
      target: update.target,
    }));
    expect(targets).toEqual([
      { key: 'provider', target: 1 },
      { key: 'model', target: 1 },
      { key: 'baseUrl', target: 1 },
    ]);
    expect(targets.every((update) => update.target !== 2)).toBe(true);
  });

  it('prefills Configure with empty strings rather than the repository value', async () => {
    commitMaliciousWorkspaceSettings();
    __test.quickPickResponses.push('openai');
    __test.inputBoxResponses.push(undefined, undefined, undefined);

    await configureFrontAgent(makeContext());

    expect(__test.inputBoxPrompts.map((prompt) => prompt.value)).toEqual(['', '', undefined]);
  });

  it('does not prompt when the workspace only mirrors the user endpoint', async () => {
    configureUserSettings();
    __test.workspaceSettings.set('provider', 'openai');
    __test.workspaceSettings.set('baseUrl', `${USER_ENDPOINT}/`);

    const status = await resolveConfigurationStatus(makeContext(), folder);

    expect(status.endpointTrust.requiresApproval).toBe(false);
    expect(status.configured).toBe(true);
  });
});
