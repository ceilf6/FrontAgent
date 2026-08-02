import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ChatMode, ViewState } from '../state.js';
import { FrontAgentViewProvider } from '../view-provider.js';
import { __test } from './vscode-stub.js';

type SendMessage = {
  type: 'send';
  task: string;
  mode: ChatMode;
  files: string[];
  url?: string;
};

interface ProviderInternals {
  state: ViewState;
  view?: { webview: { postMessage: (message: unknown) => void } };
  activeRun?: AbortController;
  runtimeModulePromise?: Promise<unknown>;
  startRun(message: SendMessage): Promise<void>;
  cancelRun(): void;
  clearDeclinedEndpoints(): void;
  refreshConfigurationStatus(): Promise<void>;
  saveInlineConfiguration(message: {
    type: 'saveConfig';
    provider: string;
    model: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<void>;
}

interface CapturedRunOptions {
  signal: AbortSignal;
  baseUrl?: string;
  onEvent: (event: Record<string, unknown> & { type: string }) => void;
}

interface RunCall {
  options: CapturedRunOptions;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    secrets: {
      get: async () => 'test-api-key',
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

const context = makeContext();

function makeProvider(providerContext: vscode.ExtensionContext = context): ProviderInternals {
  const provider = new FrontAgentViewProvider(
    providerContext,
    () => {},
    () => {},
  );
  return provider as unknown as ProviderInternals;
}

function fakeRuntime(): { module: unknown; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const module = {
    runFrontAgentTask: (options: CapturedRunOptions) =>
      new Promise((resolve, reject) => {
        calls.push({ options, resolve, reject });
      }),
  };
  return { module, calls };
}

function send(task: string): SendMessage {
  return { type: 'send', task, mode: 'query', files: [] };
}

const ENDPOINT_ENV_KEYS = [
  'PROVIDER',
  'MODEL',
  'BASE_URL',
  'API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
] as const;

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FrontAgentViewProvider run lifecycle', () => {
  beforeEach(() => {
    __test.reset();
    __test.workspaceFolders = [{ uri: { fsPath: '/tmp/test-ws' }, name: 'ws', index: 0 }];
    __test.settings.set('provider', 'openai');
    __test.settings.set('model', 'test-model');
    __test.settings.set('baseUrl', 'https://example.com/v1');
  });

  it('clears activeRun when the runtime module fails to load, allowing a retry', async () => {
    const provider = makeProvider();
    const rejected = Promise.reject(new Error('missing bundle'));
    rejected.catch(() => {});
    provider.runtimeModulePromise = rejected;

    await provider.startRun(send('first task'));

    expect(provider.activeRun).toBeUndefined();
    expect(provider.state.isRunning).toBe(false);
    expect(provider.state.error).toContain('missing bundle');

    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);
    await provider.startRun(send('retry task'));

    expect(__test.warnings).toHaveLength(0);
    expect(provider.state.isRunning).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('still blocks a second send while a run is active', async () => {
    const provider = makeProvider();
    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);

    await provider.startRun(send('first task'));
    await provider.startRun(send('second task'));

    expect(__test.warnings).toEqual(['FrontAgent is already running in this workspace.']);
    expect(calls).toHaveLength(1);
  });

  it('cancelRun clears activeRun immediately and ignores callbacks from the cancelled run', async () => {
    const provider = makeProvider();
    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);

    await provider.startRun(send('first task'));
    expect(provider.state.isRunning).toBe(true);

    provider.cancelRun();
    expect(provider.activeRun).toBeUndefined();
    expect(provider.state.isRunning).toBe(false);
    expect(provider.state.error).toContain('cancelled');
    expect(calls[0]?.options.signal.aborted).toBe(true);

    await provider.startRun(send('second task'));
    expect(__test.warnings).toHaveLength(0);
    expect(provider.state.isRunning).toBe(true);
    expect(calls).toHaveLength(2);

    calls[0]?.reject(new Error('FrontAgent run cancelled by user'));
    await flushMicrotasks();
    expect(provider.state.isRunning).toBe(true);
    expect(provider.activeRun).toBeDefined();

    const labelBefore = provider.state.lastActivityLabel;
    calls[0]?.options.onEvent({ type: 'status_update', label: 'stale', operation: 'stale' });
    expect(provider.state.lastActivityLabel).toBe(labelBefore);
  });
});

describe('FrontAgentViewProvider workspace endpoint gate', () => {
  const APPROVE = 'FrontAgent: this workspace selects a different LLM endpoint';

  beforeEach(() => {
    __test.reset();
    __test.workspaceFolders = [{ uri: { fsPath: '/tmp/test-ws' }, name: 'ws', index: 0 }];
    __test.settings.set('provider', 'openai');
    __test.settings.set('model', 'test-model');
    __test.settings.set('baseUrl', 'https://example.com/v1');
    __test.workspaceSettings.set('baseUrl', 'http://127.0.0.1:4319/v1');
    // Vitest sets process.env.BASE_URL='/', which the env fallback would
    // otherwise accept as a configured endpoint.
    for (const key of ENDPOINT_ENV_KEYS) delete process.env[key];
  });

  // In afterEach, not at the end of a test body: an assertion that throws would
  // otherwise leak PROVIDER/BASE_URL into later suites and produce cascading
  // failures unrelated to the real defect.
  afterEach(() => {
    for (const key of ENDPOINT_ENV_KEYS) delete process.env[key];
  });

  it('asks before the first request and keeps the user endpoint when dismissed', async () => {
    const provider = makeProvider(makeContext());
    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);
    __test.modalResponses.set(APPROVE, undefined);

    await provider.startRun(send('task'));

    expect(__test.modalPrompts).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.baseUrl).toBe('https://example.com/v1');
  });

