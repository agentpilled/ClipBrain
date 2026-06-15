#!/usr/bin/env bun

// ClipBrain — standalone HTTP server
// Receives web captures from the Chrome extension and stores them via `gbrain put` CLI.

import { PDFParse } from 'pdf-parse';
import { getBackfillReason, KNOWLEDGE_COMPILER_VERSION, postProcess } from './post-process.ts';
import { isClipBrainCaptureSlug, loadClipBrainListItems, loadClipBrainListOutput } from './gbrain-list.ts';

const DEFAULT_PORT = 19285;
const DEFAULT_HOST = '127.0.0.1';
const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB
const DATA_DIR = process.env.CLIPBRAIN_DATA_DIR || import.meta.dir;

function dataPath(filename: string): string {
  return `${DATA_DIR}/${filename}`;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const STRIP_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
]);

export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);

  // Lowercase scheme + host
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  // Strip tracking params
  for (const key of [...url.searchParams.keys()]) {
    if (STRIP_PARAMS.has(key)) {
      url.searchParams.delete(key);
    }
  }

  // Sort remaining params for determinism
  url.searchParams.sort();

  let href = url.toString();

  // Strip trailing slash (but keep bare domain "/")
  if (href.endsWith('/') && url.pathname !== '/') {
    href = href.slice(0, -1);
  }

  return href;
}

export function slugFromUrl(canonicalUrl: string, title?: string): string {
  // Handle gmail:// URLs — generate slug as email/{from}/{subject}
  if (canonicalUrl.startsWith('gmail://')) {
    // gmail://from-slug/subject-slug
    const path = canonicalUrl.replace('gmail://', '');
    return `email/${path}`;
  }

  // Handle kindle:// URLs — generate slug from title instead
  if (canonicalUrl.startsWith('kindle://')) {
    if (!title) {
      // Fallback: use the path portion of the kindle URL
      const path = canonicalUrl.replace('kindle://book/', '');
      return `kindle/${path}`;
    }

    // Parse "Book Title by Author Name" format
    const byMatch = title.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) {
      const titleSlug = slugifyText(byMatch[1]);
      const authorSlug = slugifyText(byMatch[2]);
      return `kindle/${authorSlug}/${titleSlug}`;
    }

    // No author — just use title
    return `kindle/${slugifyText(title)}`;
  }

  const url = new URL(canonicalUrl);
  const domain = url.hostname.replace(/\./g, '-');
  let path = url.pathname.replace(/^\/|\/$/g, ''); // trim slashes

  if (!path) {
    path = 'index';
  }

  // Decode percent-encoded characters, then clean up
  path = decodeURIComponent(path);
  path = path
    .replace(/\.[a-z]+$/, '')     // strip file extension
    .replace(/[^a-z0-9/\-]/gi, '-') // non-slug chars to dash
    .replace(/-+/g, '-')           // collapse dashes
    .replace(/^-|-$/g, '');        // trim leading/trailing dashes

  return `web/${domain}/${path}`;
}

function slugifyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

export function buildMarkdown(opts: {
  title: string;
  canonicalUrl: string;
  domain: string;
  content: string;
  selection?: string | null;
  capturedAt?: string;
}): string {
  const timestamp = opts.capturedAt || new Date().toISOString();

  const lines = [
    '---',
    `title: "${opts.title.replace(/"/g, '\\"')}"`,
    'type: reference',
    `tags: [web-capture, ${opts.domain}]`,
    `source_url: ${opts.canonicalUrl}`,
    `captured_at: ${timestamp}`,
    '---',
    '',
    opts.content,
  ];

  if (opts.selection) {
    lines.push('', '## Highlights', '', `> ${opts.selection}`);
  }

  return lines.join('\n') + '\n';
}

export function buildEmailMarkdown(opts: {
  title: string;
  subject: string;
  from: string;
  date: string;
  content: string;
  capturedAt?: string;
}): string {
  const timestamp = opts.capturedAt || new Date().toISOString();

  const lines = [
    '---',
    `title: "${opts.subject.replace(/"/g, '\\"')}"`,
    'type: reference',
    `tags: [email, newsletter]`,
    `from: "${opts.from.replace(/"/g, '\\"')}"`,
    `captured_at: ${timestamp}`,
  ];

  if (opts.date) {
    lines.push(`email_date: "${opts.date.replace(/"/g, '\\"')}"`);
  }

  lines.push('---', '', opts.content);

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ClipBrain-Token',
};

function corsResponse(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

export function isAllowedOrigin(origin: string | null | undefined, serverPort = DEFAULT_PORT): boolean {
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://')) return true;

  try {
    const url = new URL(origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') &&
      port === String(serverPort);
  } catch {
    return false;
  }
}

function forbiddenResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Vary': 'Origin' },
  });
}

function rejectDisallowedOrigin(req: Request, serverPort: number): Response | null {
  const origin = req.headers.get('Origin');
  if (!isAllowedOrigin(origin, serverPort)) {
    console.warn(`[security] blocked origin: ${origin}`);
    return forbiddenResponse(403, 'Origin not allowed');
  }
  return null;
}

export function isAuthorizedRequest(method: string, headers: Headers, token = process.env.CLIPBRAIN_API_TOKEN): boolean {
  if (!token || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const auth = headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const headerToken = headers.get('X-ClipBrain-Token') || '';
  return bearer === token || headerToken === token;
}

function rejectUnauthorized(req: Request): Response | null {
  if (isAuthorizedRequest(req.method, req.headers)) return null;
  return forbiddenResponse(401, 'Missing or invalid ClipBrain API token');
}

// ---------------------------------------------------------------------------
// gbrain CLI integration
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
    console.error(`[gbrain put] exit ${exitCode}: ${stderr}`);
    throw new Error(`gbrain put failed: ${stderr || `exit ${exitCode}`}`);
  } else {
    console.log(`[gbrain put] saved ${slug}`);
  }
}

// ---------------------------------------------------------------------------
// gbrain CLI helpers for query/list/stats
// ---------------------------------------------------------------------------

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
    console.error(`[gbrain ${args[0]}] exit ${exitCode}: ${stderr}`);
    throw new Error(`gbrain ${args[0]} failed: ${stderr}`);
  }

  return stdout;
}

async function handleSearch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('q') || '';
  const limit = parseInt(url.searchParams.get('limit') || '10', 10);

  if (!query.trim()) {
    return corsResponse(200, { results: [] });
  }

  try {
    const output = await gbrainExec(['query', query]);
    const results = parseGbrainOutput(output, limit);
    return corsResponse(200, { results });
  } catch (err: any) {
    console.error('[search]', err.message);
    return corsResponse(200, { results: [] });
  }
}

async function handleRecent(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get('limit') || '10', 10);

  try {
    // Fetch more than needed so we can filter and prioritize.
    const output = await loadClipBrainListOutput(gbrainExec, 200);
    const all = parseGbrainOutput(output, 200);

    const sorted = all.filter(i => isClipBrainCaptureSlug(i.slug || '')).slice(0, limit);

    return corsResponse(200, { results: sorted });
  } catch (err: any) {
    console.error('[recent]', err.message);
    return corsResponse(200, { results: [] });
  }
}

// Track highlight counts per kindle book in a local JSON file.
// Returns the delta (new highlights since last capture).
async function updateHighlightCount(slug: string, count: number): Promise<number> {
  const trackingFile = dataPath('.highlight-counts.json');
  let data: Record<string, number> = {};
  try {
    data = JSON.parse(await Bun.file(trackingFile).text());
  } catch {}
  const prev = data[slug] || 0;
  data[slug] = count;
  const total = Object.values(data).reduce((sum, c) => sum + c, 0);
  await Bun.write(trackingFile, JSON.stringify(data));
  await Bun.write(dataPath('.highlight-count'), String(total));
  return Math.max(0, count - prev);
}

