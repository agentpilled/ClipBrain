// ClipBrain — AI post-processing layer
// After every capture, compiles source text into searchable knowledge.

export interface ProcessResult {
  summary: string;           // 2-3 sentence summary
  importance?: string;       // Why this source matters to the user's knowledge base
  tags: string[];            // 3-5 semantic tags (e.g., "startups", "psychology")
  atoms?: KnowledgeAtoms;    // Structured, searchable knowledge extracted from the source
  connections: Connection[];  // Related content in the knowledge base
}

export interface KnowledgeAtoms {
  claims: string[];
  quotes: string[];
  entities: KnowledgeEntity[];
  questions: string[];
  actions: string[];
}

export interface KnowledgeEntity {
  name: string;
  type: 'person' | 'company' | 'project' | 'book' | 'concept' | 'tool' | 'other';
  relevance: string;
}

export interface Connection {
  slug: string;
  title: string;
  reason: string;  // Why this is connected (1 sentence)
}

export const KNOWLEDGE_COMPILER_VERSION = 'clipbrain-kc-v1';
const DEFAULT_SOURCE_CHUNK_MAX_CHARS = 1400;

export type SourceChunkRef = {
  slug: string;
  title: string;
  index: number;
  total: number;
  charCount: number;
};

export type SourceChunkPage = SourceChunkRef & {
  markdown: string;
  content: string;
};