  it('uses the workspace endpoint after the user approves it', async () => {
    const provider = makeProvider(makeContext());
    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);
    __test.modalResponses.set(APPROVE, 'Use workspace endpoint');

    await provider.startRun(send('task'));

    expect(__test.modalPrompts).toHaveLength(1);
    expect(calls[0]?.options.baseUrl).toBe('http://127.0.0.1:4319/v1');
  });

  it('never prompts from the webview load path, only from an actual run', async () => {
    // `ready` and `saveConfig` both call refreshConfigurationStatus. If it ever
    // prompted, opening the sidebar would raise a modal — the approval fatigue
    // this gate is supposed to avoid, on the surface users see most often.
    const provider = makeProvider(makeContext());
    __test.modalResponses.set(APPROVE, 'Use workspace endpoint');

    await provider.refreshConfigurationStatus();

    expect(__test.modalPrompts).toHaveLength(0);
    expect(provider.state.configStatus.endpointTrust.requiresApproval).toBe(true);
    expect(provider.state.configStatus.baseUrl).toBe('https://example.com/v1');
  });

  it('does not re-prompt on every message after the user dismisses it once', async () => {
    const provider = makeProvider(makeContext());
    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);
    __test.modalResponses.set(APPROVE, undefined);

    await provider.startRun(send('first task'));
    provider.cancelRun();
    await provider.startRun(send('second task'));
    provider.cancelRun();
    await provider.startRun(send('third task'));

    // Approval fatigue would push the user toward clicking through the dialog.
    expect(__test.modalPrompts).toHaveLength(1);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.options.baseUrl).toBe('https://example.com/v1');
    }
  });

  it('points a declining user at the reset command instead of telling them to approve', async () => {
    __test.settings.delete('baseUrl'); // no user endpoint, so the run cannot proceed
    const provider = makeProvider(makeContext());
    provider.runtimeModulePromise = Promise.resolve(fakeRuntime().module);
    __test.modalResponses.set(APPROVE, undefined);

    await provider.startRun(send('first task'));
    await provider.startRun(send('second task'));

    // The second failure must not repeat "approve it" — no prompt is coming.
    expect(provider.state.error).toContain('Reset Workspace Endpoint Approval');
    expect(provider.state.error).not.toContain('until you approve it');
    expect(provider.state.configStatus.endpointTrust.declinedThisSession).toBe(true);
  });

  it('blocks a concurrent send while the endpoint confirmation is still open', async () => {
    const provider = makeProvider(makeContext());
    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);
    __test.modalResponses.set(APPROVE, 'Use workspace endpoint');

    // `activeRun` is not assigned until the runtime is invoked, and the modal
    // awaits well before that. Two sends in that window must not both proceed.
    await Promise.all([provider.startRun(send('first')), provider.startRun(send('second'))]);

    expect(__test.modalPrompts).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(__test.warnings).toEqual(['FrontAgent is already running in this workspace.']);
  });

  it('saves the sidebar form to User Settings, not to the repository-writable scope', async () => {
    const provider = makeProvider(makeContext());

    await provider.saveInlineConfiguration({
      type: 'saveConfig',
      provider: 'openai',
      model: 'my-model',
      baseUrl: 'https://mine.test/v1',
    });

    expect(__test.configUpdates.map((update) => update.target)).toEqual([1, 1, 1]);
  });

  it('does not write empty endpoint settings when the form was left blank', async () => {
    // The form prefills only from user scope, so an env-configured user sees
    // empty inputs. Opening it to set an API key must not blank their global
    // settings, and the key must still reach the provider-specific slot.
    __test.reset();
    __test.workspaceFolders = [{ uri: { fsPath: '/tmp/test-ws' }, name: 'ws', index: 0 }];
    process.env.PROVIDER = 'openai';
    process.env.MODEL = 'env-model';
    process.env.BASE_URL = 'https://env.test/v1';
    const stored: string[] = [];
    const context = {
      secrets: {
        get: async () => undefined,
        store: async (key: string) => {
          stored.push(key);
        },
      },
      globalState: { get: () => undefined, update: async () => {} },
    } as unknown as vscode.ExtensionContext;
    const provider = makeProvider(context);
    await provider.refreshConfigurationStatus();

    await provider.saveInlineConfiguration({
      type: 'saveConfig',
      provider: '',
      model: '',
      baseUrl: '',
      apiKey: 'a-key',
    });

    expect(__test.configUpdates).toEqual([]);
    expect(stored).toEqual(['frontagent.apiKey.openai']);
  });

  it('keeps showing that an approved workspace endpoint is in use', async () => {
    const provider = makeProvider(makeContext());
    provider.runtimeModulePromise = Promise.resolve(fakeRuntime().module);
    __test.modalResponses.set(APPROVE, 'Use workspace endpoint');

    await provider.startRun(send('task'));

    // The approval persists across sessions, so "ready with your settings"
    // would be false for as long as it stands.
    const notice = provider.state.configStatus.endpointTrust.notice;
    expect(notice).toContain('approved endpoint');
    expect(notice).toContain('127.0.0.1');
    expect(notice).toContain('Reset Workspace Endpoint Approval');
  });

  it('never prefills the sidebar form with an approved workspace endpoint', async () => {
    const provider = makeProvider(makeContext());
    provider.runtimeModulePromise = Promise.resolve(fakeRuntime().module);
    __test.modalResponses.set(APPROVE, 'Use workspace endpoint');

    await provider.startRun(send('task'));

    // The form saves to User Settings, so prefilling it with the approved
    // workspace endpoint would let one Save promote it to the global default.
    expect(provider.state.configStatus.baseUrl).toBe('http://127.0.0.1:4319/v1');
    expect(provider.state.configStatus.userScoped.baseUrl).toBe('https://example.com/v1');
    expect(provider.state.configStatus.userScoped.model).toBe('test-model');
  });

  it('does not let a repository re-raise the prompt by editing the endpoint', async () => {
    const provider = makeProvider(makeContext());
    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);
    __test.modalResponses.set(APPROVE, undefined);

    await provider.startRun(send('first task'));
    provider.cancelRun();
    // The repository mutates .vscode/settings.json between runs. Keying the
    // decline on the endpoint digest would reset it and re-prompt on every run.
    __test.workspaceSettings.set('baseUrl', 'http://127.0.0.1:4319/v1?x=2');
    await provider.startRun(send('second task'));

    expect(__test.modalPrompts).toHaveLength(1);
    expect(calls[1]?.options.baseUrl).toBe('https://example.com/v1');
  });

  it('asks again after the reset command clears the session decline', async () => {
    const provider = makeProvider(makeContext());
    provider.runtimeModulePromise = Promise.resolve(fakeRuntime().module);
    __test.modalResponses.set(APPROVE, undefined);

    await provider.startRun(send('first task'));
    provider.cancelRun();
    provider.clearDeclinedEndpoints();
    await provider.startRun(send('second task'));

    expect(__test.modalPrompts).toHaveLength(2);
  });

  it('does not ask again for an endpoint already approved in this workspace', async () => {
    const sharedContext = makeContext();
    __test.modalResponses.set(APPROVE, 'Use workspace endpoint');

    const first = makeProvider(sharedContext);
    first.runtimeModulePromise = Promise.resolve(fakeRuntime().module);
    await first.startRun(send('first task'));
    expect(__test.modalPrompts).toHaveLength(1);

    const second = makeProvider(sharedContext);
    const { module, calls } = fakeRuntime();
    second.runtimeModulePromise = Promise.resolve(module);
    await second.startRun(send('second task'));

    expect(__test.modalPrompts).toHaveLength(1);
    expect(calls[0]?.options.baseUrl).toBe('http://127.0.0.1:4319/v1');
  });
});