// Append-only capture log for the daily digest.
// Each line is a JSON object — robust to crashes, easy to filter by date.
export type CaptureLogEntry = {
  slug: string;
  type: 'kindle' | 'web' | 'youtube' | 'email' | 'pdf';
  title: string;
  capturedAt: string;
  newHighlights?: number;
  url?: string;
  author?: string;
  channel?: string;
  from?: string;
};

export type ContextPackAtoms = ReturnType<typeof parseKnowledgeAtoms>;

export type ContextPackSource = {
  id: string;
  slug: string;
  title: string;
  type: string;
  summary: string;
  tags: string[];
  atoms: ContextPackAtoms;
  snippet: string;
  sourceUrl?: string;
};

export type ContextPack = {
  query: string;
  generatedAt: string;
  sources: ContextPackSource[];
  markdown: string;
};

async function recordCapture(entry: CaptureLogEntry): Promise<void> {
  const logFile = dataPath('.captures.jsonl');
  try {
    const fs = await import('node:fs/promises');
    await fs.appendFile(logFile, JSON.stringify(entry) + '\n');
  } catch (err: any) {
    console.warn('[recordCapture] failed:', err.message);
  }
}

export function detectCaptureType(slug: string): CaptureLogEntry['type'] {
  if (slug.startsWith('kindle/')) return 'kindle';
  if (slug.startsWith('youtube/')) return 'youtube';
  if (slug.startsWith('email/')) return 'email';
  if (slug.startsWith('pdf/')) return 'pdf';
  return 'web';
}

async function handleStats(): Promise<Response> {
  try {
    const items = await loadClipBrainListItems(gbrainExec, 10000);

    let articles = 0;
    let books = 0;
    let pdfs = 0;
    let videos = 0;
    let emails = 0;

    for (const item of items) {
      const slug = item.slug || '';
      if (slug.startsWith('kindle/')) {
        books++;
      } else if (slug.startsWith('youtube/')) {
        videos++;
      } else if (slug.startsWith('web/')) {
        articles++;
      } else if (slug.startsWith('pdf/')) {
        pdfs++;
      } else if (slug.startsWith('email/')) {
        emails++;
      }
    }

    // Read highlight count from local tracking file (updated on each import)
    let highlights = 0;
    try {
      const trackingFile = dataPath('.highlight-count');
      const stored = await Bun.file(trackingFile).text();
      highlights = parseInt(stored.trim(), 10) || 0;
    } catch {
      // No tracking file yet — estimate
      highlights = 0;
    }

    return corsResponse(200, { articles, books, pdfs, videos, emails, highlights });
  } catch (err: any) {
    console.error('[stats]', err.message);
    return corsResponse(200, { articles: 0, books: 0, pdfs: 0, videos: 0, emails: 0, highlights: 0 });
  }
}

// ---------------------------------------------------------------------------
// Daily digest — what was captured since a given timestamp
// ---------------------------------------------------------------------------