export type EnrichMarkdownOptions = {
  sourceStorage?: {
    mode: 'full' | 'chunked';
    chunks: SourceChunkRef[];
  };
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ProcessingConfig {
  enabled: boolean;
  model: string;
  provider: string;
}

async function loadConfig(): Promise<ProcessingConfig | null> {
  try {
    const configFile = import.meta.dir + '/.clipbrain.json';
    const config = JSON.parse(await Bun.file(configFile).text());
    return config.processing || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// gbrain CLI integration (mirrors server.ts helpers)
// ---------------------------------------------------------------------------

function resolveGbrainCommand(): string[] {
  if (process.env.GBRAIN_BIN) return [process.env.GBRAIN_BIN];

  const pathGbrain = findExecutableOnPath('gbrain');
  if (pathGbrain) return [pathGbrain];

  return ['gbrain'];
}

function findExecutableOnPath(command: string): string | null {
  const fs = require('fs');
  const path = require('path');
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const fullPath = path.join(dir, command);
    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      return fullPath;
    } catch {
      // Continue scanning PATH.
    }
  }
  return null;
}

async function gbrainExec(args: string[]): Promise<string> {
  const cmd = resolveGbrainCommand();
  const proc = Bun.spawn([...cmd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`gbrain ${args[0]} failed: ${stderr}`);
  }

  return stdout;
}

async function gbrainPut(slug: string, markdown: string): Promise<void> {
  const cmd = resolveGbrainCommand();
  const proc = Bun.spawn([...cmd, 'put', slug], {
    stdin: new Blob([markdown]),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`gbrain put failed: ${stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Obsidian sync (mirrors server.ts)
// ---------------------------------------------------------------------------

async function obsidianSync(slug: string, markdown: string) {
  try {
    const configFile = import.meta.dir + '/.clipbrain.json';
    const config = JSON.parse(await Bun.file(configFile).text());

    if (!config.obsidian?.enabled || !config.obsidian?.vaultPath) return;

    const vaultPath = config.obsidian.vaultPath;
    const folder = config.obsidian.folder || 'ClipBrain';

    const titleMatch = markdown.match(/^title:\s*"?(.+?)"?\s*$/m);
    const title = titleMatch ? titleMatch[1] : slug.split('/').pop()?.replace(/-/g, ' ') || slug;

    // Guard against empty/junk titles
    if (!title || title.replace(/[\s\-]+/g, '').length === 0) {
      console.warn(`[post-process] obsidian: skipping sync for "${slug}" — empty or invalid title`);
      return;
    }

    const subfolder = slug.startsWith('kindle/') ? 'kindle' : slug.startsWith('pdf/') ? 'pdf' : slug.startsWith('youtube/') ? 'youtube' : 'web';
    let cleanTitle = title
      .replace(/:/g, ' -')           // colons → " -"
      .replace(/[/\\?%*|"<>]/g, '')  // remove other illegal filename chars
      .replace(/\s+/g, ' ')          // collapse whitespace
      .trim();

    // Final guard: if cleaning emptied the title, use slug
    if (!cleanTitle || cleanTitle.replace(/[\s\-]+/g, '').length === 0) {
      cleanTitle = slug.split('/').pop()?.replace(/-/g, ' ')?.trim() || 'untitled';
    }

    const filename = cleanTitle.slice(0, 100) + '.md';

    const dirPath = `${vaultPath}/${folder}/${subfolder}`;
    const filePath = `${dirPath}/${filename}`;

    const fs = require('fs');
    fs.mkdirSync(dirPath, { recursive: true });

    await Bun.write(filePath, markdown);
    console.log(`[post-process] obsidian synced ${filePath}`);
  } catch (err: any) {
    console.warn(`[post-process] obsidian sync failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// OpenAI API call
// ---------------------------------------------------------------------------

export async function callOpenAI(content: string, relatedTitles: string[]): Promise<ProcessResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const config = await loadConfig();
  const model = config?.model || 'gpt-4o-mini';

  const MAX_RETRIES = 2;
  const requestBody = JSON.stringify({
    model,
    messages: [{
      role: 'system',
      content: [
        'You are ClipBrain Knowledge Compiler v1.',
        'Turn captured reading into durable, source-grounded memory for coding and reasoning agents.',
        'Extract only what is supported by the source. Be concrete, compact, and useful.',
        'Return strict JSON with this shape:',
        '{',
        '  "summary": "2-3 sentence summary",',
        '  "importance": "why this matters to the user knowledge base, 1 sentence",',
        '  "tags": ["3-5 lowercase semantic tags"],',
        '  "atoms": {',
        '    "claims": ["strong claims or reusable ideas, max 5"],',
        '    "quotes": ["short memorable exact quotes if present, max 3"],',
        '    "entities": [{"name": "...", "type": "person|company|project|book|concept|tool|other", "relevance": "why it matters"}],',
        '    "questions": ["open questions raised by the source, max 3"],',
        '    "actions": ["specific follow-up actions or applications, max 3"]',
        '  },',
        '  "connections": [{"title": "existing item title", "reason": "why it is genuinely related"}]',
        '}',
        'If a field has no grounded items, return an empty array or empty string.',
      ].join('\n')
    }, {
      role: 'user',
      content: `Content to process:\n${content.slice(0, 6000)}\n\nExisting items in knowledge base:\n${relatedTitles.join('\n')}`
    }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 1100,
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });

    if (response.ok) {
      const data = await response.json();
      return parseOpenAIResponse(data);
    }

    // Rate limited — retry with exponential backoff
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = (attempt + 1) * 60_000; // 60s, 120s
      console.warn(`[post-process] OpenAI rate limited (429), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    const errText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errText}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parse OpenAI response
// ---------------------------------------------------------------------------

export function parseOpenAIResponse(data: any): ProcessResult | null {
  try {
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const atomsInput = parsed.atoms || parsed.knowledge_atoms || parsed.knowledgeAtoms || {};

    return {
      summary: cleanString(parsed.summary, 1000),
      importance: cleanString(parsed.importance || parsed.why_it_matters || parsed.whyItMatters, 500),
      tags: limitStringArray(parsed.tags, 5, 48),
      atoms: {
        claims: limitStringArray(atomsInput.claims || parsed.claims, 5, 280),
        quotes: limitStringArray(atomsInput.quotes || atomsInput.memorable_quotes || parsed.quotes, 3, 500),
        entities: limitEntities(atomsInput.entities || parsed.entities, 8),
        questions: limitStringArray(atomsInput.questions || parsed.questions, 3, 240),
        actions: limitStringArray(atomsInput.actions || atomsInput.action_items || parsed.actions, 3, 240),
      },
      connections: Array.isArray(parsed.connections)
        ? parsed.connections
            .filter((c: any) => c && typeof c.title === 'string' && typeof c.reason === 'string')
            .slice(0, 5)
            .map((c: any) => ({ slug: '', title: cleanString(c.title, 120), reason: cleanString(c.reason, 240) }))
            .filter((c: Connection) => c.title && c.reason)
        : [],
    };
  } catch {
    return null;
  }
}

function emptyAtoms(): KnowledgeAtoms {
  return { claims: [], quotes: [], entities: [], questions: [], actions: [] };
}

function cleanString(value: any, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function limitStringArray(value: any, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const cleaned = cleanString(item, maxLength);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function limitEntities(value: any, limit: number): KnowledgeEntity[] {
  if (!Array.isArray(value)) return [];

  const allowedTypes = new Set(['person', 'company', 'project', 'book', 'concept', 'tool', 'other']);
  const seen = new Set<string>();
  const result: KnowledgeEntity[] = [];

  for (const item of value) {
    let name = '';
    let type: KnowledgeEntity['type'] = 'other';
    let relevance = '';

    if (typeof item === 'string') {
      name = cleanString(item, 120);
    } else if (item && typeof item === 'object') {
      name = cleanString(item.name, 120);
      const rawType = cleanString(item.type, 40).toLowerCase();
      type = allowedTypes.has(rawType) ? rawType as KnowledgeEntity['type'] : 'other';
      relevance = cleanString(item.relevance || item.reason || item.description, 240);
    }

    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push({ name, type, relevance });
    if (result.length >= limit) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Find related content via gbrain query
// ---------------------------------------------------------------------------

async function findRelatedContent(text: string): Promise<Array<{ slug: string; title: string }>> {
  const queryText = text.slice(0, 200).replace(/\n/g, ' ').trim();
  if (!queryText) return [];

  try {
    const output = await gbrainExec(['query', queryText]);
    const lines = output.trim().split('\n').filter(Boolean);
    const results: Array<{ slug: string; title: string }> = [];

    for (const line of lines.slice(0, 5)) {
      const parts = line.split('\t');
      let slug: string;
      let title: string;

      if (parts.length >= 4) {
        slug = parts[0].trim();
        title = parts[3].trim();
      } else if (line.includes(' -- ')) {
        const [left] = line.split(' -- ');
        const scoreMatch = left.match(/\[[\d.]+\]\s*(.*)/);
        slug = scoreMatch ? scoreMatch[1].trim() : left.trim();
        title = slug.split('/').pop()?.replace(/-/g, ' ') || slug;
      } else {
        slug = parts[0]?.trim() || line.trim();
        title = slug.split('/').pop()?.replace(/-/g, ' ') || slug;
      }

      results.push({ slug, title });
    }

    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Parse existing frontmatter
// ---------------------------------------------------------------------------

export function parseFrontmatter(markdown: string): { frontmatter: Record<string, any>; body: string } {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: markdown };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { frontmatter: {}, body: markdown };
  }

  const fmLines = lines.slice(1, endIdx);
  const fm: Record<string, any> = {};

  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const match = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();

      if (isYamlBlockScalar(value)) {
        const block: string[] = [];
        while (i + 1 < fmLines.length && /^\s+/.test(fmLines[i + 1])) {
          block.push(fmLines[++i].trim());
        }
        fm[key] = cleanFrontmatterValue(block.join(' '));
        continue;
      }

      if (!value && i + 1 < fmLines.length && /^\s+-\s+/.test(fmLines[i + 1])) {
        const items: string[] = [];
        while (i + 1 < fmLines.length && /^\s+-\s+/.test(fmLines[i + 1])) {
          items.push(cleanFrontmatterValue(fmLines[++i].replace(/^\s+-\s+/, '')));
        }
        fm[key] = items;
        continue;
      }

      // Handle quoted strings
      value = cleanFrontmatterValue(value);

      // Handle arrays like [tag1, tag2]
      if (value.startsWith('[') && value.endsWith(']')) {
        fm[key] = value.slice(1, -1).split(',').map(s => cleanFrontmatterValue(s));
      } else {
        fm[key] = value;
      }
    }
  }

  const body = lines.slice(endIdx + 1).join('\n');
  return { frontmatter: fm, body };
}

function isYamlBlockScalar(value: string): boolean {
  return value === '>' || value === '>-' || value === '>+' || value === '|' || value === '|-' || value === '|+';
}

function cleanFrontmatterValue(value: string): string {
  let cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.startsWith("'''") && cleaned.endsWith("'''")) return cleaned.slice(3, -3);
  if (cleaned.startsWith('"""') && cleaned.endsWith('"""')) return cleaned.slice(3, -3);
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) return cleaned.slice(1, -1);
  if (cleaned.startsWith("'") && cleaned.endsWith("'")) return cleaned.slice(1, -1);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Enrich markdown with AI results
// ---------------------------------------------------------------------------

export function enrichMarkdown(
  originalMarkdown: string,
  result: ProcessResult,
  relatedContent: Array<{ slug: string; title: string }>,
  options: EnrichMarkdownOptions = {},
): string {
  const { frontmatter, body } = parseFrontmatter(originalMarkdown);

  // Map connection titles to slugs from related content
  const titleToSlug = new Map<string, string>();
  for (const item of relatedContent) {
    titleToSlug.set(item.title.toLowerCase(), item.slug);
  }

  const connectionsWithSlugs: Connection[] = result.connections.map(c => ({
    slug: titleToSlug.get(c.title.toLowerCase()) || '',
    title: c.title,
    reason: c.reason,
  })).filter(c => c.slug); // Only keep connections we can link to

  const atoms = result.atoms || emptyAtoms();

  // Build enriched frontmatter
  const fmLines: string[] = [
    '---',
    `title: "${(frontmatter.title || '').replace(/"/g, '\\"')}"`,
    `type: ${frontmatter.type || 'reference'}`,
    `tags: [${result.tags.join(', ')}]`,
    `summary: "${result.summary.replace(/"/g, '\\"')}"`,
  ];
  if (result.importance) {
    fmLines.push(`importance: "${result.importance.replace(/"/g, '\\"')}"`);
  }

  if (connectionsWithSlugs.length > 0) {
    fmLines.push('connections:');
    for (const conn of connectionsWithSlugs) {
      fmLines.push(`  - slug: ${conn.slug}`);
      fmLines.push(`    reason: "${conn.reason.replace(/"/g, '\\"')}"`);
    }
  }

  // Preserve original frontmatter fields
  if (frontmatter.source_url) fmLines.push(`source_url: ${frontmatter.source_url}`);
  if (frontmatter.source) fmLines.push(`source: ${frontmatter.source}`);
  if (frontmatter.captured_at) fmLines.push(`captured_at: ${frontmatter.captured_at}`);
  if (frontmatter.pages) fmLines.push(`pages: ${frontmatter.pages}`);
  if (options.sourceStorage?.mode === 'chunked') {
    fmLines.push('source_storage: chunked');
    fmLines.push(`source_chunk_count: ${options.sourceStorage.chunks.length}`);
  }
  fmLines.push(`compiler_version: ${KNOWLEDGE_COMPILER_VERSION}`);
  fmLines.push(`processed_at: ${new Date().toISOString()}`);
  fmLines.push('---');

  // Build summary and related sections
  const enrichedSections: string[] = [];

  enrichedSections.push('');
  enrichedSections.push('## Summary');
  enrichedSections.push('');
  enrichedSections.push(result.summary);

  if (result.importance) {
    enrichedSections.push('');
    enrichedSections.push('## Why It Matters');
    enrichedSections.push('');
    enrichedSections.push(result.importance);
  }

  if (hasKnowledgeAtoms(atoms)) {
    enrichedSections.push('');
    enrichedSections.push('## Knowledge Atoms');

    if (atoms.claims.length > 0) {
      enrichedSections.push('');
      enrichedSections.push('### Claims');
      enrichedSections.push('');
      for (const claim of atoms.claims) {
        enrichedSections.push(`- ${claim}`);
      }
    }

    if (atoms.quotes.length > 0) {
      enrichedSections.push('');
      enrichedSections.push('### Quotes');
      enrichedSections.push('');
      for (const quote of atoms.quotes) {
        enrichedSections.push(`> ${quote.replace(/^>\s*/, '')}`);
        enrichedSections.push('');
      }
      if (enrichedSections[enrichedSections.length - 1] === '') enrichedSections.pop();
    }

    if (atoms.entities.length > 0) {
      enrichedSections.push('');
      enrichedSections.push('### Entities');
      enrichedSections.push('');
      for (const entity of atoms.entities) {
        const suffix = entity.relevance ? ` - ${entity.relevance}` : '';
        enrichedSections.push(`- **${entity.name}** (${entity.type})${suffix}`);
      }
    }

    if (atoms.questions.length > 0) {
      enrichedSections.push('');
      enrichedSections.push('### Open Questions');
      enrichedSections.push('');
      for (const question of atoms.questions) {
        enrichedSections.push(`- ${question}`);
      }
    }

    if (atoms.actions.length > 0) {
      enrichedSections.push('');
      enrichedSections.push('### Actions');
      enrichedSections.push('');
      for (const action of atoms.actions) {
        enrichedSections.push(`- [ ] ${action}`);
      }
    }
  }

  if (connectionsWithSlugs.length > 0) {
    enrichedSections.push('');
    enrichedSections.push('## Related');
    enrichedSections.push('');
    for (const conn of connectionsWithSlugs) {
      enrichedSections.push(`- [[${conn.title}]] — ${conn.reason}`);
    }
  }

  if (options.sourceStorage?.mode === 'chunked') {
    enrichedSections.push('');
    enrichedSections.push('## Source Chunks');
    enrichedSections.push('');
    for (const chunk of options.sourceStorage.chunks) {
      enrichedSections.push(`- [[${chunk.title}]] (${chunk.index}/${chunk.total})`);
    }
  }

  enrichedSections.push('');
  enrichedSections.push('---');

  // Strip existing generated sections if re-processing.
  const cleanBody = cleanSourceBodyFromParsed(frontmatter, body);

  if (options.sourceStorage?.mode === 'chunked') {
    return fmLines.join('\n') + enrichedSections.join('\n') + '\n';
  }
  return fmLines.join('\n') + enrichedSections.join('\n') + cleanBody + '\n';
}

export function cleanSourceBody(markdown: string): string {
  const { frontmatter, body } = parseFrontmatter(markdown);
  return cleanSourceBodyFromParsed(frontmatter, body);
}

function cleanSourceBodyFromParsed(frontmatter: Record<string, any>, body: string): string {
  let cleanBody = body;
  if (frontmatter.processed_at) {
    cleanBody = cleanBody.replace(/^\s*## Summary\s*\n[\s\S]*?\n---\s*\n?/, '\n');
  }
  cleanBody = cleanBody.replace(/^\n+/, '\n');
  return wrapLongMarkdownLines(cleanBody);
}

export function wrapLongMarkdownLines(markdown: string, maxLineLength = 1200): string {
  return markdown
    .split('\n')
    .flatMap(line => wrapLongMarkdownLine(line, maxLineLength))
    .join('\n');
}

function wrapLongMarkdownLine(line: string, maxLineLength: number): string[] {
  if (line.length <= maxLineLength) return [line];

  const quotePrefix = line.match(/^(\s*>\s*)/)?.[1] || '';
  const content = quotePrefix ? line.slice(quotePrefix.length) : line;
  const words = content.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = quotePrefix;

  for (const word of words) {
    if (current.length > quotePrefix.length && current.length + 1 + word.length > maxLineLength) {
      lines.push(current);
      current = quotePrefix + word;
    } else {
      current += current.length > quotePrefix.length ? ` ${word}` : word;
    }
  }

  if (current.length > quotePrefix.length || lines.length === 0) lines.push(current);
  return lines;
}

export function isEmbeddingContextLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /input length exceeds the context length|maximum context|context length exceeded|too many tokens|token limit exceeded|maximum request size.*tokens/i
    .test(message);
}

export function splitSourceBodyForStorage(sourceBody: string, maxChars = DEFAULT_SOURCE_CHUNK_MAX_CHARS): string[] {
  const limit = Number.isFinite(maxChars) && maxChars > 200 ? Math.trunc(maxChars) : DEFAULT_SOURCE_CHUNK_MAX_CHARS;
  const normalized = wrapLongMarkdownLines(sourceBody, Math.min(1000, limit)).trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      pushCurrent();
      chunks.push(...splitLongStorageText(paragraph, limit));
      continue;
    }

    if (!current) {
      current = paragraph;
    } else if (current.length + paragraph.length + 2 <= limit) {
      current += `\n\n${paragraph}`;
    } else {
      pushCurrent();
      current = paragraph;
    }
  }

  pushCurrent();
  return chunks;
}