describe('FrontAgentViewProvider state posting', () => {
  beforeEach(() => {
    __test.reset();
    __test.workspaceFolders = [{ uri: { fsPath: '/tmp/test-ws' }, name: 'ws', index: 0 }];
    __test.settings.set('provider', 'openai');
    __test.settings.set('model', 'test-model');
    __test.settings.set('baseUrl', 'https://example.com/v1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startWithCapturedPosts(): Promise<{
    provider: ProviderInternals;
    onEvent: CapturedRunOptions['onEvent'];
    resolveRun: (result: unknown) => void;
    posts: unknown[];
  }> {
    const provider = makeProvider();
    const posts: unknown[] = [];
    provider.view = { webview: { postMessage: (message) => posts.push(message) } };
    const { module, calls } = fakeRuntime();
    provider.runtimeModulePromise = Promise.resolve(module);

    await provider.startRun(send('stream task'));
    const call = calls[0];
    if (!call) throw new Error('runFrontAgentTask was not called');
    posts.length = 0;
    return { provider, onEvent: call.options.onEvent, resolveRun: call.resolve, posts };
  }

  it('throttles full-state posts for stream_token events to the trailing edge', async () => {
    const { provider, onEvent, posts } = await startWithCapturedPosts();

    for (let i = 0; i < 25; i += 1) {
      onEvent({ type: 'stream_token', token: `t${i} ` });
    }
    // Inside the throttle window right after startRun's own post: nothing yet.
    expect(posts).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(posts).toHaveLength(1);
    expect(provider.state.streamText).toContain('t24');
    const posted = posts[0] as { type: string; state: ViewState };
    expect(posted.type).toBe('state');
    expect(posted.state.streamText).toContain('t24');
  });

  it('posts non-stream events immediately and supersedes a pending stream post', async () => {
    const { onEvent, posts } = await startWithCapturedPosts();

    onEvent({ type: 'stream_token', token: 'hello' });
    expect(posts).toHaveLength(0);

    onEvent({ type: 'status_update', label: 'working', operation: 'op' });
    expect(posts).toHaveLength(1);

    // The immediate post flushed the pending trailing-edge timer.
    vi.advanceTimersByTime(200);
    expect(posts).toHaveLength(1);
  });

  it('applies terminal state exactly once, via events rather than the resolved promise', async () => {
    const { provider, onEvent, resolveRun, posts } = await startWithCapturedPosts();

    onEvent({ type: 'task_failed', error: 'boom from events' });
    expect(provider.state.status).toBe('error');
    expect(provider.state.error).toBe('boom from events');
    const errorMessages = provider.state.messages.filter((message) => message.role === 'error');
    expect(errorMessages).toHaveLength(1);

    resolveRun({ success: false, executedSteps: [], error: 'synthetic resolved error' });
    await vi.advanceTimersByTimeAsync(0);

    // The resolved result must not be re-reduced into a second terminal state.
    expect(provider.state.error).toBe('boom from events');
    expect(provider.state.messages.filter((message) => message.role === 'error')).toHaveLength(1);
    expect(provider.state.isRunning).toBe(false);
    expect(posts.length).toBeGreaterThan(0);
  });
});
