import { createHash } from 'node:crypto';

/**
 * Endpoint selection is a trust boundary: `provider`, `model`, and `baseUrl`
 * decide which host receives the user's API key and the LLM message context.
 * A repository can commit those keys in `.vscode/settings.json`, and folder
 * configuration outranks User Settings, so the merged `get()` value alone
 * cannot tell us whether the endpoint came from the user or from the checkout.
 *
 * This module is intentionally free of `vscode` imports so the precedence
 * rules stay unit-testable without an Extension Host.
 */

export type EndpointField = 'provider' | 'model' | 'baseUrl';

export const ENDPOINT_FIELDS: readonly EndpointField[] = ['provider', 'model', 'baseUrl'];

/** One setting split by the scope that supplied it. */
export interface ScopedSetting {
  /** User, machine, or remote scope. A checked-out repository cannot write these. */
  userValue?: string;
  /** Workspace or workspace-folder scope, i.e. repository-writable. */
  workspaceValue?: string;
}

export type ScopedEndpointSettings = Record<EndpointField, ScopedSetting>;

export interface WorkspaceEndpointOverride {
  field: EndpointField;
  workspaceValue: string;
  userValue?: string;
}

/** The endpoint the workspace is proposing, plus the digest approval binds to. */
export interface PendingEndpoint {
  provider?: string;
  model?: string;
  baseUrl?: string;
  fingerprint: string;
}

export interface EndpointTrustStatus {
  /** Workspace values exist, differ from user scope, and are not approved yet. */
  requiresApproval: boolean;
  /** Workspace values exist but the workspace is untrusted, so they can never apply. */
  blockedByWorkspaceTrust: boolean;
  overrides: WorkspaceEndpointOverride[];
  pending?: PendingEndpoint;
  /**
   * The user dismissed this workspace's endpoint earlier in the session, so no
   * further prompt will appear and the UI must offer the reset command instead
   * of telling them to approve.
   *
   * Per workspace, not per endpoint — see `EndpointTrustInput.declinedForWorkspace`
   * for why keying on the digest would hand a repository an approval-fatigue
   * lever. Session state, but supplied as resolver input rather than patched on
   * afterwards: this type crosses the webview bridge, and a shape that is only
   * valid after a second layer edits it is easy to consume wrongly.
   */
  declinedThisSession: boolean;
  /**
   * One sentence describing the current trust state, computed host-side by
   * `describeEndpointTrustNotice` so the sidebar and the run-failure message
   * cannot drift apart. Undefined when the workspace proposes nothing.
   */
  notice?: string;
}

export interface EndpointTrustInput {
  settings: ScopedEndpointSettings;
  /** `vscode.workspace.isTrusted`. */
  workspaceTrusted: boolean;
  /** Fingerprint the user previously approved for this workspace folder. */
  approvedFingerprint?: string;
  /**
   * The user dismissed this workspace's endpoint earlier in the session.
   *
   * Deliberately per-workspace rather than per-fingerprint: keying on the
   * digest would let a repository re-raise the modal on every run just by
   * mutating one character of `baseUrl`, which is the approval fatigue this
   * gate exists to prevent. The cost is that a repository correcting a genuine
   * mistake will not re-prompt on its own — the sidebar and the failure message
   * both name the reset command, so the way back stays visible.
   *
   * Note that this does not clear a stored approval, so it can coexist with an
   * approved fingerprint; see `describeEndpointTrustNotice`.
   */
  declinedForWorkspace?: boolean;
  /**
   * Endpoint values the environment would supply (`PROVIDER`, `MODEL`,
   * `BASE_URL`, …). Env is user-controlled, so a workspace value identical to
   * it changes nothing and must not raise a prompt — approving and declining
   * would produce the same request. Used only to decide what counts as an
   * override, never to widen what may reach the runtime.
   */
  envFallback?: Partial<Record<EndpointField, string>>;
}

export interface EndpointTrustDecision extends EndpointTrustStatus {
  /** The values that may be handed to the runtime right now. */
  effective: Record<EndpointField, string | undefined>;
}

