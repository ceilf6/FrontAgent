import { describe, expect, it } from 'vitest';
import {
  describeWorkspaceEndpoint,
  ENDPOINT_CHANGE_SUMMARY,
  fingerprintEndpoint,
  MODEL_ONLY_CHANGE_SUMMARY,
  normalizeBaseUrl,
  resolveEndpointTrust,
  type ScopedEndpointSettings,
} from './endpoint-trust.js';

const USER_ENDPOINT = 'https://api.siliconflow.cn/v1';
const ATTACKER_ENDPOINT = 'http://127.0.0.1:4319/v1';

function settings(overrides: Partial<ScopedEndpointSettings> = {}): ScopedEndpointSettings {
  return {
    provider: {},
    model: {},
    baseUrl: {},
    ...overrides,
  };
}

describe('resolveEndpointTrust', () => {
  it('withholds a repository-supplied baseUrl until it is approved', () => {
    const decision = resolveEndpointTrust({
      settings: settings({
        provider: { userValue: 'openai', workspaceValue: 'openai' },
        model: { userValue: 'zai-org/GLM-4.6', workspaceValue: 'poc-model' },
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: ATTACKER_ENDPOINT },
      }),
      workspaceTrusted: true,
    });

    expect(decision.requiresApproval).toBe(true);
    expect(decision.effective.baseUrl).toBe(USER_ENDPOINT);
    expect(decision.effective.model).toBe('zai-org/GLM-4.6');
    expect(decision.overrides.map((override) => override.field)).toEqual(['model', 'baseUrl']);
    expect(decision.pending?.baseUrl).toBe(ATTACKER_ENDPOINT);
  });

  it('leaves the endpoint unresolved when only the repository supplies it', () => {
    const decision = resolveEndpointTrust({
      settings: settings({
        provider: { workspaceValue: 'openai' },
        model: { workspaceValue: 'poc-model' },
        baseUrl: { workspaceValue: ATTACKER_ENDPOINT },
      }),
      workspaceTrusted: true,
    });

    expect(decision.requiresApproval).toBe(true);
    expect(decision.effective).toEqual({
      provider: undefined,
      model: undefined,
      baseUrl: undefined,
    });
  });

  it('applies workspace values once the exact fingerprint is approved', () => {
    const input = {
      settings: settings({
        provider: { userValue: 'openai', workspaceValue: 'openai' },
        model: { userValue: 'zai-org/GLM-4.6', workspaceValue: 'poc-model' },
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: ATTACKER_ENDPOINT },
      }),
      workspaceTrusted: true,
    };
    const pending = resolveEndpointTrust(input).pending;
    if (!pending) throw new Error('expected a pending endpoint');

    const approved = resolveEndpointTrust({ ...input, approvedFingerprint: pending.fingerprint });

    expect(approved.requiresApproval).toBe(false);
    expect(approved.effective.baseUrl).toBe(ATTACKER_ENDPOINT);
    expect(approved.effective.model).toBe('poc-model');
  });

  it('re-asks when the approved workspace endpoint later changes', () => {
    const first = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: 'https://a.test/v1' },
      }),
      workspaceTrusted: true,
    });
    const second = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: 'https://b.test/v1' },
      }),
      workspaceTrusted: true,
      approvedFingerprint: first.pending?.fingerprint,
    });

    expect(second.requiresApproval).toBe(true);
    expect(second.effective.baseUrl).toBe(USER_ENDPOINT);
  });

  it('never applies workspace endpoint values in an untrusted workspace', () => {
    const decision = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: ATTACKER_ENDPOINT },
      }),
      workspaceTrusted: false,
      // Even a stored approval must not resurrect the value while untrusted.
      approvedFingerprint: fingerprintEndpoint({ baseUrl: ATTACKER_ENDPOINT }),
    });

    expect(decision.blockedByWorkspaceTrust).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.effective.baseUrl).toBe(USER_ENDPOINT);
  });

  it('does not prompt when the workspace merely repeats the user endpoint', () => {
    const decision = resolveEndpointTrust({
      settings: settings({
        provider: { userValue: 'openai', workspaceValue: 'OpenAI' },
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: `${USER_ENDPOINT}/` },
      }),
      workspaceTrusted: true,
    });

    expect(decision.requiresApproval).toBe(false);
    expect(decision.overrides).toEqual([]);
    // The user's own spelling wins, not the workspace's. Matching is canonical,
    // so a repository can differ in case or trailing slash without it counting
    // as an override — and forwarding `"OpenAI"` would then miss the
    // `frontagent.apiKey.openai` secret and report a bogus "Missing: apiKey".
    expect(decision.effective.baseUrl).toBe(USER_ENDPOINT);
    expect(decision.effective.provider).toBe('openai');
  });

  it('returns a fully formed status, so no caller has to complete the shape', () => {
    // This type crosses the webview bridge; a shape only valid after a second
    // layer patches it is easy to consume wrongly.
    const declined = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: ATTACKER_ENDPOINT },
      }),
      workspaceTrusted: true,
    });
    const withDecline = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: ATTACKER_ENDPOINT },
      }),
      workspaceTrusted: true,
      declinedForWorkspace: true,
    });

    expect(declined.declinedThisSession).toBe(false);
    expect(declined.notice).toContain('approve it');
    expect(withDecline.declinedThisSession).toBe(true);
    expect(withDecline.notice).toContain('Reset Workspace Endpoint Approval');
    expect(withDecline.effective.baseUrl).toBe(USER_ENDPOINT);
  });

  it('never claims your own settings are in use while an approved endpoint is', () => {
    // Reachable: approve E1, repository moves to E2, user declines (which does
    // not clear the stored approval), repository moves back to E1. Both flags
    // are then set and the workspace endpoint is genuinely in effect.
    const approved = fingerprintEndpoint({ baseUrl: ATTACKER_ENDPOINT });
    const decision = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: ATTACKER_ENDPOINT },
      }),
      workspaceTrusted: true,
      approvedFingerprint: approved,
      declinedForWorkspace: true,
    });

    expect(decision.effective.baseUrl).toBe(ATTACKER_ENDPOINT);
    expect(decision.notice).toContain('approved endpoint');
    expect(decision.notice).not.toContain('using your own settings');
  });

  it('does not prompt for a workspace value the environment already supplies', () => {
    // Approving and declining would produce an identical request, so the modal
    // would be pure noise — the approval fatigue this gate exists to avoid.
    const decision = resolveEndpointTrust({
      settings: settings({
        provider: { workspaceValue: 'openai' },
        baseUrl: { workspaceValue: USER_ENDPOINT },
      }),
      workspaceTrusted: true,
      envFallback: { provider: 'openai', baseUrl: `${USER_ENDPOINT}/` },
    });

    expect(decision.overrides).toEqual([]);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.notice).toBeUndefined();
  });

  it('does not let a workspace value demote a higher-priority env variable', () => {
    // envFallback only knows the unqualified BASE_URL, but the downstream
    // resolver prefers <PROVIDER>_BASE_URL over it. A workspace value equal to
    // BASE_URL is not an override, yet passing it through would outrank
    // OPENAI_BASE_URL and silently move the destination.
    const decision = resolveEndpointTrust({
      settings: settings({ baseUrl: { workspaceValue: 'https://b.test/v1' } }),
      workspaceTrusted: true,
      envFallback: { baseUrl: 'https://b.test/v1' },
    });

    expect(decision.requiresApproval).toBe(false);
    // Unset, so the downstream env precedence still picks OPENAI_BASE_URL.
    expect(decision.effective.baseUrl).toBeUndefined();
  });

  it('still passes through a workspace value identical to the user setting', () => {
    const decision = resolveEndpointTrust({
      settings: settings({ baseUrl: { userValue: USER_ENDPOINT, workspaceValue: USER_ENDPOINT } }),
      workspaceTrusted: true,
    });

    expect(decision.requiresApproval).toBe(false);
    expect(decision.effective.baseUrl).toBe(USER_ENDPOINT);
  });

  it('still prompts when the workspace differs from the environment', () => {
    const decision = resolveEndpointTrust({
      settings: settings({ baseUrl: { workspaceValue: ATTACKER_ENDPOINT } }),
      workspaceTrusted: true,
      envFallback: { baseUrl: USER_ENDPOINT },
    });

    expect(decision.requiresApproval).toBe(true);
    // The dialog can now name what the user would otherwise have used.
    expect(decision.overrides[0]?.userValue).toBe(USER_ENDPOINT);
  });

  it('passes through user-only configuration untouched', () => {
    const decision = resolveEndpointTrust({
      settings: settings({
        provider: { userValue: 'openai' },
        model: { userValue: 'zai-org/GLM-4.6' },
        baseUrl: { userValue: USER_ENDPOINT },
      }),
      workspaceTrusted: true,
    });

    expect(decision.requiresApproval).toBe(false);
    expect(decision.blockedByWorkspaceTrust).toBe(false);
    expect(decision.effective).toEqual({
      provider: 'openai',
      model: 'zai-org/GLM-4.6',
      baseUrl: USER_ENDPOINT,
    });
  });
});

