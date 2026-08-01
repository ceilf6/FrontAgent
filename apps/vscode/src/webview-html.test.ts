import { describe, expect, it } from 'vitest';
import {
  getWebviewHtml,
  nonce,
  renderWebviewBaseStyles,
  renderWebviewBodySection,
  renderWebviewComposerStyles,
  renderWebviewConfigScript,
  renderWebviewContextScript,
  renderWebviewErrorScript,
  renderWebviewEventScript,
  renderWebviewHeaderStyles,
  renderWebviewMessageScript,
  renderWebviewMessageStyles,
  renderWebviewMotionStyles,
  renderWebviewScriptSection,
  renderWebviewStateScript,
  renderWebviewStyleSection,
} from './webview-html.js';

describe('VS Code webview HTML nonce handling', () => {
  it('generates base64url nonces from cryptographic bytes', () => {
    const values = Array.from({ length: 64 }, () => nonce());

    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it('injects matching CSP and element nonces into the webview HTML', () => {
    const html = getWebviewHtml({ cspSource: 'vscode-webview://frontagent.test' } as never);
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1];
    const styleNonce = html.match(/<style nonce="([^"]+)"/)?.[1];
    const scriptNonce = html.match(/<script nonce="([^"]+)"/)?.[1];

    expect(csp).toBeDefined();
    expect(styleNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(scriptNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(styleNonce).not.toBe(scriptNonce);
    expect(csp).toContain(`style-src vscode-webview://frontagent.test 'nonce-${styleNonce}'`);
    expect(csp).toContain(`script-src 'nonce-${scriptNonce}'`);
  });

  it('renders the style section through a focused renderer', () => {
    const html = getWebviewHtml({ cspSource: 'vscode-webview://frontagent.test' } as never);
    const styleNonce = html.match(/<style nonce="([^"]+)"/)?.[1];
    const styleSection = html.match(/ {2}<style nonce="[^"]+">[\s\S]*? {2}<\/style>/)?.[0];

    expect(styleNonce).toBeDefined();
    expect(styleSection).toBe(renderWebviewStyleSection(styleNonce ?? ''));
  });

  it('assembles the style section from focused CSS helpers', () => {
    const styleNonce = 'style-test-nonce';
    const section = renderWebviewStyleSection(styleNonce);
    const helpers = [
      renderWebviewBaseStyles(),
      renderWebviewHeaderStyles(),
      renderWebviewMessageStyles(),
      renderWebviewComposerStyles(),
      renderWebviewMotionStyles(),
    ];

    expect(section).toBe(`  <style nonce="${styleNonce}">
${helpers.join('\n')}
  </style>`);
    expect(section).toContain(':root {');
    expect(section).toContain('--accent: var(--vscode-button-background);');
    expect(section).toContain('.config-banner.ready {');
    expect(section).toContain('.messages {');
    expect(section).toContain('.live-dot {');
    expect(section).toContain('.composer-card:focus-within {');
    expect(section).toContain('#prompt {');
    expect(section).toContain('@media (prefers-reduced-motion: no-preference) {');
  });

  it('renders the script bootstrapping section through a focused renderer', () => {
    const html = getWebviewHtml({ cspSource: 'vscode-webview://frontagent.test' } as never);
    const scriptNonce = html.match(/<script nonce="([^"]+)"/)?.[1];
    const scriptSection = html.match(/ {2}<script nonce="[^"]+">[\s\S]*? {2}<\/script>/)?.[0];

    expect(scriptNonce).toBeDefined();
    expect(scriptSection).toBe(renderWebviewScriptSection(scriptNonce ?? ''));
  });

  it('assembles the script section from focused template helpers', () => {
    const scriptNonce = 'script-test-nonce';
    const section = renderWebviewScriptSection(scriptNonce);
    const helpers = [
      renderWebviewStateScript(),
      renderWebviewConfigScript(),
      renderWebviewContextScript(),
      renderWebviewMessageScript(),
      renderWebviewEventScript(),
      renderWebviewErrorScript(),
    ];

    expect(section).toBe(`  <script nonce="${scriptNonce}">
${helpers.join('\n')}

    vscode.postMessage({ type: 'ready' });
  </script>`);
    expect(section).toContain('acquireVsCodeApi()');
    expect(section).toContain("vscode.postMessage({ type: 'ready' });");
    expect(section).toContain("type: 'send'");
    expect(section).toContain("type: 'saveConfig'");
    expect(section).toContain("type: 'approve'");
    expect(section).toContain("type: 'reject'");
    expect(section).toContain("type: 'webviewError'");
    expect(section).toContain("$('composer').addEventListener('submit'");
    expect(section).toContain("$('contextFiles').addEventListener('click'");
    expect(section).toContain("window.addEventListener('message'");
    expect(section).toContain("window.addEventListener('error'");
    expect(section).toContain("window.addEventListener('unhandledrejection'");
    expect(section).toContain('data-remove-file');
    expect(section).toContain(`replace(/[&<>"']/g`);
  });

  it('prefills the Configure form from user scope, not the gated effective values', () => {
    const script = renderWebviewConfigScript();

    // The form saves to User Settings. Prefilling it from the effective values
    // would let one Save promote an approved workspace endpoint into the user's
    // global default, undoing the per-workspace binding of the approval.
    expect(script).toContain('const own = config.userScoped || {}');
    expect(script).toContain("$('configBaseUrl').value = own.baseUrl || ''");
    expect(script).toContain("$('configModel').value = own.model || ''");
    expect(script).toContain("$('configProvider').value = own.provider || ''");
    expect(script).not.toContain("$('configBaseUrl').value = config.baseUrl");

    // The effective value is still visible, as a placeholder, so an
    // env-configured user does not see an empty form next to a "ready" banner.
    expect(script).toContain("$('configBaseUrl').placeholder = config.baseUrl");
    expect(script).toContain("$('configModel').placeholder = config.model");

    // The trust copy is computed host-side and rendered verbatim. Duplicating
    // the wording here is how the banner and the run-failure message drifted
    // apart before, so the script must not carry its own branches.
    expect(script).toContain('(config.endpointTrust || {}).notice');
    expect(script).not.toContain('trust.declinedThisSession');
    expect(script).not.toContain('Reset Workspace Endpoint Approval');

    // The notice is appended, not substituted: replacing "Configure now" left
    // an unconfigured user with no recovery path visible anywhere.
    expect(script).toContain('const baseCopy = config.configured');
    expect(script).toContain('Configure now or use the command palette.');
    expect(script).not.toContain('trustNotice ? trustNotice : baseCopy');
  });

  it('keeps Send enabled while an endpoint approval is pending', () => {
    const script = renderWebviewStateScript();

    // Sending is the only path that raises the confirmation modal. Gating it on
    // `configured` deadlocks every user upgrading from the version whose
    // Configure wrote to Workspace scope: their endpoint is workspace-supplied,
    // so `configured` is false until they approve, and they cannot approve.
    expect(script).toContain(
      'next.isRunning || (!next.configStatus.configured && !awaitingEndpointApproval)',
    );
    // ...but only while a prompt is actually coming. After a decline no modal
    // appears, so leaving Send enabled would just produce runs that fail.
    expect(script).toContain('trust.requiresApproval && !trust.declinedThisSession');
  });

  it('emits a webview script that actually parses', () => {
    // These renderers build JS inside template literals, so an unescaped
    // backtick in a comment silently terminates the string and ships a webview
    // that fails to load. Substring assertions do not reliably catch that.
    const html = getWebviewHtml({ cspSource: 'vscode-webview://frontagent.test' } as never);
    const body = html.match(/ {2}<script nonce="[^"]+">\n([\s\S]*?)\n {2}<\/script>/)?.[1];

    expect(body).toBeDefined();
    // Parses without executing; a syntax error here throws.
    expect(() => new Function(body ?? '')).not.toThrow();
  });

  it('renders the body markup through a focused renderer', () => {
    const html = getWebviewHtml({ cspSource: 'vscode-webview://frontagent.test' } as never);
    const bodySection = html.match(/<body>\n([\s\S]*?)\n\n {2}<script nonce="/)?.[1];

    expect(bodySection).toBe(renderWebviewBodySection());
  });
});
