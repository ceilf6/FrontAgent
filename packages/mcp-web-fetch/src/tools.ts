/**
 * MCP Tool definitions for Web-Fetch
 * Exposes the web-fetch operation as an MCP-compatible tool for FrontAgent
 */

import { fetchUrl } from './engine.js';
import type { WebFetchToolResult } from './types.js';

export type { WebFetchToolResult } from './types.js';

// ─── Tool Schemas ──────────────────────────────────────────────────────────────

export const webFetchSchema = {
  name: 'web_fetch',
  description:
    '抓取指定 URL 的网页内容并返回清洗后的可读文本（HTML→纯文本）。用于查阅库/框架文档、API 参考、错误信息等外部资料。内置 SSRF 防护：拒绝私网/环回/链路本地/云元数据地址。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: '要抓取的 URL（仅支持 http/https）',
      },
      format: {
        type: 'string',
        enum: ['text', 'html'],
        description: '返回格式：text（默认，HTML 转纯文本）或 html（原始 HTML）',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1,
        maximum: 60000,
        description: '请求超时时间（毫秒），默认 15000，硬上限 60000',
      },
      maxBytes: {
        type: 'number',
        minimum: 1,
        maximum: 5000000,
        description: '响应体最大字节数，超出后截断，默认 2000000，硬上限 5000000',
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: '可选允许域名列表；映射到底层引擎 allowHosts，仅允许抓取这些主机名。',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: '可选阻止域名列表；映射到底层引擎 denyHosts，拒绝抓取这些主机名。',
      },
    },
    required: ['url'],
  },
};

// ─── All schemas for registration ─────────────────────────────────────────────

export const allWebFetchSchemas = [webFetchSchema];

// ─── Tool Handlers ─────────────────────────────────────────────────────────────

export async function handleWebFetchTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<WebFetchToolResult> {
  try {
    switch (toolName) {
      case 'web_fetch': {
        const allowHosts = args.allowed_domains as string[] | undefined;
        const denyHosts = args.blocked_domains as string[] | undefined;

        if (Array.isArray(allowHosts) && allowHosts.length === 0) {
          return {
            success: false,
            error: 'allowed_domains must contain at least one domain when provided',
          };
        }
        if (Array.isArray(denyHosts) && denyHosts.length === 0) {
          return {
            success: false,
            error: 'blocked_domains must contain at least one domain when provided',
          };
        }

        const data = await fetchUrl(args.url as string, {
          format: args.format as 'text' | 'html' | undefined,
          timeoutMs: args.timeoutMs as number | undefined,
          maxBytes: args.maxBytes as number | undefined,
          allowHosts,
          denyHosts,
        });
        return { success: true, data };
      }
      default:
        return { success: false, error: `Unknown web-fetch tool: ${toolName}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