function splitLongStorageText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const candidates = [
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf(' '),
    ];
    let splitAt = Math.max(...candidates);
    if (splitAt < Math.floor(maxChars * 0.5)) splitAt = maxChars;

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function buildSourceChunkPages(opts: {
  slug: string;
  markdown: string;
  sourceBody?: string;
  maxChars?: number;
  processedAt?: string;
}): SourceChunkPage[] {
  const { frontmatter } = parseFrontmatter(opts.markdown);
  const sourceBody = opts.sourceBody ?? cleanSourceBody(opts.markdown);
  const chunks = splitSourceBodyForStorage(sourceBody, opts.maxChars);
  const title = cleanString(frontmatter.title, 180) || opts.slug.split('/').pop()?.replace(/-/g, ' ') || opts.slug;
  const processedAt = opts.processedAt || new Date().toISOString();
  const total = chunks.length;

  return chunks.map((content, i) => {
    const index = i + 1;
    const chunkTitle = `${title} source chunk ${index}/${total}`;
    const slug = sourceChunkSlug(opts.slug, index);
    const fmLines = [
      '---',
      `title: ${yamlQuoted(chunkTitle)}`,
      'type: reference',
      'tags: [clipbrain-source-chunk]',
      `parent_slug: ${yamlQuoted(opts.slug)}`,
      `source_chunk_index: ${index}`,
      `source_chunk_total: ${total}`,
    ];

    if (frontmatter.source_url) fmLines.push(`source_url: ${frontmatter.source_url}`);
    if (frontmatter.source) fmLines.push(`source: ${frontmatter.source}`);
    if (frontmatter.captured_at) fmLines.push(`captured_at: ${frontmatter.captured_at}`);

    fmLines.push(`compiler_version: ${KNOWLEDGE_COMPILER_VERSION}`);
    fmLines.push(`processed_at: ${processedAt}`);
    fmLines.push('---');

    const markdown = [
      fmLines.join('\n'),
      '',
      `Parent: ${opts.slug}`,
      '',
      content,
      '',
    ].join('\n');

    return {
      slug,
      title: chunkTitle,
      index,
      total,
      charCount: content.length,
      markdown,
      content,
    };
  });
}

