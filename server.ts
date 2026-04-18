#!/usr/bin/env bun

// ClipBrain — standalone HTTP server
// Receives web captures from the Chrome extension and stores them via `gbrain put` CLI.

import { PDFParse } from 'pdf-parse';
import { postProcess } from './post-process.ts';

const DEFAULT_PORT = 19285;
const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB

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
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

// ---------------------------------------------------------------------------
// gbrain CLI integration
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
    // Fetch more than needed so we can filter and prioritize
    const output = await gbrainExec(['list', '--limit', '200']);
    const all = parseGbrainOutput(output, 200);

    // Prioritize: kindle, web, pdf, and youtube captures first, then everything else
    const captures = all.filter(i => i.slug?.startsWith('kindle/') || i.slug?.startsWith('web/') || i.slug?.startsWith('pdf/') || i.slug?.startsWith('youtube/') || i.slug?.startsWith('email/'));
    const other = all.filter(i => !i.slug?.startsWith('kindle/') && !i.slug?.startsWith('web/') && !i.slug?.startsWith('pdf/') && !i.slug?.startsWith('youtube/') && !i.slug?.startsWith('email/'));
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
    let pdfs = 0;
    let videos = 0;
    let emails = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      const slug = parts[0]?.trim() || '';
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
      const trackingFile = import.meta.dir + '/.highlight-count';
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
// Obsidian vault sync
// ---------------------------------------------------------------------------

async function obsidianSync(slug: string, markdown: string) {
  try {
    const configFile = import.meta.dir + '/.clipbrain.json';
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
    const configFile = import.meta.dir + '/.clipbrain.json';
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
    const configFile = import.meta.dir + '/.clipbrain.json';
    await Bun.write(configFile, JSON.stringify(body, null, 2) + '\n');
    return corsResponse(200, { status: 'saved' });
  } catch (err: any) {
    return corsResponse(500, { error: err.message });
  }
}

async function handleObsidianSyncAll(): Promise<Response> {
  try {
    const configFile = import.meta.dir + '/.clipbrain.json';
    const config = JSON.parse(await Bun.file(configFile).text());

    if (!config.obsidian?.enabled || !config.obsidian?.vaultPath) {
      return corsResponse(400, { error: 'Obsidian sync not enabled' });
    }

    // List all items
    const output = await gbrainExec(['list', '--limit', '10000']);
    const lines = output.trim().split('\n').filter(Boolean);

    let synced = 0;
    let failed = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      const slug = parts[0]?.trim();
      if (!slug || (!slug.startsWith('kindle/') && !slug.startsWith('web/') && !slug.startsWith('pdf/') && !slug.startsWith('youtube/') && !slug.startsWith('email/'))) continue;

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

  // Fire and forget
  gbrainPut(slug, markdown).then(() => {
    // AI post-processing (background, never blocks)
    postProcess(slug, markdown).catch(err => {
      console.warn('[post-process] failed:', err.message);
    });
  }).catch((err) => {
    console.error(`[gbrain put] error:`, err);
  });

  // Obsidian sync (fire and forget)
  obsidianSync(slug, markdown);

  // Track in highlight counts (use 1 per PDF as a "capture" count)
  updateHighlightCount(slug, 1);

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

    return corsResponse(200, { slug, summary, tags, connections });
  } catch (err: any) {
    console.error('[connections]', err.message);
    return corsResponse(404, { error: 'Page not found' });
  }
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
    const output = await gbrainExec(['list', '--limit', '1000']);
    const items = parseGbrainOutput(output, 1000);

    // Only include captures (kindle/, web/, pdf/, youtube/)
    const captures = items.filter(i =>
      i.slug?.startsWith('kindle/') ||
      i.slug?.startsWith('web/') ||
      i.slug?.startsWith('pdf/') ||
      i.slug?.startsWith('youtube/')
    );

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

async function handleReprocessAll(): Promise<Response> {
  if (!process.env.OPENAI_API_KEY) {
    return corsResponse(400, { error: 'OPENAI_API_KEY not set. Enable smart processing by setting this environment variable.' });
  }

  try {
    const output = await gbrainExec(['list', '--limit', '10000']);
    const lines = output.trim().split('\n').filter(Boolean);

    let queued = 0;
    let skipped = 0;

    for (const line of lines) {
      const parts = line.split('\t');
      const slug = parts[0]?.trim();
      if (!slug || (!slug.startsWith('kindle/') && !slug.startsWith('web/') && !slug.startsWith('pdf/') && !slug.startsWith('youtube/') && !slug.startsWith('email/'))) continue;

      try {
        const content = await gbrainExec(['get', slug]);

        // Process in background with force=true
        postProcess(slug, content, true).catch(err => {
          console.warn(`[reprocess-all] failed for ${slug}:`, err.message);
        });
        queued++;
      } catch {
        skipped++;
      }
    }

    return corsResponse(202, { status: 'started', queued, skipped });
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
      ['yt-dlp', '--write-auto-sub', '--sub-lang', 'en', '--skip-download', '--sub-format', 'json3', '-o', tmpFile, `https://www.youtube.com/watch?v=${videoId}`],
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

  // Fire-and-forget save
  gbrainPut(slug, markdown).then(() => {
    postProcess(slug, markdown).catch(err => {
      console.warn('[post-process] failed:', err.message);
    });
  }).catch((err) => {
    console.error(`[gbrain put] error:`, err);
  });

  // Obsidian sync
  obsidianSync(slug, markdown);

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

  // Fire-and-forget — don't block the response on gbrain
  gbrainPut(slug, markdown).then(() => {
    // Track highlight count for kindle imports
    if (slug.startsWith('kindle/')) {
      const hlCount = (markdown.match(/^> /gm) || []).length;
      if (hlCount > 0) updateHighlightCount(slug, hlCount);
    }

    // AI post-processing (background, never blocks)
    postProcess(slug, markdown).catch(err => {
      console.warn('[post-process] failed:', err.message);
    });
  }).catch((err) => {
    console.error(`[gbrain put] error:`, err);
  });

  // Obsidian sync (parallel, independent of gbrainPut)
  obsidianSync(slug, markdown);

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

// ---------------------------------------------------------------------------
// yt-dlp availability check
// ---------------------------------------------------------------------------

let ytDlpAvailable = false;

async function checkYtDlp(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['which', 'yt-dlp'], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics endpoint
// ---------------------------------------------------------------------------

async function handleDiagnostics(): Promise<Response> {
  const hasOpenaiKey = !!process.env.OPENAI_API_KEY;

  let obsidianEnabled = false;
  try {
    const configFile = import.meta.dir + '/.clipbrain.json';
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
      const statsOutput = await gbrainExec(['list', '--limit', '10000']);
      captures = statsOutput.trim().split('\n').filter(Boolean).length;
    } catch {}
  } catch {}

  let processingEnabled = false;
  try {
    const configFile = import.meta.dir + '/.clipbrain.json';
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

const port = parsePort(process.argv.slice(2));

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

      // Stats endpoint
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        return handleStats();
      }

      // Page content endpoint
      if (url.pathname === '/api/page' && req.method === 'GET') {
        return handlePage(req);
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
        return handleReprocessAll();
      }

      return corsResponse(404, { error: 'Not found' });
    },
  });

  console.log(`ClipBrain server listening on http://localhost:${server.port}`);
}