describe('fingerprintEndpoint', () => {
  it('ignores trailing-slash and case differences that do not change the destination', () => {
    expect(fingerprintEndpoint({ provider: 'openai', baseUrl: 'https://Api.Test/v1/' })).toBe(
      fingerprintEndpoint({ provider: 'OpenAI', baseUrl: 'https://api.test/v1' }),
    );
  });

  it('changes when the destination host changes', () => {
    expect(fingerprintEndpoint({ baseUrl: 'https://api.test/v1' })).not.toBe(
      fingerprintEndpoint({ baseUrl: 'https://evil.test/v1' }),
    );
  });

  it('re-asks when credentials or a fragment are grafted onto an approved URL', () => {
    // `URL.host` omits userinfo and `hash` is dropped by default, but both are
    // passed to the SDK verbatim — so neither may be invisible to the digest.
    const approved = fingerprintEndpoint({ baseUrl: 'https://h.test/v1' });

    expect(fingerprintEndpoint({ baseUrl: 'https://a:b@h.test/v1' })).not.toBe(approved);
    expect(fingerprintEndpoint({ baseUrl: 'https://h.test/v1#x' })).not.toBe(approved);
    // Trailing-slash tolerance must survive the stricter canonical form.
    expect(fingerprintEndpoint({ baseUrl: 'https://h.test/v1/' })).toBe(approved);
  });

  it('covers the effective endpoint, so changing the user value re-asks', () => {
    // The fingerprint is taken over what would actually be sent, not just the
    // workspace-supplied fields. Editing your own baseUrl therefore invalidates
    // a stored approval — safe direction, pinned here so it stays deliberate.
    const workspacePinsModelOnly = (userBaseUrl: string) =>
      resolveEndpointTrust({
        settings: settings({
          baseUrl: { userValue: userBaseUrl },
          model: { userValue: 'mine', workspaceValue: 'theirs' },
        }),
        workspaceTrusted: true,
      });

    const before = workspacePinsModelOnly(USER_ENDPOINT);
    const after = workspacePinsModelOnly('https://moved.test/v1');

    expect(before.pending?.fingerprint).not.toBe(after.pending?.fingerprint);
    expect(
      resolveEndpointTrust({
        settings: settings({
          baseUrl: { userValue: 'https://moved.test/v1' },
          model: { userValue: 'mine', workspaceValue: 'theirs' },
        }),
        workspaceTrusted: true,
        approvedFingerprint: before.pending?.fingerprint,
      }).requiresApproval,
    ).toBe(true);
  });
});

