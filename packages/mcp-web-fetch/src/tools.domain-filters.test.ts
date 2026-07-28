import { describe, expect, it } from 'vitest';
import { handleWebFetchTool, webFetchSchema } from './tools.js';

describe('mcp-web-fetch domain filters (no network)', () => {
  it('exposes allowed_domains and blocked_domains in the web_fetch schema', () => {
    const props = webFetchSchema.inputSchema.properties as Record<string, unknown>;
    expect(props.allowed_domains).toBeDefined();
    expect((props.allowed_domains as { type: string }).type).toBe('array');
    expect(props.blocked_domains).toBeDefined();
    expect((props.blocked_domains as { type: string }).type).toBe('array');
  });

  it('blocked_domains rejects the listed host (exact match)', async () => {
    const result = await handleWebFetchTool('web_fetch', {
      url: 'https://example.com/',
      blocked_domains: ['example.com'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/denied/i);
  });

  it('allowed_domains rejects hosts not in the allow list', async () => {
    const result = await handleWebFetchTool('web_fetch', {
      url: 'https://example.com/',
      allowed_domains: ['docs.example.com'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in allow list/i);
  });

  it('empty arrays disable the filters instead of denying all (SSRF guard still applies)', async () => {
    const result = await handleWebFetchTool('web_fetch', {
      url: 'http://127.0.0.1/',
      allowed_domains: [],
      blocked_domains: [],
    });

    expect(result.success).toBe(false);
    // Not "denied"/"not in allow list" — empty arrays must not turn into a deny-all.
    expect(result.error).not.toMatch(/denied|not in allow list/i);
    expect(result.error).toMatch(/private|blocked|loopback|safety/i);
  });

  it('non-array filter input is normalized away instead of crashing the engine', async () => {
    const result = await handleWebFetchTool('web_fetch', {
      url: 'http://127.0.0.1/',
      // A bare string is a plausible model mistake; must not throw ".some is not a function".
      allowed_domains: 'example.com',
      blocked_domains: 42,
    });

    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/is not a function|\.some/i);
    expect(result.error).toMatch(/private|blocked|loopback|safety/i);
  });
});
