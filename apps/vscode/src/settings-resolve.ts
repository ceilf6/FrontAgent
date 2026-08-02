import type { RuntimeConfigInput } from '@frontagent/runtime-node';
import * as vscode from 'vscode';
import {
  describeWorkspaceEndpoint,
  type EndpointTrustStatus,
  resolveEndpointTrust,
  type ScopedEndpointSettings,
  type ScopedSetting,
} from './endpoint-trust.js';
import { resolveConfigStatusFromSources } from './settings.js';
import type { ConfigStatus } from './state.js';

export const SECRET_API_KEY = 'frontagent.apiKey';

/** Per-workspace-folder record of endpoint fingerprints the user approved. */
const ENDPOINT_APPROVAL_STATE_KEY = 'frontagent.approvedWorkspaceEndpoints';

const USE_WORKSPACE_ENDPOINT = 'Use workspace endpoint';

export function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))];
}

export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Open a workspace folder before using FrontAgent.');
  }
  return folder;
}

/**
 * Splits a setting by originating scope. `get()` returns the merged value, in
 * which folder configuration outranks User Settings, so it cannot distinguish
 * a value the user chose from one the opened repository committed.
 */
function readScopedSetting(config: vscode.WorkspaceConfiguration, key: string): ScopedSetting {
  const inspected = config.inspect<string>(key);
  return {
    // `defaultValue` is deliberately not folded in: a manifest default is not
    // something the user chose, and treating it as user scope would make the
    // dialog report it as "your setting" the moment any of these keys gains a
    // non-empty default.
    userValue: emptyToUndefined(inspected?.globalValue),
    // These three keys declare no `scope` in package.json, so they are `window`
    // scoped and VS Code does not apply folder-level values to them in a
    // multi-root workspace. If `inspect()` still reports a
    // `workspaceFolderValue` there, this picks a value VS Code itself would
    // ignore — the gate would prompt about an endpoint that is not in effect,
    // and hand the approved value to the runtime. Not verified in an Extension
    // Host; single-root is the common case and takes the `workspaceValue`
    // branch, which is correct. Erring toward over-prompting is the safe
    // direction: nothing is redirected without an explicit approval either way.
    workspaceValue: emptyToUndefined(inspected?.workspaceFolderValue ?? inspected?.workspaceValue),
  };
}

function readScopedEndpointSettings(config: vscode.WorkspaceConfiguration): ScopedEndpointSettings {
  return {
    provider: readScopedSetting(config, 'provider'),
    model: readScopedSetting(config, 'model'),
    baseUrl: readScopedSetting(config, 'baseUrl'),
  };
}

/**
 * Mirrors the env precedence `resolveConfigStatusFromSources` applies, so the
 * gate compares a workspace value against what the user would actually get
 * without it. Provider-specific `<PROVIDER>_BASE_URL` is intentionally not
 * resolved here: which one applies depends on the provider that is itself
 * under negotiation, so `BASE_URL` is the only unambiguous fallback.
 */
function readEndpointEnvFallback(env: Record<string, string | undefined>): {
  provider?: string;
  model?: string;
  baseUrl?: string;
} {
  return {
    provider: emptyToUndefined(env.PROVIDER)?.toLowerCase(),
    model: emptyToUndefined(env.MODEL),
    baseUrl: emptyToUndefined(env.BASE_URL),
  };
}

/**
 * Approvals are keyed by folder path and kept until the reset command removes
 * them. Known trade-offs, accepted because the fingerprint covers the full
 * provider/model/base URL so a different endpoint still re-asks: the map grows
 * without eviction, and a different repository later checked out to the same
 * path inherits the approval if it proposes the identical endpoint.
 */
function workspaceApprovalKey(folder?: vscode.WorkspaceFolder): string {
  return folder?.uri.fsPath ?? '';
}

function readEndpointApprovals(context: vscode.ExtensionContext): Record<string, string> {
  return context.globalState.get<Record<string, string>>(ENDPOINT_APPROVAL_STATE_KEY) ?? {};
}

export function readEndpointApproval(
  context: vscode.ExtensionContext,
  folder?: vscode.WorkspaceFolder,
): string | undefined {
  return readEndpointApprovals(context)[workspaceApprovalKey(folder)];
}

async function writeEndpointApproval(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder | undefined,
  fingerprint: string | undefined,
): Promise<void> {
  const approvals = { ...readEndpointApprovals(context) };
  const key = workspaceApprovalKey(folder);
  if (fingerprint) {
    approvals[key] = fingerprint;
  } else {
    delete approvals[key];
  }
  await context.globalState.update(ENDPOINT_APPROVAL_STATE_KEY, approvals);
}