describe('normalizeBaseUrl', () => {
  it('returns undefined for blank input and keeps unparsable values comparable', () => {
    expect(normalizeBaseUrl('   ')).toBeUndefined();
    // Only the trailing slash is normalized. The parsed branch preserves path
    // case, so lowercasing here would call two spellings equal that the parsed
    // branch would not — and equality is what suppresses the prompt.
    expect(normalizeBaseUrl('Not A URL/')).toBe('Not A URL');
    expect(normalizeBaseUrl('Not A URL')).not.toBe(normalizeBaseUrl('not a url'));
    // Path case is significant on the parsed branch too.
    expect(normalizeBaseUrl('https://h.test/V1')).not.toBe(normalizeBaseUrl('https://h.test/v1'));
  });
});

describe('describeWorkspaceEndpoint', () => {
  it('names the destination host so the user can judge the request', () => {
    const decision = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: 'https://evil.test/v1' },
      }),
      workspaceTrusted: true,
    });

    const { summary, detail } = describeWorkspaceEndpoint(decision);

    expect(summary).toBe(ENDPOINT_CHANGE_SUMMARY);
    expect(detail).toContain('evil.test');
    expect(detail).toContain(USER_ENDPOINT);
    expect(detail).toContain('API key');
  });

  it('flattens repository-controlled values so they cannot forge dialog text', () => {
    const injected =
      'gpt-4\n\nThis workspace uses your own endpoint. No credentials are shared.\n\n\n\n\n\n\n\n';
    const decision = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: 'https://evil.test/v1' },
        model: { userValue: 'zai-org/GLM-4.6', workspaceValue: injected },
      }),
      workspaceTrusted: true,
    });

    const { detail } = describeWorkspaceEndpoint(decision);

    // One line per override plus the fixed frame — a repository must not be
    // able to add lines, or to push the real warning out of the visible area.
    expect(detail.split('\n')).toHaveLength(4 + decision.overrides.length);
    expect(detail).not.toContain('No credentials are shared.\n');
    expect(detail).toContain('Approving sends your API key and task context to evil.test.');
  });

  it('keeps the registrable domain visible when the host is over-long', () => {
    // DNS allows 253 characters. Head truncation would let a repository bury
    // the real domain behind a legitimate-looking prefix and have the dialog
    // vouch for a host that is not where the credential goes.
    const host = `api.siliconflow.cn.${'a'.repeat(150)}.evil.test`;
    const decision = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: `https://${host}/v1` },
      }),
      workspaceTrusted: true,
    });

    const { detail } = describeWorkspaceEndpoint(decision);

    expect(detail).toContain('evil.test');
    expect(detail).toContain('…');
  });

  it('truncates an over-long repository value instead of flooding the dialog', () => {
    const decision = resolveEndpointTrust({
      settings: settings({ model: { userValue: 'small', workspaceValue: 'x'.repeat(5000) } }),
      workspaceTrusted: true,
    });

    const { detail } = describeWorkspaceEndpoint(decision);

    expect(detail).toContain('…');
    expect(detail.length).toBeLessThan(600);
  });

  it('does not tell an env-configured user they have no settings of their own', () => {
    // Scope splitting only sees `inspect()`, so PROVIDER/MODEL/BASE_URL users
    // look empty here — but the env fallback still applies once the gate
    // withholds the workspace value. Claiming they have nothing pushes them
    // toward approving the repository's endpoint.
    const decision = resolveEndpointTrust({
      settings: settings({ baseUrl: { workspaceValue: 'https://evil.test/v1' } }),
      workspaceTrusted: true,
    });

    const { detail } = describeWorkspaceEndpoint(decision);

    expect(detail).not.toContain('you have no user-level value');
    expect(detail).toContain('may fall back to your environment');
  });

  it('treats a provider override as a destination change, not a model tweak', () => {
    // `provider` selects the stored key (`frontagent.apiKey.<provider>`) *and*
    // which env base URL applies (`OPENAI_BASE_URL` vs `ANTHROPIC_BASE_URL`),
    // so asserting the host is unchanged can be false for an env-configured
    // user — and the credential switches regardless.
    const decision = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: USER_ENDPOINT },
        provider: { userValue: 'openai', workspaceValue: 'anthropic' },
      }),
      workspaceTrusted: true,
    });

    const { summary, detail } = describeWorkspaceEndpoint(decision);

    expect(summary).toBe(ENDPOINT_CHANGE_SUMMARY);
    expect(detail).not.toContain('is unchanged');
    expect(detail).toContain('anthropic');
  });

  it('does not promise a different key when none is stored for that provider', () => {
    // The chain is providerApiKey ?? legacyApiKey ?? settingsApiKey ?? env, so
    // with no key for the proposed provider it is the user's *current*
    // credential that goes to the repository-chosen host. Saying otherwise
    // reassures the user about the one thing they should be weighing.
    const decision = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: ATTACKER_ENDPOINT },
        provider: { userValue: 'openai', workspaceValue: 'anthropic' },
      }),
      workspaceTrusted: true,
    });

    const withoutKey = describeWorkspaceEndpoint(decision, false).detail;
    const withKey = describeWorkspaceEndpoint(decision, true).detail;

    expect(withoutKey).toContain('fall back to your existing credential');
    expect(withoutKey).not.toContain('instead of your current one');
    expect(withKey).toContain('use the API key you stored for anthropic');
  });

  it('does not vouch for a host it cannot resolve', () => {
    // No baseUrl anywhere: the destination comes from the environment, so
    // there is no host to name and none to promise is unchanged.
    const decision = resolveEndpointTrust({
      settings: settings({ model: { userValue: 'mine', workspaceValue: 'theirs' } }),
      workspaceTrusted: true,
    });

    const { summary, detail } = describeWorkspaceEndpoint(decision);

    expect(summary).toBe(ENDPOINT_CHANGE_SUMMARY);
    expect(detail).not.toContain('is unchanged');
  });

  it('does not claim the credential moves when only the model is pinned', () => {
    const decision = resolveEndpointTrust({
      settings: settings({
        baseUrl: { userValue: USER_ENDPOINT, workspaceValue: USER_ENDPOINT },
        model: { userValue: 'zai-org/GLM-4.6', workspaceValue: 'poc-model' },
      }),
      workspaceTrusted: true,
    });

    const { summary, detail } = describeWorkspaceEndpoint(decision);

    // Overstating the stakes here trains users to click through the dialog
    // that does redirect their key.
    expect(summary).toBe(MODEL_ONLY_CHANGE_SUMMARY);
    expect(detail).not.toContain('API key');
    expect(detail).toContain('is unchanged');
    expect(detail).toContain('poc-model');
  });
});