function sourceChunkSlug(parentSlug: string, index: number): string {
  const safeParent = parentSlug
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9/_-]+/gi, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-');
  return `clipbrain-source/${safeParent}/chunk-${String(index).padStart(3, '0')}`;
}

function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

function hasKnowledgeAtoms(atoms: KnowledgeAtoms): boolean {
  return atoms.claims.length > 0 ||
    atoms.quotes.length > 0 ||
    atoms.entities.length > 0 ||
    atoms.questions.length > 0 ||
    atoms.actions.length > 0;
}

// ---------------------------------------------------------------------------
// Generate wikilinks for Obsidian
// ---------------------------------------------------------------------------

export function generateWikilinks(connections: Connection[]): string {
  return connections
    .filter(c => c.title)
    .map(c => `- [[${c.title}]] — ${c.reason}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Check if already processed
// ---------------------------------------------------------------------------

export function isAlreadyProcessed(markdown: string): boolean {
  return /^processed_at:\s*.+$/m.test(markdown);
}

export function getKnowledgeCompilerVersion(markdown: string): string {
  const { frontmatter } = parseFrontmatter(markdown);
  return typeof frontmatter.compiler_version === 'string' ? frontmatter.compiler_version : '';
}

export function isCurrentKnowledgeCompiler(markdown: string): boolean {
  return getKnowledgeCompilerVersion(markdown) === KNOWLEDGE_COMPILER_VERSION;
}

export function getBackfillReason(markdown: string, force = false): string | null {
  if (force) return 'force';

  const version = getKnowledgeCompilerVersion(markdown);
  if (!version) return isAlreadyProcessed(markdown) ? 'legacy-processed' : 'unprocessed';
  if (version !== KNOWLEDGE_COMPILER_VERSION) return `outdated:${version}`;

  return null;
}

// ---------------------------------------------------------------------------
// Main post-process function
// ---------------------------------------------------------------------------

export async function postProcess(slug: string, markdown: string, force = false): Promise<void> {
  // 1. Check if OPENAI_API_KEY exists
  if (!process.env.OPENAI_API_KEY) {
    return; // Skip silently
  }

  // 2. Check config
  const config = await loadConfig();
  if (config && !config.enabled) {
    return; // Processing disabled in config
  }

  // 3. Don't re-process unless forced
  if (!force && isAlreadyProcessed(markdown)) {
    return;
  }

  // 4. Find related content via gbrain query
  const titleMatch = markdown.match(/^title:\s*"?(.+?)"?\s*$/m);
  const title = titleMatch ? titleMatch[1] : '';
  const { body } = parseFrontmatter(markdown);
  const queryText = `${title} ${body.slice(0, 200)}`;

  const relatedContent = await findRelatedContent(queryText);
  const relatedTitles = relatedContent.map(r => r.title);

  // 5. Call OpenAI
  const result = await callOpenAI(body, relatedTitles);
  if (!result) {
    console.warn(`[post-process] no result from OpenAI for ${slug}`);
    return;
  }

  // 6. Enrich and re-save
  const enrichedMarkdown = enrichMarkdown(markdown, result, relatedContent);

  let savedMarkdown = enrichedMarkdown;
  try {
    await gbrainPut(slug, enrichedMarkdown);
  } catch (err) {
    if (!isEmbeddingContextLimitError(err)) throw err;

    const chunkPages = buildSourceChunkPages({ slug, markdown });
    if (chunkPages.length === 0) throw err;

    const compactMarkdown = enrichMarkdown(markdown, result, relatedContent, {
      sourceStorage: {
        mode: 'chunked',
        chunks: chunkPages.map(({ slug, title, index, total, charCount }) => ({
          slug,
          title,
          index,
          total,
          charCount,
        })),
      },
    });

    for (const page of chunkPages) {
      await gbrainPut(page.slug, page.markdown);
    }
    await gbrainPut(slug, compactMarkdown);
    savedMarkdown = compactMarkdown;
    console.warn(`[post-process] stored ${slug} with chunked source fallback (${chunkPages.length} chunks)`);
  }

  // 7. Re-sync to Obsidian with wikilinks
  await obsidianSync(slug, savedMarkdown);

  const tagCount = result.tags.length;
  const connCount = result.connections.filter(c => c.slug || relatedContent.some(r => r.title.toLowerCase() === c.title.toLowerCase())).length;
  console.log(`[post-process] processed ${slug} (${tagCount} tags, ${connCount} connections)`);
}