export async function resolveConfigurationStatus(
  context: vscode.ExtensionContext,
  folder?: vscode.WorkspaceFolder,
  declinedForWorkspace?: boolean,
): Promise<ConfigStatus> {
  const config = vscode.workspace.getConfiguration('frontagent', folder?.uri);
  const scoped = readScopedEndpointSettings(config);
  const trust = resolveEndpointTrust({
    // Fail closed: anything other than an explicit `true` is treated as
    // untrusted, so a missing or unexpected value cannot admit workspace values.
    // The extension declares no `untrustedWorkspaces` capability, so VS Code
    // disables it outright in Restricted Mode; this stays as defence in depth.
    workspaceTrusted: vscode.workspace.isTrusted === true,
    settings: scoped,
    approvedFingerprint: readEndpointApproval(context, folder),
    declinedForWorkspace,
    envFallback: readEndpointEnvFallback(process.env),
  });
  const provider = trust.effective.provider;
  const envProvider = emptyToUndefined(process.env.PROVIDER)?.toLowerCase();
  // Secrets are stored under the lowercase provider, and `resolveRuntimeOptions`
  // looks them up via the normalized `status.provider`. Lowercasing here too
  // keeps a differently-cased setting from producing a spurious "Missing: apiKey".
  const providerForSecret =
    provider?.toLowerCase() ??
    (envProvider === 'openai' || envProvider === 'anthropic' ? envProvider : undefined);
  const providerApiKey = providerForSecret
    ? await context.secrets.get(`${SECRET_API_KEY}.${providerForSecret}`)
    : undefined;
  const legacyApiKey = await context.secrets.get(SECRET_API_KEY);
  // Only the user-scoped `apiKey` fallback is honoured; a repository must never
  // be able to swap in a credential through workspace settings.
  const settingsApiKey = readScopedSetting(config, 'apiKey').userValue;
  // `effective` is stripped here; the rest is spread rather than copied field by
  // field, so a future optional field cannot silently fail to reach the webview.
  const { effective: _effective, ...endpointTrust } = trust;
  return resolveConfigStatusFromSources({
    settings: {
      provider,
      model: trust.effective.model,
      baseUrl: trust.effective.baseUrl,
      apiKey: settingsApiKey,
    },
    secrets: {
      providerApiKey,
      legacyApiKey,
    },
    env: process.env,
    endpointTrust,
    userScoped: {
      provider: scoped.provider.userValue,
      model: scoped.model.userValue,
      baseUrl: scoped.baseUrl.userValue,
    },
  });
}

/**
 * Shows the endpoint the workspace proposes and stores the approval bound to
 * that exact fingerprint. Declining leaves nothing stored, so the next run
 * falls back to user scope and asks again if the workspace value changes.
 */
export async function confirmWorkspaceEndpoint(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder | undefined,
  trust: EndpointTrustStatus,
): Promise<boolean> {
  const pending = trust.pending;
  if (!pending) return false;
  // Look up the key for the proposed provider so the dialog states what will
  // actually be sent rather than assuming the provider-specific secret exists.
  const proposedProvider = trust.overrides
    .find((override) => override.field === 'provider')
    ?.workspaceValue.trim()
    .toLowerCase();
  const hasStoredKeyForWorkspaceProvider = proposedProvider
    ? Boolean(await context.secrets.get(`${SECRET_API_KEY}.${proposedProvider}`))
    : undefined;
  const { summary, detail } = describeWorkspaceEndpoint(trust, hasStoredKeyForWorkspaceProvider);
  const choice = await vscode.window.showWarningMessage(
    summary,
    { modal: true, detail },
    USE_WORKSPACE_ENDPOINT,
  );
  if (choice !== USE_WORKSPACE_ENDPOINT) return false;
  await writeEndpointApproval(context, folder, pending.fingerprint);
  return true;
}

export async function resetWorkspaceEndpointApproval(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder | undefined,
): Promise<void> {
  await writeEndpointApproval(context, folder, undefined);
  vscode.window.showInformationMessage(
    'FrontAgent forgot the approved endpoint for this workspace. Workspace overrides will ask again.',
  );
}

