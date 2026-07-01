import { describe, expect, it, vi } from 'vitest';
import { handleWebFetchTool, webFetchSchema } from './tools.js';

describe('mcp-web-fetch SSRF guards (no network)', () => {
  it('rejects loopback IPv4 addresses', async () => {
    const result = await handleWebFetchTool('web_fetch', { url: 'http://127.0.0.1/' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private|blocked|loopback|safety|denied/i);
  });

  it('rejects localhost', async () => {
    const result = await handleWebFetchTool('web_fetch', { url: 'http://localhost/' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private|blocked|loopback|safety|denied/i);
  });

  it('rejects cloud metadata addresses', async () => {
    const result = await handleWebFetchTool('web_fetch', {
      url: 'http://169.254.169.254/latest/meta-data/',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private|blocked|loopback|safety|denied/i);
  });

  it('rejects file: URLs', async () => {
    const result = await handleWebFetchTool('web_fetch', { url: 'file:///etc/passwd' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private|blocked|loopback|safety|denied|protocol/i);
  });

  it('rejects ftp: URLs', async () => {
    const result = await handleWebFetchTool('web_fetch', { url: 'ftp://example.com' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private|blocked|loopback|safety|denied|protocol/i);
  });

  it('rejects URLs with embedded credentials', async () => {
    const result = await handleWebFetchTool('web_fetch', {
      url: 'http://user:pass@example.com/',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private|blocked|loopback|safety|denied|credentials/i);
  });

  it('rejects unknown tool names', async () => {
    const result = await handleWebFetchTool('not_a_real_tool', { url: 'https://example.com' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown/i);
  });

  it('exposes allowed_domains and blocked_domains schema parameters', () => {
    expect(webFetchSchema.inputSchema.properties.allowed_domains).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: '可选允许域名列表；映射到底层引擎 allowHosts，仅允许抓取这些主机名。',
    });
    expect(webFetchSchema.inputSchema.properties.blocked_domains).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: '可选阻止域名列表；映射到底层引擎 denyHosts，拒绝抓取这些主机名。',
    });
    expect(webFetchSchema.inputSchema.required).toEqual(['url']);
  });

  it('maps allowed_domains to allowHosts and rejects before fetch', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(() => {
      throw new Error('network attempted');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await handleWebFetchTool('web_fetch', {
        url: 'https://example.com/',
        allowed_domains: ['docs.example.com'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not in allowlist|allow/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps blocked_domains to denyHosts and rejects before fetch', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(() => {
      throw new Error('network attempted');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await handleWebFetchTool('web_fetch', {
        url: 'https://example.com/',
        blocked_domains: ['example.com'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/denylist|blocked|denied/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
