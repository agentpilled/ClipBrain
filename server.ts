#!/usr/bin/env bun

// GBrain Capture — standalone HTTP server
// Receives web captures from the Chrome extension and stores them via `gbrain put` CLI.

const DEFAULT_PORT = 19285;

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

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

// ---------------------------------------------------------------------------
// GBrain CLI integration
// ---------------------------------------------------------------------------

function resolveGbrainCommand(): string[] {
  if (process.env.GBRAIN_BIN) return [process.env.GBRAIN_BIN];

  // Prefer running via bun + source (avoids PGLite ENOENT bug in compiled binaries)
  const gbrainSrc = import.meta.dir + '/node_modules/gbrain/src/cli.ts';
  if (require('fs').existsSync(gbrainSrc)) return ['bun', 'run', gbrainSrc];

  // Fallback to compiled binary
  const localBin = import.meta.dir + '/bin/gbrain';
  if (require('fs').existsSync(localBin)) return [localBin];

  return ['gbrain'];
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
  } else {
    console.log(`[gbrain put] saved ${slug}`);
  }
}

// ---------------------------------------------------------------------------
// GBrain CLI helpers for query/list/stats
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
    // Fetch more than needed so we can filter and prioritize
    const output = await gbrainExec(['list', '--limit', '200']);
    const all = parseGbrainOutput(output, 200);

    // Prioritize: kindle and web captures first, then everything else
    const captures = all.filter(i => i.slug?.startsWith('kindle/') || i.slug?.startsWith('web/'));
    const other = all.filter(i => !i.slug?.startsWith('kindle/') && !i.slug?.startsWith('web/'));
    const sorted = [...captures, ...other].slice(0, limit);

    return corsResponse(200, { results: sorted });
  } catch (err: any) {
    console.error('[recent]', err.message);
    return corsResponse(200, { results: [] });
  }
}

// Track highlight counts per kindle book in a local JSON file
async function updateHighlightCount(slug: string, count: number) {
  const trackingFile = import.meta.dir + '/.highlight-counts.json';
  let data: Record<string, number> = {};
  try {
    data = JSON.parse(await Bun.file(trackingFile).text());
  } catch {}
  data[slug] = count;
  const total = Object.values(data).reduce((sum, c) => sum + c, 0);
  await Bun.write(trackingFile, JSON.stringify(data));
  await Bun.write(import.meta.dir + '/.highlight-count', String(total));
}

async function handleStats(): Promise<Response> {
  try {
    const output = await gbrainExec(['list', '--limit', '10000']);
    const lines = output.trim().split('\n').filter(Boolean);

    let articles = 0;
    let books = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      const slug = parts[0]?.trim() || '';
      if (slug.startsWith('kindle/')) {
        books++;
      } else if (slug.startsWith('web/')) {
        articles++;
      }
    }

    // Read highlight count from local tracking file (updated on each import)
    let highlights = 0;
    try {
      const trackingFile = import.meta.dir + '/.highlight-count';
      const stored = await Bun.file(trackingFile).text();
      highlights = parseInt(stored.trim(), 10) || 0;
    } catch {
      // No tracking file yet — estimate
      highlights = 0;
    }

    return corsResponse(200, { articles, books, highlights });
  } catch (err: any) {
    console.error('[stats]', err.message);
    return corsResponse(200, { articles: 0, books: 0, highlights: 0 });
  }
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
// Request handlers
// ---------------------------------------------------------------------------

async function handleCapture(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return corsResponse(400, { error: 'Invalid JSON body' });
  }

  const { url, title, content, selection, capturedAt } = body;

  if (!url || typeof url !== 'string') {
    return corsResponse(400, { error: 'Missing required field: url' });
  }
  if (!title || typeof title !== 'string') {
    return corsResponse(400, { error: 'Missing required field: title' });
  }

  let canonical: string;
  if (url.startsWith('kindle://')) {
    canonical = url; // kindle:// URLs don't need canonicalization
  } else {
    try {
      canonical = canonicalizeUrl(url);
    } catch {
      return corsResponse(400, { error: 'Invalid URL' });
    }
  }

  const isKindle = canonical.startsWith('kindle://');
  const domain = isKindle ? 'kindle' : new URL(canonical).hostname;
  const slug = slugFromUrl(canonical, title);

  const markdown = buildMarkdown({
    title,
    canonicalUrl: canonical,
    domain,
    content: content || '',
    selection: selection || null,
    capturedAt,
  });

  // Fire-and-forget — don't block the response on gbrain
  gbrainPut(slug, markdown).then(() => {
    // Track highlight count for kindle imports
    if (slug.startsWith('kindle/')) {
      const hlCount = (markdown.match(/^> /gm) || []).length;
      if (hlCount > 0) updateHighlightCount(slug, hlCount);
    }
  }).catch((err) => {
    console.error(`[gbrain put] error:`, err);
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

const port = parsePort(process.argv.slice(2));

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Dashboard
    if (url.pathname === '/' && req.method === 'GET') {
      const html = Bun.file(import.meta.dir + '/dashboard.html');
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      return corsResponse(200, { status: 'ok' });
    }

    // Capture endpoint
    if (url.pathname === '/api/capture' && req.method === 'POST') {
      return handleCapture(req);
    }

    // Search endpoint
    if (url.pathname === '/api/search' && req.method === 'GET') {
      return handleSearch(req);
    }

    // Recent captures endpoint
    if (url.pathname === '/api/recent' && req.method === 'GET') {
      return handleRecent(req);
    }

    // Stats endpoint
    if (url.pathname === '/api/stats' && req.method === 'GET') {
      return handleStats();
    }

    // Page content endpoint
    if (url.pathname === '/api/page' && req.method === 'GET') {
      return handlePage(req);
    }

    return corsResponse(404, { error: 'Not found' });
  },
});

console.log(`GBrain Capture server listening on http://localhost:${server.port}`);
