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

  it('blocked_domains rejects the listed host', async () => {
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

  it('omitting both filters preserves existing behavior (SSRF guard still applies)', async () => {
    const result = await handleWebFetchTool('web_fetch', {
      url: 'http://127.0.0.1/',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private|blocked|loopback|safety|denied/i);
  });
});