function formatTitleCase(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function formatDigestMarkdown(opts: {
  since: Date;
  kindle: CaptureLogEntry[];
  web: CaptureLogEntry[];
  youtube: CaptureLogEntry[];
  email: CaptureLogEntry[];
  pdf: CaptureLogEntry[];
}): string {
  const { since, kindle, web, youtube, email, pdf } = opts;
  const total = kindle.length + web.length + youtube.length + email.length + pdf.length;
  const sinceLabel = since.toISOString().slice(0, 10);

  if (total === 0) {
    return `📚 Sin lecturas nuevas desde ${sinceLabel}.`;
  }

  const lines: string[] = [`📚 *Reading digest* — desde ${sinceLabel}`, ''];

  if (kindle.length) {
    const totalNew = kindle.reduce((s, k) => s + (k.newHighlights || 0), 0);
    lines.push(`*Kindle* — ${totalNew} highlight${totalNew === 1 ? '' : 's'} nuevo${totalNew === 1 ? '' : 's'} en ${kindle.length} libro${kindle.length === 1 ? '' : 's'}`);
    for (const k of kindle) {
      const author = k.author ? ` — ${formatTitleCase(k.author)}` : '';
      const count = k.newHighlights ? ` (${k.newHighlights} nuevo${k.newHighlights === 1 ? '' : 's'})` : '';
      lines.push(`- ${k.title}${author}${count}`);
    }
    lines.push('');
  }

  if (web.length) {
    lines.push(`*Web* — ${web.length} artículo${web.length === 1 ? '' : 's'}`);
    for (const w of web) {
      const domain = w.url ? new URL(w.url).hostname.replace(/^www\./, '') : '';
      lines.push(`- ${w.title}${domain ? ` — ${domain}` : ''}`);
    }
    lines.push('');
  }

  if (youtube.length) {
    lines.push(`*YouTube* — ${youtube.length} video${youtube.length === 1 ? '' : 's'}`);
    for (const y of youtube) {
      lines.push(`- ${y.title}${y.channel ? ` — ${y.channel}` : ''}`);
    }
    lines.push('');
  }

  if (email.length) {
    lines.push(`*Email* — ${email.length} newsletter${email.length === 1 ? '' : 's'}`);
    for (const e of email) {
      lines.push(`- ${e.title}${e.from ? ` — ${e.from}` : ''}`);
    }
    lines.push('');
  }

  if (pdf.length) {
    lines.push(`*PDF* — ${pdf.length} documento${pdf.length === 1 ? '' : 's'}`);
    for (const p of pdf) lines.push(`- ${p.title}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleDigest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get('since');
  const daysParam = url.searchParams.get('days');

  let sinceDate: Date;
  if (sinceParam) {
    sinceDate = new Date(sinceParam);
    if (isNaN(sinceDate.getTime())) {
      return corsResponse(400, { error: 'Invalid since (use ISO 8601 or YYYY-MM-DD)' });
    }
  } else {
    const days = daysParam ? Math.max(1, parseInt(daysParam, 10) || 1) : 1;
    sinceDate = new Date(Date.now() - days * 24 * 3600 * 1000);
  }

  const logFile = dataPath('.captures.jsonl');
  let entries: CaptureLogEntry[] = [];
  try {
    const text = await Bun.file(logFile).text();
    entries = text.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) as CaptureLogEntry; } catch { return null; }
    }).filter((e): e is CaptureLogEntry => e !== null);
  } catch {
    // No log yet — return empty digest
  }

  const filtered = entries.filter(e => {
    const t = new Date(e.capturedAt).getTime();
    return !isNaN(t) && t >= sinceDate.getTime();
  });

  // Collapse repeated captures of the same slug. For kindle, sum newHighlights.
  const bySlug = new Map<string, CaptureLogEntry>();
  for (const e of filtered) {
    const prev = bySlug.get(e.slug);
    if (!prev) {
      bySlug.set(e.slug, { ...e });
      continue;
    }
    if (e.type === 'kindle') {
      prev.newHighlights = (prev.newHighlights || 0) + (e.newHighlights || 0);
    }
    if (new Date(e.capturedAt) > new Date(prev.capturedAt)) {
      prev.capturedAt = e.capturedAt;
      prev.title = e.title;
    }
  }

  const items = Array.from(bySlug.values());
  const kindle = items.filter(i => i.type === 'kindle' && (i.newHighlights || 0) > 0);
  const web = items.filter(i => i.type === 'web');
  const youtube = items.filter(i => i.type === 'youtube');
  const email = items.filter(i => i.type === 'email');
  const pdf = items.filter(i => i.type === 'pdf');

  const markdown = formatDigestMarkdown({ since: sinceDate, kindle, web, youtube, email, pdf });

  return corsResponse(200, {
    since: sinceDate.toISOString(),
    count: items.length,
    items,
    markdown,
  });
}

async function handlePage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') || '';

  if (!slug.trim()) {
    return corsResponse(400, { error: 'Missing required parameter: slug' });
  }

  try {
    const output = await gbrainExec(['get', slug]);

    // Try to parse title from frontmatter
    let title = slug.split('/').pop()?.replace(/-/g, ' ') || slug;
    let type = 'unknown';
    const titleMatch = output.match(/^title:\s*"?(.+?)"?\s*$/m);
    if (titleMatch) title = titleMatch[1];
    const typeMatch = output.match(/^type:\s*(.+?)\s*$/m);
    if (typeMatch) type = typeMatch[1];

    return corsResponse(200, { slug, title, type, content: output });
  } catch (err: any) {
    console.error('[page]', err.message);
    return corsResponse(404, { error: 'Page not found' });
  }
}

// ---------------------------------------------------------------------------
// Title-aware retrieval boost
// ---------------------------------------------------------------------------
// Named-entity queries ("what did I highlight in Deep Work") under-rank the
// named source in pure semantic search — thematically-similar pages win and the
// page the user actually named gets buried. We surface any captured page whose
// title appears in the query AHEAD of the semantic results, so "what did I
// highlight in X" reliably returns X. Operates only over ClipBrain capture
// slugs, so it never promotes unrelated content.

const TITLE_MATCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'by', 'of', 'to', 'for', 'and', 'in', 'on', 'with', 'your',
  'my', 'our', 'how', 'what', 'did', 'i', 'about', 'from', 'de', 'la', 'el',
  'los', 'las', 'un', 'una', 'que', 'mi',
]);

export function titleTokensFromSlug(slug: string): string[] {
  // Drop the type prefix (kindle/web/youtube/...); deslugify the rest into tokens.
  const parts = slug.split('/').filter(Boolean);
  const tail = parts.slice(1).join(' ');
  return tail
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Score = length of the longest contiguous run of a slug's title tokens that
// appears as a whole phrase in the query (0 = no match). A run must carry real
// signal: >=2 non-stopword tokens, or a single non-stopword token >=6 chars.
export function titleMatchScore(query: string, slug: string): number {
  const qstr = ' ' + query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const tokens = titleTokensFromSlug(slug);
  let best = 0;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = tokens.length; j > i; j--) {
      const run = tokens.slice(i, j);
      const significant = run.filter((t) => !TITLE_MATCH_STOPWORDS.has(t));
      const meaningful = significant.length >= 2 || (significant.length === 1 && significant[0].length >= 6);
      if (!meaningful) continue;
      const phrase = run.join(' ');
      if (qstr.includes(' ' + phrase + ' ')) {
        best = Math.max(best, phrase.length);
        break; // longest run starting at i found
      }
    }
  }
  return best;
}

export function findTitleMatchedSlugs(query: string, slugs: string[]): string[] {
  return slugs
    .map((slug) => ({ slug, score: titleMatchScore(query, slug) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.slug);
}

async function handleContextPack(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
  const limit = clampNumber(parseInt(url.searchParams.get('limit') || '6', 10), 1, 10);

  if (!query) {
    return corsResponse(400, { error: 'Missing required parameter: q' });
  }

  try {
    const output = await gbrainExec(['query', query]);
    const results = parseGbrainOutput(output, limit * 2);
    const resultBySlug = new Map<string, { title?: string; snippet?: string }>();
    for (const r of results) {
      const s = r.slug?.trim();
      if (s && !resultBySlug.has(s)) resultBySlug.set(s, { title: r.title, snippet: r.snippet });
    }

    // Title-aware boost: surface captured pages the query names, ahead of semantic hits.
    let titleSlugs: string[] = [];
    try {
      const listOutput = await loadClipBrainListOutput(gbrainExec, 500);
      const captureSlugs = parseGbrainOutput(listOutput, 500)
        .map((i) => i.slug?.trim())
        .filter((s): s is string => !!s && isClipBrainCaptureSlug(s));
      titleSlugs = findTitleMatchedSlugs(query, captureSlugs);
    } catch (err: any) {
      console.warn(`[context-pack] title-match skipped: ${err.message}`);
    }

    const orderedSlugs = [
      ...titleSlugs,
      ...results.map((r) => r.slug?.trim()).filter((s): s is string => !!s),
    ];

    const sources: ContextPackSource[] = [];
    const seen = new Set<string>();
    const fetchLimit = limit * 2;

    for (const slug of orderedSlugs) {
      if (seen.has(slug)) continue;
      seen.add(slug);

      try {
        const content = await gbrainExec(['get', slug]);
        const hint = resultBySlug.get(slug);
        sources.push(parseContextPackSource({
          slug,
          content,
          fallbackTitle: hint?.title,
          snippet: hint?.snippet,
          index: sources.length + 1,
        }));
      } catch (err: any) {
        console.warn(`[context-pack] skipped ${slug}: ${err.message}`);
      }

      if (sources.length >= fetchLimit) break;
    }

    const pack = buildContextPack(query, selectContextPackSources(sources, limit));
    return corsResponse(200, pack);
  } catch (err: any) {
    console.error('[context-pack]', err.message);
    return corsResponse(500, { error: 'Failed to build context pack' });
  }
}

export function buildContextPack(query: string, sources: ContextPackSource[]): ContextPack {
  const generatedAt = new Date().toISOString();

  return {
    query,
    generatedAt,
    sources,
    markdown: formatContextPackMarkdown(query, sources, generatedAt),
  };
}

export function selectContextPackSources(sources: ContextPackSource[], limit: number): ContextPackSource[] {
  const selected: ContextPackSource[] = [];
  const keyToIndex = new Map<string, number>();

  for (const source of sources) {
    const key = normalizeContextPackTitle(source.title) || source.slug;
    const existingIndex = keyToIndex.get(key);

    if (existingIndex === undefined) {
      keyToIndex.set(key, selected.length);
      selected.push(source);
      continue;
    }

    const existing = selected[existingIndex];
    if (contextPackSourceScore(source) > contextPackSourceScore(existing)) {
      selected[existingIndex] = source;
    }
  }

  return selected.slice(0, limit).map((source, index) => ({
    ...source,
    id: `S${index + 1}`,
  }));
}

export function parseContextPackSource(opts: {
  slug: string;
  content: string;
  fallbackTitle?: string;
  snippet?: string;
  index?: number;
}): ContextPackSource {
  const frontmatter = parseSimpleFrontmatter(opts.content);
  const title = frontmatter.title || opts.fallbackTitle || opts.slug.split('/').pop()?.replace(/-/g, ' ') || opts.slug;
  const type = frontmatter.type || detectCaptureType(opts.slug);
  const summary = parseMarkdownSection(opts.content, 'Summary');
  const tags = parseMarkdownTags(opts.content);
  const atoms = parseKnowledgeAtoms(opts.content);
  const sourceUrl = frontmatter.source_url || frontmatter.source;
  const snippet = cleanContextSnippet(opts.snippet || firstMeaningfulBodyText(opts.content));

  return {
    id: `S${opts.index || 1}`,
    slug: opts.slug,
    title,
    type,
    summary,
    tags,
    atoms,
    snippet,
    sourceUrl,
  };
}

export function formatContextPackMarkdown(query: string, sources: ContextPackSource[], generatedAt = new Date().toISOString()): string {
  const lines: string[] = [
    `# Context Pack: ${query}`,
    '',
    `Generated: ${generatedAt}`,
    '',
  ];

  if (sources.length === 0) {
    lines.push('No relevant sources found.');
    return lines.join('\n');
  }

  lines.push('## Use This Context');
  lines.push('');
  lines.push('- Prefer cited claims over uncited inference.');
  lines.push('- Cite sources by their `[S#]` labels when answering.');
  lines.push('- Treat snippets as retrieval hints, not full evidence.');
  lines.push('');

  lines.push('## Sources');
  lines.push('');
  for (const source of sources) {
    const meta = [source.type, source.slug].filter(Boolean).join(' | ');
    lines.push(`- [${source.id}] ${source.title}${meta ? ` - ${meta}` : ''}`);
  }
  lines.push('');

  for (const source of sources) {
    lines.push(`## [${source.id}] ${source.title}`);
    lines.push('');
    lines.push(`Slug: \`${source.slug}\``);
    if (source.sourceUrl) lines.push(`Source: ${source.sourceUrl}`);
    if (source.tags.length > 0) lines.push(`Tags: ${source.tags.join(', ')}`);

    if (source.snippet) {
      lines.push('');
      lines.push('Retrieval snippet:');
      lines.push(source.snippet);
    }

    if (source.summary) {
      lines.push('');
      lines.push('Summary:');
      lines.push(source.summary);
    }

    if (source.atoms.claims.length > 0) {
      lines.push('');
      lines.push('Claims:');
      for (const claim of source.atoms.claims.slice(0, 5)) {
        lines.push(`- ${claim}`);
      }
    }

    if (source.atoms.quotes.length > 0) {
      lines.push('');
      lines.push('Quotes:');
      for (const quote of source.atoms.quotes.slice(0, 3)) {
        lines.push(`> ${quote}`);
      }
    }

    if (source.atoms.entities.length > 0) {
      lines.push('');
      lines.push('Entities:');
      for (const entity of source.atoms.entities.slice(0, 5)) {
        lines.push(`- ${formatContextPackEntity(entity)}`);
      }
    }

    if (source.atoms.questions.length > 0) {
      lines.push('');
      lines.push('Open questions:');
      for (const question of source.atoms.questions.slice(0, 3)) {
        lines.push(`- ${question}`);
      }
    }

    if (source.atoms.actions.length > 0) {
      lines.push('');
      lines.push('Possible actions:');
      for (const action of source.atoms.actions.slice(0, 3)) {
        lines.push(`- ${action}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function parseSimpleFrontmatter(markdown: string): Record<string, string> {
  const frontmatter: Record<string, string> = {};
  if (!markdown.startsWith('---\n')) return frontmatter;

  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return frontmatter;

  const lines = markdown.slice(4, end).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z_][\w_]*):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();

    if (isYamlBlockScalar(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      frontmatter[match[1]] = cleanFrontmatterValue(block.join(' '));
      continue;
    }

    frontmatter[match[1]] = cleanFrontmatterValue(value);
  }

  return frontmatter;
}

function parseMarkdownSection(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`## ${escaped}\\s*\\n\\n?([\\s\\S]*?)(?=\\n## |\\n---\\n|$)`));
  return match ? match[1].trim() : '';
}

function parseMarkdownTags(content: string): string[] {
  const tags: string[] = [];
  const tagLines = content.match(/^tags:\s*\n((?:\s+-\s+.+\n)*)/m);
  if (tagLines) {
    const matches = tagLines[1].matchAll(/^\s+-\s+(.+)$/gm);
    for (const m of matches) tags.push(cleanMarkdownTag(m[1]));
    return tags.filter(Boolean).slice(0, 8);
  }

  const inlineTags = content.match(/^tags:\s*\[(.*)\]\s*$/m);
  if (!inlineTags) return [];
  return inlineTags[1].split(',').map(cleanMarkdownTag).filter(Boolean).slice(0, 8);
}

function firstMeaningfulBodyText(markdown: string): string {
  let withoutFrontmatter = markdown;
  if (markdown.startsWith('---\n')) {
    const end = markdown.indexOf('\n---', 4);
    if (end !== -1) withoutFrontmatter = markdown.slice(end + 4);
  }

  return withoutFrontmatter
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('tags:'))
    .slice(0, 5)
    .join(' ');
}

function cleanContextSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeContextPackTitle(title: string): string {
  return title.toLowerCase().replace(/['"`]+/g, '').replace(/\s+/g, ' ').trim();
}

function contextPackSourceScore(source: ContextPackSource): number {
  return (source.summary ? 3 : 0) +
    (source.snippet ? 1 : 0) +
    source.atoms.claims.length * 4 +
    source.atoms.quotes.length * 3 +
    source.atoms.entities.length * 2 +
    source.atoms.questions.length +
    source.atoms.actions.length;
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

function formatContextPackEntity(entity: ContextPackAtoms['entities'][number]): string {
  const type = entity.type ? ` (${entity.type})` : '';
  const relevance = entity.relevance ? ` - ${entity.relevance}` : '';
  return `${entity.name}${type}${relevance}`;
}

function cleanMarkdownTag(tag: string): string {
  return tag.trim().replace(/^['"]|['"]$/g, '');
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseGbrainOutput(output: string, limit: number): Array<Record<string, string>> {
  const lines = output.trim().split('\n').filter(Boolean);
  const results: Array<Record<string, string>> = [];

  for (const line of lines) {
    if (results.length >= limit) break;

    // gbrain list format: slug \t type \t date \t title
    // gbrain query format: [score] slug -- snippet
    const parts = line.split('\t');
    const item: Record<string, string> = {};

    if (parts.length >= 4) {
      // gbrain list output: slug, type, date, title
      item.slug = parts[0].trim();
      item.type = parts[1].trim();
      item.date = parts[2].trim();
      item.title = parts[3].trim();
    } else if (parts.length >= 2) {
      item.slug = parts[0].trim();
      item.type = parts[1].trim();
      item.title = parts[parts.length - 1].trim();
      if (parts[2]) item.date = parts[2].trim();
    } else if (line.includes(' -- ')) {
      // gbrain query output: [score] slug -- snippet
      const [left, ...right] = line.split(' -- ');
      const scoreMatch = left.match(/\[[\d.]+\]\s*(.*)/);
      item.slug = scoreMatch ? scoreMatch[1].trim() : left.trim();
      item.title = item.slug.split('/').pop()?.replace(/-/g, ' ') || item.slug;
      item.snippet = right.join(' -- ').trim();
    } else {
      // Single value — treat as slug
      item.slug = line.trim();
      item.title = line.trim().split('/').pop()?.replace(/-/g, ' ') || line.trim();
    }

    results.push(item);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Obsidian vault sync
// ---------------------------------------------------------------------------

async function obsidianSync(slug: string, markdown: string) {
  try {
    const configFile = dataPath('.clipbrain.json');
    const config = JSON.parse(await Bun.file(configFile).text());

    if (!config.obsidian?.enabled || !config.obsidian?.vaultPath) return;

    const vaultPath = config.obsidian.vaultPath;
    const folder = config.obsidian.folder || 'ClipBrain';

    // Extract title from markdown frontmatter
    const titleMatch = markdown.match(/^title:\s*"?(.+?)"?\s*$/m);
    const title = titleMatch ? titleMatch[1] : slug.split('/').pop()?.replace(/-/g, ' ') || slug;

    // Guard against empty/junk titles that would create files like "--.md"
    if (!title || title.replace(/[\s\-]+/g, '').length === 0) {
      console.warn(`[obsidian] skipping sync for "${slug}" — empty or invalid title`);
      return;
    }

    // Determine subfolder (kindle, web, pdf, or youtube)
    const subfolder = slug.startsWith('kindle/') ? 'kindle' : slug.startsWith('pdf/') ? 'pdf' : slug.startsWith('youtube/') ? 'youtube' : slug.startsWith('email/') ? 'email' : 'web';

    // Clean filename: replace colons with " -", remove illegal chars, normalize whitespace
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

    // Create directory if needed
    const fs = require('fs');
    fs.mkdirSync(dirPath, { recursive: true });

    // Write the file
    await Bun.write(filePath, markdown);
    console.log(`[obsidian] synced ${filePath}`);
  } catch (err: any) {
    // Don't fail the capture if obsidian sync fails
    console.warn(`[obsidian] sync failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Config API
// ---------------------------------------------------------------------------

async function handleGetConfig(): Promise<Response> {
  try {
    const configFile = dataPath('.clipbrain.json');
    const config = JSON.parse(await Bun.file(configFile).text());
    return corsResponse(200, config);
  } catch {
    return corsResponse(200, { obsidian: { enabled: false, vaultPath: '', folder: 'ClipBrain' } });
  }
}

async function handlePostConfig(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return corsResponse(400, { error: 'Invalid JSON body' });
  }

  try {
    const configFile = dataPath('.clipbrain.json');
    await Bun.write(configFile, JSON.stringify(body, null, 2) + '\n');
    return corsResponse(200, { status: 'saved' });
  } catch (err: any) {
    return corsResponse(500, { error: err.message });
  }
}

async function handleObsidianSyncAll(): Promise<Response> {
  try {
    const configFile = dataPath('.clipbrain.json');
    const config = JSON.parse(await Bun.file(configFile).text());

    if (!config.obsidian?.enabled || !config.obsidian?.vaultPath) {
      return corsResponse(400, { error: 'Obsidian sync not enabled' });
    }

    const items = await loadClipBrainListItems(gbrainExec, 10000);

    let synced = 0;
    let failed = 0;

    for (const item of items) {
      const slug = item.slug;
      if (!slug || !isClipBrainCaptureSlug(slug)) continue;

      try {
        const content = await gbrainExec(['get', slug]);
        await obsidianSync(slug, content);
        synced++;
      } catch {
        failed++;
      }
    }

    return corsResponse(200, { status: 'done', synced, failed });
  } catch (err: any) {
    return corsResponse(500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// PDF upload
// ---------------------------------------------------------------------------

async function handleUploadPdfGet(): Promise<Response> {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Upload PDF — ClipBrain</title>
<style>body{background:#1e1e1e;color:#dcddde;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.box{background:#262626;border:1px solid #333;border-radius:12px;padding:32px;max-width:400px;width:90%;text-align:center;}
h2{font-size:18px;margin-bottom:8px;}p{color:#999;font-size:13px;margin-bottom:20px;}
input[type=file]{margin-bottom:16px;}
button{background:#7f6df2;color:#fff;border:none;border-radius:6px;padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer;}
button:disabled{opacity:0.5;}
.msg{margin-top:12px;font-size:13px;}</style></head>
<body><div class="box"><h2>Upload PDF</h2><p>Select a PDF to import into your knowledge base.</p>
<form id="f" enctype="multipart/form-data"><input type="file" name="file" accept=".pdf,application/pdf" required><br>
<button type="submit">Upload</button></form><div class="msg" id="msg"></div>
<script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.target);const btn=e.target.querySelector('button');btn.disabled=true;btn.textContent='Uploading...';const msg=document.getElementById('msg');try{const r=await fetch('/api/upload-pdf',{method:'POST',body:fd});const d=await r.json();if(r.ok){msg.style.color='#4ade80';msg.textContent='Imported: '+d.title+' ('+d.pages+' pages)';}else{msg.style.color='#ef4444';msg.textContent=d.error||'Upload failed';}}catch(err){msg.style.color='#ef4444';msg.textContent='Error: '+err.message;}btn.disabled=false;btn.textContent='Upload';});</script></div></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

async function handleUploadPdf(req: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return corsResponse(400, { error: 'Invalid multipart/form-data' });
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return corsResponse(400, { error: 'Missing file field' });
  }

  // Check file type
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    return corsResponse(400, { error: 'File must be a PDF' });
  }

  // Check file size
  if (file.size > MAX_PDF_SIZE) {
    return corsResponse(413, { error: 'File too large. Maximum size is 50MB.' });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let extractedText = '';
  let pages = 0;
  try {
    const parser = new PDFParse({ data: buffer });
    const textResult = await parser.getText();
    extractedText = (textResult.text || '').trim();
    pages = textResult.total || textResult.pages?.length || 0;
    await parser.destroy();
  } catch (err: any) {
    return corsResponse(422, { error: 'Failed to parse PDF: ' + (err.message || 'unknown error') });
  }

  // Handle scanned/image-only PDFs
  if (!extractedText) {
    return corsResponse(422, {
      error: 'This PDF appears to be scanned/image-only. Text extraction is not supported for scanned PDFs.',
    });
  }

  // Generate slug from filename
  const rawName = file.name.replace(/\.pdf$/i, '');
  const slug = `pdf/${slugifyText(rawName)}`;
  const title = rawName;
  const timestamp = new Date().toISOString();

  const markdown = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    'type: reference',
    'tags: [pdf, clipbrain-capture]',
    'source: pdf-upload',
    `captured_at: ${timestamp}`,
    `pages: ${pages}`,
    '---',
    '',
    extractedText,
  ].join('\n') + '\n';

  try {
    await gbrainPut(slug, markdown);
    await recordCapture({ slug, type: 'pdf', title, capturedAt: timestamp });
  } catch (err: any) {
    console.error(`[gbrain put] error:`, err);
    return corsResponse(500, { error: 'Failed to save PDF to gbrain' });
  }

  // Obsidian sync (fire and forget)
  obsidianSync(slug, markdown);

  // Track in highlight counts (use 1 per PDF as a "capture" count)
  updateHighlightCount(slug, 1);

  // AI post-processing (background, never blocks)
  postProcess(slug, markdown).catch(err => {
    console.warn('[post-process] failed:', err.message);
  });

  return corsResponse(202, { status: 'accepted', slug, title, pages });
}

// ---------------------------------------------------------------------------
// Connections endpoint
// ---------------------------------------------------------------------------

async function handleConnections(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') || '';

  if (!slug.trim()) {
    return corsResponse(400, { error: 'Missing required parameter: slug' });
  }

  try {
    const content = await gbrainExec(['get', slug]);

    // Parse from the markdown body sections (not YAML frontmatter, which has multiline issues)
    // The post-processor writes: ## Summary\n\ntext\n\n## Related\n\n- [[Title]] — reason

    // Extract summary from ## Summary section
    let summary = '';
    const summarySection = content.match(/## Summary\s*\n\n([\s\S]*?)(?=\n## |\n---\n|$)/);
    if (summarySection) {
      summary = summarySection[1].trim();
    }

    const atoms = parseKnowledgeAtoms(content);

    // Extract tags from frontmatter (YAML list format)
    const tags: string[] = [];
    const tagLines = content.match(/^tags:\s*\n((?:\s+-\s+.+\n)*)/m);
    if (tagLines) {
      const matches = tagLines[1].matchAll(/^\s+-\s+(.+)$/gm);
      for (const m of matches) tags.push(m[1].trim());
    } else {
      // Try inline format: tags: [a, b, c]
      const inlineTags = content.match(/^tags:\s*\[(.+)\]\s*$/m);
      if (inlineTags) {
        tags.push(...inlineTags[1].split(',').map(t => t.trim()));
      }
    }

    // Extract connections from ## Related section
    // Format: - [[Title]] — reason
    const connections: Array<{ slug: string; title: string; reason: string }> = [];
    const relatedSection = content.match(/## Related\s*\n\n([\s\S]*?)(?=\n## |\n---\n|$)/);
    if (relatedSection) {
      const lines = relatedSection[1].trim().split('\n');
      for (const line of lines) {
        const match = line.match(/^-\s+\[\[(.+?)\]\]\s*[—–-]\s*(.+)$/);
        if (match) {
          const title = match[1].trim();
          const reason = match[2].trim();
          // Try to find the slug for this title in our known items
          const foundSlug = findSlugByTitle(title) || '';
          connections.push({ slug: foundSlug, title, reason });
        }
      }
    }

    return corsResponse(200, { slug, summary, tags, atoms, connections });
  } catch (err: any) {
    console.error('[connections]', err.message);
    return corsResponse(404, { error: 'Page not found' });
  }
}

export function parseKnowledgeAtoms(content: string): {
  claims: string[];
  quotes: string[];
  entities: Array<{ name: string; type: string; relevance: string }>;
  questions: string[];
  actions: string[];
} {
  const atoms = {
    claims: [] as string[],
    quotes: [] as string[],
    entities: [] as Array<{ name: string; type: string; relevance: string }>,
    questions: [] as string[],
    actions: [] as string[],
  };

  const section = content.match(/## Knowledge Atoms\s*\n([\s\S]*?)(?=\n## |\n---\n|$)/);
  if (!section) return atoms;

  atoms.claims = parseBulletSubsection(section[1], 'Claims');
  atoms.quotes = parseQuoteSubsection(section[1], 'Quotes');
  atoms.questions = parseBulletSubsection(section[1], 'Open Questions');
  atoms.actions = parseBulletSubsection(section[1], 'Actions').map(action => action.replace(/^\[ \]\s*/, '').trim());

  const entitiesSection = extractSubsection(section[1], 'Entities');
  if (entitiesSection) {
    for (const line of entitiesSection.split('\n')) {
      const match = line.match(/^-\s+\*\*(.+?)\*\*\s+\((.+?)\)(?:\s+-\s+(.+))?$/);
      if (!match) continue;
      atoms.entities.push({
        name: match[1].trim(),
        type: match[2].trim(),
        relevance: (match[3] || '').trim(),
      });
    }
  }

  return atoms;
}

function parseBulletSubsection(content: string, heading: string): string[] {
  const section = extractSubsection(content, heading);
  if (!section) return [];
  return section
    .split('\n')
    .map(line => line.match(/^-\s+(.+)$/)?.[1]?.trim() || '')
    .filter(Boolean);
}

function parseQuoteSubsection(content: string, heading: string): string[] {
  const section = extractSubsection(content, heading);
  if (!section) return [];
  return section
    .split('\n')
    .map(line => line.match(/^>\s+(.+)$/)?.[1]?.trim() || '')
    .filter(Boolean);
}

function extractSubsection(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`### ${escaped}\\s*\\n\\n?([\\s\\S]*?)(?=\\n### |\\n## |\\n---\\n|$)`));
  return match ? match[1].trim() : '';
}

// Helper: find slug by title (best effort, searches cached items)
function findSlugByTitle(title: string): string {
  // This is a simple lookup; in production you'd cache the list
  return ''; // Graph View will resolve this properly
}

// ---------------------------------------------------------------------------
// Graph endpoint (cached for 5 minutes)
// ---------------------------------------------------------------------------

let graphCache: { data: any; ts: number } | null = null;
const GRAPH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function handleGraph(): Promise<Response> {
  // Return cached result if fresh
  if (graphCache && Date.now() - graphCache.ts < GRAPH_CACHE_TTL) {
    return corsResponse(200, graphCache.data);
  }

  try {
    // Get all items
    const output = await loadClipBrainListOutput(gbrainExec, 1000);
    const items = parseGbrainOutput(output, 1000);

    const captures = items.filter(i => isClipBrainCaptureSlug(i.slug || ''));

    // Build nodes
    const nodes = captures.map(item => ({
      id: item.slug,
      title: item.title || item.slug,
      type: item.slug.startsWith('kindle/') ? 'kindle' :
            item.slug.startsWith('pdf/') ? 'pdf' :
            item.slug.startsWith('youtube/') ? 'youtube' :
            item.slug.startsWith('email/') ? 'email' : 'web',
      size: item.slug.startsWith('kindle/') ? 8 : item.slug.startsWith('youtube/') ? 7 : item.slug.startsWith('email/') ? 6 : 5,
    }));

    // Build edges from connections
    const edges: Array<{source: string; target: string; reason: string}> = [];

    for (const item of captures) {
      try {
        const content = await gbrainExec(['get', item.slug]);

        // Parse ## Related section for connections
        const relatedSection = content.match(/## Related\s*\n\n([\s\S]*?)(?=\n## |\n---\n|$)/);
        if (relatedSection) {
          const lines = relatedSection[1].trim().split('\n');
          for (const line of lines) {
            const match = line.match(/^-\s+\[\[(.+?)\]\]/);
            if (match) {
              const targetTitle = match[1].trim().toLowerCase();
              const targetNode = nodes.find(n =>
                n.title.toLowerCase().includes(targetTitle) ||
                targetTitle.includes(n.title.toLowerCase().split(' by ')[0].trim())
              );
              if (targetNode && targetNode.id !== item.slug) {
                const reasonMatch = line.match(/[—–-]\s*(.+)$/);
                edges.push({
                  source: item.slug,
                  target: targetNode.id,
                  reason: reasonMatch ? reasonMatch[1].trim() : '',
                });
              }
            }
          }
        }

        // Parse tags for tag-based clustering
        const tagLines = content.match(/^tags:\s*\n((?:\s+-\s+.+\n)*)/m);
        if (tagLines) {
          const nodeTags: string[] = [];
          const matches = tagLines[1].matchAll(/^\s+-\s+(.+)$/gm);
          for (const m of matches) nodeTags.push(m[1].trim());
          const node = nodes.find(n => n.id === item.slug);
          if (node) (node as any).tags = nodeTags;
        } else {
          // Try inline format: tags: [a, b, c]
          const inlineTags = content.match(/^tags:\s*\[(.+)\]\s*$/m);
          if (inlineTags) {
            const node = nodes.find(n => n.id === item.slug);
            if (node) (node as any).tags = inlineTags[1].split(',').map((t: string) => t.trim());
          }
        }
      } catch {
        // Skip items that can't be read
      }
    }

    // Add tag-based edges: items sharing 2+ tags get a weaker connection
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const tagsA = (nodes[i] as any).tags || [];
        const tagsB = (nodes[j] as any).tags || [];
        const shared = tagsA.filter((t: string) => tagsB.includes(t));
        if (shared.length >= 2) {
          const exists = edges.some(e =>
            (e.source === nodes[i].id && e.target === nodes[j].id) ||
            (e.source === nodes[j].id && e.target === nodes[i].id)
          );
          if (!exists) {
            edges.push({
              source: nodes[i].id,
              target: nodes[j].id,
              reason: `Shared tags: ${shared.join(', ')}`,
            });
          }
        }
      }
    }

    const result = { nodes, edges };
    graphCache = { data: result, ts: Date.now() };
    return corsResponse(200, result);
  } catch (err: any) {
    console.error('[graph]', err.message);
    return corsResponse(200, { nodes: [], edges: [] });
  }
}

// ---------------------------------------------------------------------------
// Reprocess all endpoint
// ---------------------------------------------------------------------------

type ReprocessParams = {
  dryRun: boolean;
  force: boolean;
  sync: boolean;
  limit: number;
  exactSlug: string;
  type: string;
  slugPrefix: string;
};

async function parseReprocessParams(req: Request, url: URL): Promise<ReprocessParams> {
  let body: Record<string, any> = {};
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
    } catch {
      body = {};
    }
  }

  const param = (queryName: string, ...bodyNames: string[]) => {
    const fromQuery = url.searchParams.get(queryName);
    if (fromQuery !== null) return fromQuery;
    for (const name of bodyNames) {
      const value = body[name];
      if (value !== undefined && value !== null) return String(value);
    }
    return '';
  };

  return {
    dryRun: parseBooleanParam(param('dry_run', 'dry_run', 'dryRun')),
    force: parseBooleanParam(param('force', 'force')),
    sync: parseBooleanParam(param('sync', 'sync', 'await_processing', 'awaitProcessing')),
    limit: clampNumber(parseInt(param('limit', 'limit') || '10', 10), 1, 100),
    exactSlug: param('slug', 'slug').trim(),
    type: param('type', 'type').trim().toLowerCase(),
    slugPrefix: param('slug_prefix', 'slug_prefix', 'slugPrefix').trim(),
  };
}

function parseBooleanParam(value: string): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

async function listPagesForReprocess(): Promise<string> {
  return loadClipBrainListOutput(gbrainExec, 10000);
}

async function handleReprocessAll(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { dryRun, force, sync, limit, exactSlug, type, slugPrefix } = await parseReprocessParams(req, url);
  const allowedTypes = new Set(['kindle', 'web', 'pdf', 'youtube', 'email']);

  if (exactSlug && !['kindle/', 'web/', 'pdf/', 'youtube/', 'email/'].some(prefix => exactSlug.startsWith(prefix))) {
    return corsResponse(400, { error: 'slug must start with kindle/, web/, pdf/, youtube/, or email/' });
  }

  if (type && !allowedTypes.has(type)) {
    return corsResponse(400, { error: 'type must be one of: kindle, web, pdf, youtube, email' });
  }

  if (slugPrefix && !['kindle/', 'web/', 'pdf/', 'youtube/', 'email/'].some(prefix => slugPrefix.startsWith(prefix))) {
    return corsResponse(400, { error: 'slug_prefix must start with kindle/, web/, pdf/, youtube/, or email/' });
  }

  if (!dryRun && !process.env.OPENAI_API_KEY) {
    return corsResponse(400, { error: 'OPENAI_API_KEY not set. Enable smart processing by setting this environment variable.' });
  }

  try {
    const output = await listPagesForReprocess();
    const lines = output.trim().split('\n').filter(Boolean);

    const candidates: Array<{ slug: string; title: string; type: string; reason: string }> = [];
    let scanned = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      const slug = parts[0]?.trim();
      if (!slug || (!slug.startsWith('kindle/') && !slug.startsWith('web/') && !slug.startsWith('pdf/') && !slug.startsWith('youtube/') && !slug.startsWith('email/'))) continue;
      if (exactSlug && slug !== exactSlug) continue;
      if (type && !slug.startsWith(`${type}/`)) continue;
      if (slugPrefix && !slug.startsWith(slugPrefix)) continue;

      scanned++;

      try {
        const content = await gbrainExec(['get', slug]);
        const reason = getBackfillReason(content, force);
        if (!reason) {
          skipped++;
          continue;
        }

        const candidate = {
          slug,
          title: parts[3]?.trim() || slug.split('/').pop()?.replace(/-/g, ' ') || slug,
          type: parts[1]?.trim() || slug.split('/')[0] || 'unknown',
          reason,
        };
        candidates.push(candidate);

        if (!dryRun) {
          if (sync) {
            try {
              await postProcess(slug, content, true);
              processed++;
            } catch (err: any) {
              failed++;
              console.warn(`[reprocess-all] failed for ${slug}:`, err.message);
            }
          } else {
            postProcess(slug, content, true).catch(err => {
              console.warn(`[reprocess-all] failed for ${slug}:`, err.message);
            });
          }
        }
      } catch (err: any) {
        failed++;
        console.warn(`[reprocess-all] skipped ${slug}:`, err.message);
      }

      if (candidates.length >= limit) break;
    }

    return corsResponse(dryRun || sync ? 200 : 202, {
      status: dryRun ? 'dry_run' : sync ? 'completed' : 'started',
      compilerVersion: KNOWLEDGE_COMPILER_VERSION,
      queued: dryRun ? 0 : candidates.length,
      processed,
      scanned,
      skipped,
      failed,
      limit,
      force,
      sync,
      candidates,
    });
  } catch (err: any) {
    return corsResponse(500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// YouTube transcript
// ---------------------------------------------------------------------------

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function handleCaptureYouTube(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return corsResponse(400, { error: 'Invalid JSON body' });
  }

  const { url, videoId, title, channel } = body;

  if (!videoId || typeof videoId !== 'string') {
    return corsResponse(400, { error: 'Missing required field: videoId' });
  }
  if (!title || typeof title !== 'string') {
    return corsResponse(400, { error: 'Missing required field: title' });
  }

  // Check if yt-dlp is available before attempting extraction
  if (!ytDlpAvailable) {
    // Re-check in case it was installed after server start
    ytDlpAvailable = await checkYtDlp();
    if (!ytDlpAvailable) {
      return corsResponse(422, { error: 'yt-dlp is not installed. Run: brew install yt-dlp' });
    }
  }

  // Extract transcript server-side via yt-dlp (robust, handles auth/tokens)
  let transcript: Array<{ start: number; text: string }> = [];
  try {
    const tmpFile = `/tmp/clipbrain-yt-${videoId}`;
    const proc = Bun.spawn(
      [ytDlpCommand, '--write-auto-sub', '--sub-lang', 'en', '--skip-download', '--sub-format', 'json3', '-o', tmpFile, `https://www.youtube.com/watch?v=${videoId}`],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error('[youtube] yt-dlp failed:', stderr.slice(0, 200));
      return corsResponse(422, { error: 'No transcript available for this video' });
    }

    const subFile = `${tmpFile}.en.json3`;
    const fs = require('fs');
    if (!fs.existsSync(subFile)) {
      return corsResponse(422, { error: 'No transcript available for this video' });
    }

    const subData = JSON.parse(fs.readFileSync(subFile, 'utf-8'));
    transcript = (subData.events || [])
      .filter((e: any) => e.segs)
      .map((e: any) => ({
        start: Math.floor((e.tStartMs || 0) / 1000),
        text: (e.segs || []).map((s: any) => s.utf8 || '').join('').trim(),
      }))
      .filter((s: any) => s.text);

    // Cleanup temp files
    try { fs.unlinkSync(subFile); } catch {}

    console.log(`[youtube] extracted ${transcript.length} segments via yt-dlp`);
  } catch (err: any) {
    console.error('[youtube] yt-dlp error:', err.message);
    return corsResponse(422, { error: 'Failed to extract transcript' });
  }

  if (transcript.length === 0) {
    return corsResponse(422, { error: 'No transcript available for this video' });
  }

  const channelSlug = channel ? slugifyText(channel) : 'unknown-channel';
  const titleSlug = slugifyText(title);
  const slug = `youtube/${channelSlug}/${titleSlug}`;
  const timestamp = new Date().toISOString();

  const lastSegment = transcript[transcript.length - 1];
  const duration = lastSegment ? lastSegment.start : 0;

  const transcriptLines = transcript.map(
    (s: { start: number; text: string }) => `[${formatTimestamp(s.start)}] ${s.text}`
  );

  const channelTag = channelSlug.replace(/-+/g, '-');
  const markdown = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    'type: reference',
    `tags: [youtube, ${channelTag}]`,
    `source_url: https://youtube.com/watch?v=${videoId}`,
    `channel: "${(channel || '').replace(/"/g, '\\"')}"`,
    `captured_at: ${timestamp}`,
    '---',
    '',
    '## Transcript',
    '',
    ...transcriptLines,
    '',
  ].join('\n');

  try {
    await gbrainPut(slug, markdown);
    await recordCapture({
      slug,
      type: 'youtube',
      title,
      capturedAt: timestamp,
      url: `https://youtube.com/watch?v=${videoId}`,
      channel: channel || undefined,
    });
  } catch (err: any) {
    console.error(`[gbrain put] error:`, err);
    return corsResponse(500, { error: 'Failed to save YouTube transcript to gbrain' });
  }

  // Obsidian sync
  obsidianSync(slug, markdown);

  postProcess(slug, markdown).catch(err => {
    console.warn('[post-process] failed:', err.message);
  });

  return corsResponse(202, { status: 'accepted', slug, title, duration });
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

async function handleCapture(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return corsResponse(400, { error: 'Invalid JSON body' });
  }

  const { url, title, content, selection, capturedAt, emailFrom, emailDate, emailSubject } = body;

  if (!url || typeof url !== 'string') {
    return corsResponse(400, { error: 'Missing required field: url' });
  }
  if (!title || typeof title !== 'string') {
    return corsResponse(400, { error: 'Missing required field: title' });
  }

  let canonical: string;
  if (url.startsWith('kindle://') || url.startsWith('gmail://')) {
    canonical = url; // internal URLs don't need canonicalization
  } else {
    try {
      canonical = canonicalizeUrl(url);
    } catch {
      return corsResponse(400, { error: 'Invalid URL' });
    }
  }

  const isKindle = canonical.startsWith('kindle://');
  const isGmail = canonical.startsWith('gmail://');
  const domain = isKindle ? 'kindle' : isGmail ? 'gmail' : new URL(canonical).hostname;
  const slug = slugFromUrl(canonical, title);

  const markdown = isGmail
    ? buildEmailMarkdown({
        title,
        subject: emailSubject || title,
        from: emailFrom || '',
        date: emailDate || '',
        content: content || '',
        capturedAt,
      })
    : buildMarkdown({
        title,
        canonicalUrl: canonical,
        domain,
        content: content || '',
        selection: selection || null,
        capturedAt,
      });

  try {
    await gbrainPut(slug, markdown);

    // Track highlight count for kindle imports, record digest entry
    let newHighlights: number | undefined;
    if (slug.startsWith('kindle/')) {
      const hlCount = (markdown.match(/^> /gm) || []).length;
      if (hlCount > 0) newHighlights = await updateHighlightCount(slug, hlCount);
    }

    const type = detectCaptureType(slug);
    const author = type === 'kindle' ? slug.split('/')[1]?.replace(/-/g, ' ') : undefined;
    await recordCapture({
      slug,
      type,
      title,
      capturedAt: capturedAt || new Date().toISOString(),
      newHighlights,
      url: isKindle || isGmail ? undefined : canonical,
      author,
      from: isGmail ? emailFrom : undefined,
    });

  } catch (err: any) {
    console.error(`[gbrain put] error:`, err);
    return corsResponse(500, { error: 'Failed to save capture to gbrain' });
  }

  // Obsidian sync (parallel, independent of gbrainPut)
  obsidianSync(slug, markdown);

  // AI post-processing (background, never blocks)
  postProcess(slug, markdown).catch(err => {
    console.warn('[post-process] failed:', err.message);
  });

  return corsResponse(202, { status: 'accepted', slug });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function parsePort(args: string[]): number {
  const idx = args.indexOf('--port');
  if (idx !== -1 && args[idx + 1]) {
    const p = Number(args[idx + 1]);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  const env = process.env.GBRAIN_CAPTURE_PORT;
  if (env) {
    const p = Number(env);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  return DEFAULT_PORT;
}

function parseHost(args: string[]): string {
  const idx = args.indexOf('--host');
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return process.env.GBRAIN_CAPTURE_HOST || DEFAULT_HOST;
}

// ---------------------------------------------------------------------------
// yt-dlp availability check
// ---------------------------------------------------------------------------

let ytDlpAvailable = false;
let ytDlpCommand = 'yt-dlp';

async function checkYtDlp(): Promise<boolean> {
  const candidates = [
    process.env.YT_DLP_BIN,
    'yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
  ].filter(Boolean) as string[];

  try {
    const fs = require('fs');
    for (const candidate of candidates) {
      if (candidate.includes('/')) {
        if (fs.existsSync(candidate)) {
          ytDlpCommand = candidate;
          return true;
        }
        continue;
      }

      const proc = Bun.spawn(['which', candidate], { stdout: 'pipe', stderr: 'pipe' });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const stdout = await new Response(proc.stdout).text();
        ytDlpCommand = stdout.trim() || candidate;
        return true;
      }
    }
  } catch {
    // Fall through to false.
  }
  return false;
}

// ---------------------------------------------------------------------------
// Diagnostics endpoint
// ---------------------------------------------------------------------------

async function handleDiagnostics(): Promise<Response> {
  const hasOpenaiKey = !!process.env.OPENAI_API_KEY;

  let obsidianEnabled = false;
  try {
    const configFile = dataPath('.clipbrain.json');
    const config = JSON.parse(await Bun.file(configFile).text());
    obsidianEnabled = !!config.obsidian?.enabled;
  } catch {}

  let gbrainOk = false;
  let captures = 0;
  try {
    const output = await gbrainExec(['list', '--limit', '1']);
    gbrainOk = true;
    // Get total count from stats
    try {
      const statsOutput = await listPagesForReprocess();
      captures = parseGbrainOutput(statsOutput, 10000).filter(i => isClipBrainCaptureSlug(i.slug || '')).length;
    } catch {}
  } catch {}

  let processingEnabled = false;
  try {
    const configFile = dataPath('.clipbrain.json');
    const config = JSON.parse(await Bun.file(configFile).text());
    processingEnabled = !!config.processing?.enabled && hasOpenaiKey;
  } catch {}

  // Check if MCP is configured in Claude Code
  let mcpConfigured = false;
  try {
    const settingsPath = require('os').homedir() + '/.claude/settings.json';
    const settings = JSON.parse(require('fs').readFileSync(settingsPath, 'utf-8'));
    mcpConfigured = !!settings?.mcpServers?.gbrain;
  } catch {}

  return corsResponse(200, {
    server: 'ok',
    openaiKey: hasOpenaiKey,
    ytDlp: ytDlpAvailable,
    obsidian: obsidianEnabled,
    gbrain: gbrainOk,
    captures,
    processing: processingEnabled,
    mcpConfigured,
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const port = parsePort(args);
const host = parseHost(args);

if (import.meta.main) {
  // Check yt-dlp availability at startup (non-blocking)
  checkYtDlp().then(available => {
    ytDlpAvailable = available;
    if (!available) {
      console.warn('[startup] yt-dlp not found in PATH. YouTube transcript capture will not work.');
      console.warn('[startup] Install with: brew install yt-dlp');
    } else {
      console.log('[startup] yt-dlp available');
    }
  });

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(req) {
      const url = new URL(req.url);
      const originRejection = rejectDisallowedOrigin(req, port);
      if (originRejection) return originRejection;

      // Preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const authRejection = rejectUnauthorized(req);
      if (authRejection) return authRejection;

      // Dashboard
      if (url.pathname === '/' && req.method === 'GET') {
        const html = Bun.file(import.meta.dir + '/dashboard.html');
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      }

      // Health check
      if (url.pathname === '/health' && req.method === 'GET') {
        return corsResponse(200, { status: 'ok' });
      }

      // Diagnostics endpoint
      if (url.pathname === '/api/diagnostics' && req.method === 'GET') {
        return handleDiagnostics();
      }

      // Capture endpoint
      if (url.pathname === '/api/capture' && req.method === 'POST') {
        return handleCapture(req);
      }

      // YouTube transcript capture
      if (url.pathname === '/api/capture-youtube' && req.method === 'POST') {
        return handleCaptureYouTube(req);
      }

      // Search endpoint
      if (url.pathname === '/api/search' && req.method === 'GET') {
        return handleSearch(req);
      }

      // Recent captures endpoint
      if (url.pathname === '/api/recent' && req.method === 'GET') {
        return handleRecent(req);
      }

      // Daily digest — captures since a given date (for OpenClaw cron)
      if (url.pathname === '/api/digest' && req.method === 'GET') {
        return handleDigest(req);
      }

      // Stats endpoint
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        return handleStats();
      }

      // Page content endpoint
      if (url.pathname === '/api/page' && req.method === 'GET') {
        return handlePage(req);
      }

      // Agent-ready context pack endpoint
      if (url.pathname === '/api/context-pack' && req.method === 'GET') {
        return handleContextPack(req);
      }

      // Config endpoints
      if (url.pathname === '/api/config' && req.method === 'GET') {
        return handleGetConfig();
      }
      if (url.pathname === '/api/config' && req.method === 'POST') {
        return handlePostConfig(req);
      }

      // PDF upload
      if (url.pathname === '/api/upload-pdf' && req.method === 'GET') {
        return handleUploadPdfGet();
      }
      if (url.pathname === '/api/upload-pdf' && req.method === 'POST') {
        return handleUploadPdf(req);
      }

      // Obsidian bulk sync
      if (url.pathname === '/api/obsidian-sync-all' && req.method === 'POST') {
        return handleObsidianSyncAll();
      }

      // Connections endpoint
      if (url.pathname === '/api/connections' && req.method === 'GET') {
        return handleConnections(req);
      }

      // Graph endpoint
      if (url.pathname === '/api/graph' && req.method === 'GET') {
        return handleGraph();
      }

      // Reprocess all endpoint
      if (url.pathname === '/api/reprocess-all' && req.method === 'POST') {
        return handleReprocessAll(req);
      }

      return corsResponse(404, { error: 'Not found' });
    },
  });

  console.log(`ClipBrain server listening on http://${host}:${server.port}`);
}
