import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_CLIPBRAIN_SERVER_URL = 'http://127.0.0.1:19285';

export type ContextPackFormat = 'markdown' | 'json' | 'both';

export type ContextPackToolArgs = {
  query: string;
  limit: number;
  format: ContextPackFormat;
};

export type ContextPackResponse = {
  query: string;
  generatedAt: string;
  sources: Array<Record<string, unknown>>;
  markdown: string;
};

export const contextPackTool = {
  name: 'context_pack',
  description: [
    'Build a compact, cited ClipBrain Context Pack from the user\'s saved knowledge.',
    'Use this before answering synthesis, planning, writing, or recall questions that should be grounded in saved articles, notes, Kindle highlights, PDFs, videos, or emails.',
    'Returns source-labeled markdown with [S#] citations, snippets, summaries, claims, quotes, entities, open questions, and actions.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The topic, question, project, or memory target to retrieve context for.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        default: 6,
        description: 'Maximum number of sources to include. Defaults to 6; capped at 10.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json', 'both'],
        default: 'markdown',
        description: 'Return markdown by default, raw JSON, or both.',
      },
    },
    required: ['query'],
  },
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function coerceContextPackArgs(input: unknown): ContextPackToolArgs {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('Missing required argument: query');

  const limit = clampLimit(args.limit);
  const format = coerceFormat(args.format);
  return { query, limit, format };
}

export function buildContextPackUrl(baseUrl: string, query: string, limit: number): string {
  const url = new URL('/api/context-pack', normalizeBaseUrl(baseUrl));
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

export async function fetchContextPack(
  args: unknown,
  opts: { baseUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<{ pack: ContextPackResponse; format: ContextPackFormat }> {
  const parsed = coerceContextPackArgs(args);
  const baseUrl = opts.baseUrl || process.env.CLIPBRAIN_SERVER_URL || DEFAULT_CLIPBRAIN_SERVER_URL;
  const fetchImpl = opts.fetchImpl || fetch;
  const url = buildContextPackUrl(baseUrl, parsed.query, parsed.limit);

  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
  });

  const text = await response.text();
  const body = parseJson(text);

  if (!response.ok) {
    const message = body && typeof body.error === 'string' ? body.error : text;
    throw new Error(`ClipBrain server returned ${response.status}: ${message || response.statusText}`);
  }

  if (!body || typeof body.markdown !== 'string' || typeof body.query !== 'string') {
    throw new Error('ClipBrain server returned an invalid context pack response');
  }

  return {
    pack: body as ContextPackResponse,
    format: parsed.format,
  };
}

export function formatContextPackToolText(pack: ContextPackResponse, format: ContextPackFormat): string {
  if (format === 'json') return JSON.stringify(pack, null, 2);
  if (format === 'both') {
    return [
      pack.markdown.trimEnd(),
      '',
      '```json',
      JSON.stringify(pack, null, 2),
      '```',
    ].join('\n');
  }
  return pack.markdown;
}

export async function startClipBrainMcpServer() {
  const server = new Server(
    { name: 'clipbrain', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [contextPackTool],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any): Promise<any> => {
    const { name, arguments: args } = request.params;

    if (name !== contextPackTool.name) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
    }

    try {
      const { pack, format } = await fetchContextPack(args);
      return {
        content: [{ type: 'text', text: formatContextPackToolText(pack, format) }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: err?.message || String(err) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[clipbrain-mcp] shutdown: ${reason}\n`);
    process.exit(code);
  };

  if (process.env.MCP_STDIO !== '1') {
    process.stdin.on('end', () => shutdown('stdin end'));
    process.stdin.on('close', () => shutdown('stdin close'));
  }
  // @ts-ignore - SDK exposes onclose on the concrete transport.
  transport.onclose = () => shutdown('transport close');
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim() || DEFAULT_CLIPBRAIN_SERVER_URL;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : 6;

  if (!Number.isFinite(parsed)) return 6;
  return Math.max(1, Math.min(10, Math.trunc(parsed)));
}

function coerceFormat(value: unknown): ContextPackFormat {
  if (value === undefined || value === null || value === '') return 'markdown';
  if (value === 'markdown' || value === 'json' || value === 'both') return value;
  throw new Error('format must be one of: markdown, json, both');
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  startClipBrainMcpServer().catch((err: any) => {
    process.stderr.write(`[clipbrain-mcp] failed: ${err?.message || String(err)}\n`);
    process.exit(1);
  });
}