export function emptyEndpointTrustStatus(): EndpointTrustStatus {
  return {
    requiresApproval: false,
    blockedByWorkspaceTrust: false,
    declinedThisSession: false,
    overrides: [],
  };
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Canonical form used for comparison and fingerprinting. Two spellings of the
 * same endpoint must produce the same digest, otherwise a trailing slash would
 * silently invalidate an existing approval.
 */
export function normalizeBaseUrl(value: string | undefined): string | undefined {
  const raw = trimToUndefined(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    // Everything except the trailing slash is significant. `URL.host` omits
    // userinfo and `hash` is easy to forget, but both are handed to the SDK
    // verbatim, so dropping them here would let a repository edit an approved
    // endpoint — adding basic-auth credentials, say — without re-triggering the
    // prompt, because the digest would not change.
    const userinfo = url.username || url.password ? `${url.username}:${url.password}@` : '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${userinfo}${url.host}${path}${url.search}${url.hash}`;
  } catch {
    // Not a URL: only the trailing slash is safely normalizable. The parsed
    // branch lowercases scheme and host but preserves path case, so blanket
    // lowercasing here would treat two spellings as equal that the parsed
    // branch would not — and equality is what suppresses the prompt.
    return raw.replace(/\/+$/, '');
  }
}

/** Host shown in the confirmation prompt, so the user sees where the key goes. */
export function endpointHost(value: string | undefined): string | undefined {
  const raw = trimToUndefined(value);
  if (!raw) return undefined;
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

function canonicalField(field: EndpointField, value: string | undefined): string | undefined {
  const raw = trimToUndefined(value);
  if (!raw) return undefined;
  if (field === 'baseUrl') return normalizeBaseUrl(raw);
  if (field === 'provider') return raw.toLowerCase();
  return raw;
}

export function fingerprintEndpoint(endpoint: {
  provider?: string;
  model?: string;
  baseUrl?: string;
}): string {
  const canonical = ENDPOINT_FIELDS.map(
    (field) => canonicalField(field, endpoint[field]) ?? '',
  ).join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Decides which endpoint values may reach the runtime.
 *
 * Workspace values only win when they are already approved for this exact
 * effective endpoint in a trusted workspace. In every other case the caller
 * falls back to user scope, which may leave the configuration incomplete —
 * that is the intended outcome, since sending nothing is safer than sending
 * the credential to a repository-chosen host.
 */
export function resolveEndpointTrust(input: EndpointTrustInput): EndpointTrustDecision {
  const overrides: WorkspaceEndpointOverride[] = [];
  const userScoped: Record<EndpointField, string | undefined> = {
    provider: undefined,
    model: undefined,
    baseUrl: undefined,
  };
  const candidate: Record<EndpointField, string | undefined> = {
    provider: undefined,
    model: undefined,
    baseUrl: undefined,
  };

  for (const field of ENDPOINT_FIELDS) {
    const setting = input.settings[field] ?? {};
    const userValue = trimToUndefined(setting.userValue);
    const workspaceValue = trimToUndefined(setting.workspaceValue);
    userScoped[field] = userValue;
    // Compared against the environment too when the user has no setting of
    // their own: a workspace value equal to what env already supplies is not an
    // override, and prompting for it would be pure noise — approving and
    // declining produce the same request.
    const envValue = trimToUndefined(input.envFallback?.[field]);
    const ownValue = userValue ?? envValue;
    const matchesOwnValue =
      workspaceValue !== undefined &&
      canonicalField(field, workspaceValue) === canonicalField(field, ownValue);

    if (workspaceValue !== undefined && !matchesOwnValue) {
      overrides.push({ field, workspaceValue, userValue: ownValue });
    }

    // A workspace value that merely matches is never passed through — the
    // user's own value is, or nothing at all.
    //
    // Matching is canonical, so the two can still differ in spelling: a
    // repository writing `"provider": "OpenAI"` is not an override, but
    // forwarding that spelling breaks the `frontagent.apiKey.<provider>` secret
    // lookup, which stores lowercase. And when the match came from the
    // environment rather than a user setting, forwarding it would let the
    // workspace copy outrank `<PROVIDER>_BASE_URL`, which `envFallback` cannot
    // see; leaving the field unset lets that precedence apply untouched.
    candidate[field] = matchesOwnValue ? userValue : (workspaceValue ?? userValue);
  }

  if (overrides.length === 0) {
    return { ...emptyEndpointTrustStatus(), effective: candidate };
  }

  const pending: PendingEndpoint = { ...candidate, fingerprint: fingerprintEndpoint(candidate) };
  const declinedThisSession = input.declinedForWorkspace ?? false;

  const blockedByWorkspaceTrust = !input.workspaceTrusted;
  const approved = input.workspaceTrusted && input.approvedFingerprint === pending.fingerprint;
  const status: EndpointTrustStatus = {
    overrides,
    pending,
    declinedThisSession,
    blockedByWorkspaceTrust,
    requiresApproval: !blockedByWorkspaceTrust && !approved,
  };

  // Fully formed here, notice included, so no caller has to complete the shape.
  return {
    ...status,
    notice: describeEndpointTrustNotice(status),
    effective: approved ? candidate : userScoped,
  };
}

export const ENDPOINT_CHANGE_SUMMARY =
  'FrontAgent: this workspace selects a different LLM endpoint';
export const MODEL_ONLY_CHANGE_SUMMARY = 'FrontAgent: this workspace overrides your model settings';

/** Longest repository-supplied value rendered in the dialog before elision. */
const DIALOG_VALUE_MAX_LENGTH = 120;

const RESET_COMMAND = 'FrontAgent: Reset Workspace Endpoint Approval';

/**
 * The single source for every user-facing sentence about workspace endpoint
 * trust. The sidebar banner and the run-failure message both render this, so
 * they cannot describe the same state differently — and, more importantly, an
 * approved workspace endpoint stays visible instead of the UI settling back to
 * "ready with your settings" while a repository-chosen host is in use.
 */
export function describeEndpointTrustNotice(trust: EndpointTrustStatus): string | undefined {
  if (trust.overrides.length === 0) return undefined;
  if (trust.blockedByWorkspaceTrust) {
    return 'This workspace sets FrontAgent endpoint values, but they are ignored because the workspace is not trusted.';
  }
  // Only when the decline is actually what is holding the values back. A
  // session decline does not clear a stored approval, so a repository that
  // moves off an approved endpoint and back again lands here with both flags
  // set — and claiming "using your own settings" while the approved workspace
  // endpoint is in effect is the one thing this banner must never say.
  if (trust.declinedThisSession && trust.requiresApproval) {
    return `You declined this workspace endpoint, so FrontAgent is using your own settings. Run "${RESET_COMMAND}" to be asked again.`;
  }
  if (trust.requiresApproval) {
    return 'This workspace proposes a different LLM endpoint. Send a message to review and approve it before it is used.';
  }
  const host = sanitizeForDialog(endpointHost(trust.pending?.baseUrl));
  // Approved. The approval persists across sessions, so this is the only
  // standing signal that requests are leaving for a repository-chosen host.
  return host
    ? `Using this workspace's approved endpoint (${host}). Run "${RESET_COMMAND}" to revoke it.`
    : `Using this workspace's approved endpoint. Run "${RESET_COMMAND}" to revoke it.`;
}

/**
 * `model` and `baseUrl` are free-form strings a repository controls, and the
 * modal `detail` is plain text that preserves newlines. Interpolating them raw
 * would let a repository inject its own sentences into the security dialog —
 * or push the real warning out of view with blank lines. The whole value of
 * this gate rests on that dialog being readable and truthful, so every
 * untrusted value is flattened to a single bounded line before it goes in.
 */
function sanitizeForDialog(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const flattened = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!flattened) return undefined;
  if (flattened.length <= DIALOG_VALUE_MAX_LENGTH) return flattened;
  // Elide the middle, never the tail. A hostname can be 253 characters, and the
  // registrable domain is at the END — so head truncation would let a
  // repository bury `evil.test` behind a long `api.siliconflow.cn.<padding>`
  // prefix and have the dialog vouch for a host that is not the destination.
  // That would defeat the reason this function exists.
  const half = Math.floor((DIALOG_VALUE_MAX_LENGTH - 1) / 2);
  return `${flattened.slice(0, half)}…${flattened.slice(-half)}`;
}

/** Split out of `describeWorkspaceEndpoint`: nested ternaries here were unreadable. */
function describeConsequence(hostChanged: boolean, host: string | undefined): string {
  if (hostChanged) {
    return host
      ? `Approving sends your API key and task context to ${host}.`
      : 'Approving sends your API key and task context to the workspace endpoint.';
  }
  const where = host ? ` (${host})` : '';
  return `Your endpoint host${where} is unchanged. Approving lets this repository choose the provider or model used for your requests.`;
}

/**
 * `provider` selects which stored credential is sent — the key is looked up as
 * `frontagent.apiKey.<provider>`, falling back to the legacy secret, the
 * user-scope `apiKey`, then `API_KEY`. Which of those applies decides whether
 * approving really switches keys, so the dialog states only what is known.
 */
function describeCredentialNote(
  providerName: string | undefined,
  hasStoredKey: boolean | undefined,
): string {
  if (!providerName) return '';
  if (hasStoredKey === true) {
    return ` FrontAgent will use the API key you stored for ${providerName}.`;
  }
  if (hasStoredKey === false) {
    return ` You have no API key stored for ${providerName}, so FrontAgent will fall back to your existing credential.`;
  }
  return ` FrontAgent will look for an API key stored for ${providerName} and fall back to your existing credential if there is none.`;
}

/**
 * Copy for the modal shown before the first request to a workspace endpoint.
 *
 * Redirecting the destination host and pinning a model are different stakes,
 * so they get different wording. Claiming "your API key goes to <host>" when the
 * host is unchanged trains users to click through the dialog that matters.
 */
export function describeWorkspaceEndpoint(
  trust: EndpointTrustStatus,
  /**
   * Whether SecretStorage holds a key for the provider the workspace proposes.
   * Without it the dialog cannot say which credential is sent: the resolution
   * chain falls back to the legacy secret, the user-scope `apiKey`, or
   * `API_KEY`, so "a different key will be used" may be exactly wrong.
   */
  hasStoredKeyForWorkspaceProvider?: boolean,
): {
  summary: string;
  detail: string;
} {
  const host = sanitizeForDialog(endpointHost(trust.pending?.baseUrl));
  const providerOverride = trust.overrides.find((override) => override.field === 'provider');
  // "Your host is unchanged" is only safe to assert when the destination is
  // both known and untouched. `provider` selects the env base URL
  // (`OPENAI_BASE_URL` vs `ANTHROPIC_BASE_URL`) as well as the stored key, so
  // for an env-configured user flipping it moves the destination; and with no
  // resolved `baseUrl` there is no host to vouch for. Both cases fall back to
  // the stronger wording rather than making a claim that may be false.
  const hostChanged =
    trust.overrides.some((override) => override.field === 'baseUrl') ||
    providerOverride !== undefined ||
    host === undefined;
  const lines = trust.overrides.map((override) => {
    const workspaceValue = sanitizeForDialog(override.workspaceValue);
    const userValue = sanitizeForDialog(override.userValue);
    // "You have no value" would be a lie for anyone configured through
    // PROVIDER/MODEL/BASE_URL: scope splitting only sees `inspect()`, but the
    // env fallback still applies once the gate withholds the workspace value.
    // Overstating that the user has nothing nudges them toward approving.
    return userValue
      ? `${override.field}: ${workspaceValue} (your setting: ${userValue})`
      : `${override.field}: ${workspaceValue} (no user-level setting; FrontAgent may fall back to your environment)`;
  });
  const consequence = describeConsequence(hostChanged, host);
  // `provider` also selects which stored credential is sent: the key is looked
  // up as `frontagent.apiKey.<provider>` / `<PROVIDER>_API_KEY`. Saying only
  // "the provider or model" hides a credential switch.
  const credentialNote = describeCredentialNote(
    providerOverride ? sanitizeForDialog(providerOverride.workspaceValue) : undefined,
    hasStoredKeyForWorkspaceProvider,
  );
  const detail = [
    hostChanged
      ? 'This workspace overrides FrontAgent endpoint settings:'
      : 'This workspace overrides FrontAgent model settings:',
    ...lines.map((line) => `  • ${line}`),
    '',
    `${consequence}${credentialNote}`,
    'Approve only if you trust this repository. Cancel to use your own settings instead.',
  ].join('\n');
  return {
    summary: hostChanged ? ENDPOINT_CHANGE_SUMMARY : MODEL_ONLY_CHANGE_SUMMARY,
    detail,
  };
}
