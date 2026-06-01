import { describe, test, expect } from 'bun:test';
import {
  buildContextPackUrl,
  coerceContextPackArgs,
  contextPackTool,
  fetchContextPack,
  formatContextPackToolText,
} from '../clipbrain-mcp.ts';

const samplePack = {
  query: 'agent memory',
  generatedAt: '2026-06-01T00:00:00.000Z',
  sources: [
    { id: 'S1', title: 'Knowledge Bases for Agents', slug: 'web/example' },
  ],
  markdown: '# Context Pack: agent memory\n\n## [S1] Knowledge Bases for Agents\n',
};

describe('clipbrain MCP context_pack tool', () => {
  test('defines a required query and optional bounded limit', () => {
    expect(contextPackTool.name).toBe('context_pack');
    expect(contextPackTool.inputSchema.required).toEqual(['query']);
    expect(contextPackTool.inputSchema.properties.limit.maximum).toBe(10);
  });

  test('coerces tool args with defaults and clamps limit', () => {
    expect(coerceContextPackArgs({ query: '  agent memory  ' })).toEqual({
      query: 'agent memory',
      limit: 6,
      format: 'markdown',
    });

    expect(coerceContextPackArgs({ query: 'x', limit: '99', format: 'both' })).toEqual({
      query: 'x',
      limit: 10,
      format: 'both',
    });
  });

  test('rejects missing query and invalid format', () => {
    expect(() => coerceContextPackArgs({})).toThrow('query');
    expect(() => coerceContextPackArgs({ query: 'x', format: 'xml' })).toThrow('format');
  });

  test('builds the local HTTP endpoint URL', () => {
    expect(buildContextPackUrl('http://127.0.0.1:19285', 'agent memory', 3))
      .toBe('http://127.0.0.1:19285/api/context-pack?q=agent+memory&limit=3');
  });

  test('fetches a context pack through the ClipBrain server', async () => {
    let seenUrl = '';
    const fetchImpl = async (input: string | URL) => {
      seenUrl = String(input);
      return new Response(JSON.stringify(samplePack), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await fetchContextPack(
      { query: 'agent memory', limit: 2, format: 'json' },
      { baseUrl: 'http://clipbrain.local', fetchImpl },
    );

    expect(seenUrl).toBe('http://clipbrain.local/api/context-pack?q=agent+memory&limit=2');
    expect(result.format).toBe('json');
    expect(result.pack.markdown).toContain('[S1]');
  });

  test('surfaces ClipBrain server errors', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: 'Missing required parameter: q' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

    await expect(fetchContextPack({ query: 'x' }, { fetchImpl })).rejects.toThrow('400');
  });

  test('formats markdown, json, and combined tool output', () => {
    expect(formatContextPackToolText(samplePack, 'markdown')).toBe(samplePack.markdown);
    expect(formatContextPackToolText(samplePack, 'json')).toContain('"sources"');

    const both = formatContextPackToolText(samplePack, 'both');
    expect(both).toContain('# Context Pack');
    expect(both).toContain('```json');
  });
});