export async function resolveRuntimeOptions(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  status: ConfigStatus,
): Promise<RuntimeConfigInput & { debug?: boolean }> {
  const config = vscode.workspace.getConfiguration('frontagent', folder.uri);
  const providerApiKey = status.provider
    ? await context.secrets.get(`${SECRET_API_KEY}.${status.provider}`)
    : undefined;
  const legacyApiKey = await context.secrets.get(SECRET_API_KEY);
  const settingsApiKey = readScopedSetting(config, 'apiKey').userValue;
  const providerEnvApiKey = status.provider
    ? process.env[`${status.provider.toUpperCase()}_API_KEY`]
    : undefined;
  return {
    // provider/model/baseUrl come from the trust-gated status, never from a
    // fresh `config.get()` that would reintroduce the workspace value.
    //
    // NOT gated below: `securityMode`, `rag.repo`, and `rag.branch` still read
    // the merged value, so a workspace can still set them. They are a different
    // threat than endpoint redirection — `securityMode` can only downgrade how
    // often the approval UI asks (it cannot bypass the built-in hard denies),
    // and `rag.repo` is a clone source whose content enters the LLM context.
    // `runLog.enabled` is a fourth one, read the same way in
    // view-provider.ts's startRun: a repository that both proposes an endpoint
    // and turns the run log off also removes the record of what this gate
    // caught. Tracked separately rather than widened into this fix; see #427,
    // which lists all four.
    provider: status.provider ?? undefined,
    model: status.model ?? undefined,
    baseUrl: status.baseUrl ?? undefined,
    apiKey:
      providerApiKey ?? legacyApiKey ?? settingsApiKey ?? providerEnvApiKey ?? process.env.API_KEY,
    maxTokens: config.get<number>('maxTokens', 4096),
    temperature: config.get<number>('temperature', 0.7),
    securityMode: config.get<string>('securityMode', 'balanced'),
    disableRag: !config.get<boolean>('rag.enabled', true),
    ragRepo: config.get<string>('rag.repo', 'https://github.com/ceilf6/Lab.git'),
    ragBranch: config.get<string>('rag.branch', 'main'),
  };
}

export async function configureFrontAgent(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('frontagent');
  // Prefill and write must both use user scope. Prefilling from the merged
  // `get()` would show the repository's committed endpoint, and accepting the
  // dialog would promote it into User Settings — permanently escaping the
  // approval gate through a dialog that looks like the user's own settings.
  // "Is this a first-time setup?" — asked of SecretStorage rather than of the
  // provider setting. Reading the setting used to answer it via the merged
  // value; switching that to user scope silently widened the condition, so an
  // upgrading user (whose provider sat in workspace scope) would newly get the
  // legacy slot overwritten too. The stored keys are the thing this actually
  // cares about.
  const hasStoredProviderKey = (
    await Promise.all(
      ['openai', 'anthropic'].map((name) => context.secrets.get(`${SECRET_API_KEY}.${name}`)),
    )
  ).some(Boolean);
  const provider = await vscode.window.showQuickPick(['openai', 'anthropic'], {
    title: 'FrontAgent provider',
    placeHolder: 'Choose LLM provider',
  });
  if (!provider) return;
  await config.update('provider', provider, vscode.ConfigurationTarget.Global);

  const model = await vscode.window.showInputBox({
    title: 'FrontAgent model',
    prompt: 'Model name, for example zai-org/GLM-4.6.',
    value: readScopedSetting(config, 'model').userValue ?? '',
  });
  if (model !== undefined) {
    await config.update('model', model.trim(), vscode.ConfigurationTarget.Global);
  }

  const baseUrl = await vscode.window.showInputBox({
    title: 'FrontAgent base URL',
    prompt:
      'OpenAI-compatible or Anthropic-compatible base URL, for example https://api.siliconflow.cn/v1.',
    value: readScopedSetting(config, 'baseUrl').userValue ?? '',
  });
  if (baseUrl !== undefined) {
    await config.update('baseUrl', baseUrl.trim(), vscode.ConfigurationTarget.Global);
  }

  const apiKey = await vscode.window.showInputBox({
    title: 'FrontAgent API key',
    prompt: 'Stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKey) {
    await context.secrets.store(`${SECRET_API_KEY}.${provider}`, apiKey);
    // Only seed the provider-agnostic slot on a genuine first configuration.
    if (!hasStoredProviderKey) {
      await context.secrets.store(SECRET_API_KEY, apiKey);
    }
  }

  vscode.window.showInformationMessage('FrontAgent configuration updated in User Settings.');
}
