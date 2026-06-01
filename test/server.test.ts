import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeUrl, slugFromUrl, buildMarkdown, detectCaptureType, formatDigestMarkdown, isAllowedOrigin, isAuthorizedRequest, parseKnowledgeAtoms } from '../server.ts';
import type { CaptureLogEntry } from '../server.ts';

// ---------------------------------------------------------------------------
// Helper: minimal valid PDF buffer with extractable text
// ---------------------------------------------------------------------------

function makeMinimalPdf(text = 'Hello ClipBrain'): Buffer {
  const stream = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
  const streamBytes = Buffer.from(stream);

  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj`,
    `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${stream}\nendstream\nendobj`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += obj + '\n';
  }

  const xrefOffset = Buffer.byteLength(body);
  body += 'xref\n';
  body += `0 ${offsets.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  body += 'trailer\n';
  body += `<< /Size ${offsets.length + 1} /Root 1 0 R >>\n`;
  body += 'startxref\n';
  body += `${xrefOffset}\n`;
  body += '%%EOF\n';

  return Buffer.from(body);
}

// ---------------------------------------------------------------------------
// Unit tests — pure functions
// ---------------------------------------------------------------------------

describe('canonicalizeUrl', () => {
  test('strips utm params', () => {
    const result = canonicalizeUrl('https://example.com/page?utm_source=twitter&utm_medium=social&foo=bar');
    expect(result).toBe('https://example.com/page?foo=bar');
  });

  test('strips fbclid, ref, gclid', () => {
    const result = canonicalizeUrl('https://example.com/page?fbclid=abc&ref=home&gclid=xyz');
    expect(result).toBe('https://example.com/page');
  });

  test('lowercases scheme and host', () => {
    const result = canonicalizeUrl('HTTPS://Example.COM/Some/Path');
    expect(result).toBe('https://example.com/Some/Path');
  });

  test('strips trailing slash from paths', () => {
    const result = canonicalizeUrl('https://example.com/article/');
    expect(result).toBe('https://example.com/article');
  });

  test('keeps bare domain slash', () => {
    const result = canonicalizeUrl('https://example.com/');
    expect(result).toBe('https://example.com/');
  });

  test('sorts remaining params', () => {
    const result = canonicalizeUrl('https://example.com/?z=1&a=2');
    expect(result).toBe('https://example.com/?a=2&z=1');
  });
});

describe('slugFromUrl', () => {
  test('basic path', () => {
    expect(slugFromUrl('https://example.com/blog/my-post')).toBe('web/example-com/blog/my-post');
  });

  test('bare domain becomes index', () => {
    expect(slugFromUrl('https://example.com/')).toBe('web/example-com/index');
  });

  test('strips file extension', () => {
    expect(slugFromUrl('https://example.com/page.html')).toBe('web/example-com/page');
  });

  test('replaces dots in domain with dashes', () => {
    expect(slugFromUrl('https://blog.example.co.uk/post')).toBe('web/blog-example-co-uk/post');
  });

  test('cleans non-slug characters', () => {
    expect(slugFromUrl('https://example.com/path/with spaces & stuff')).toBe('web/example-com/path/with-spaces-stuff');
  });

  test('kindle:// URL with title generates kindle/author/title slug', () => {
    expect(slugFromUrl('kindle://book/deep-work-by-cal-newport', 'Deep Work by Cal Newport'))
      .toBe('kindle/cal-newport/deep-work');
  });

  test('kindle:// URL without author uses title only', () => {
    expect(slugFromUrl('kindle://book/some-book', 'Some Book'))
      .toBe('kindle/some-book');
  });

  test('kindle:// URL without title falls back to URL path', () => {
    expect(slugFromUrl('kindle://book/fallback-slug'))
      .toBe('kindle/fallback-slug');
  });
});

describe('buildMarkdown', () => {
  test('generates frontmatter and content', () => {
    const md = buildMarkdown({
      title: 'Test Page',
      canonicalUrl: 'https://example.com/test',
      domain: 'example.com',
      content: 'Hello world',
      capturedAt: '2026-04-14T12:00:00.000Z',
    });

    expect(md).toContain('title: "Test Page"');
    expect(md).toContain('type: reference');
    expect(md).toContain('tags: [web-capture, example.com]');
    expect(md).toContain('source_url: https://example.com/test');
    expect(md).toContain('captured_at: 2026-04-14T12:00:00.000Z');
    expect(md).toContain('Hello world');
    expect(md).not.toContain('## Highlights');
  });

  test('includes highlights section when selection is present', () => {
    const md = buildMarkdown({
      title: 'Test',
      canonicalUrl: 'https://example.com',
      domain: 'example.com',
      content: 'Body',
      selection: 'Important quote',
      capturedAt: '2026-04-14T12:00:00.000Z',
    });

    expect(md).toContain('## Highlights');
    expect(md).toContain('> Important quote');
  });

  test('escapes double quotes in title', () => {
    const md = buildMarkdown({
      title: 'A "quoted" title',
      canonicalUrl: 'https://example.com',
      domain: 'example.com',
      content: '',
      capturedAt: '2026-04-14T12:00:00.000Z',
    });

    expect(md).toContain('title: "A \\"quoted\\" title"');
  });
});

describe('isAllowedOrigin', () => {
  test('allows Chrome extension origins', () => {
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBe(true);
  });

  test('allows ClipBrain loopback dashboard origins on the active port', () => {
    expect(isAllowedOrigin('http://127.0.0.1:19285', 19285)).toBe(true);
    expect(isAllowedOrigin('http://localhost:19285', 19285)).toBe(true);
  });

  test('rejects unrelated web origins and wrong loopback ports', () => {
    expect(isAllowedOrigin('https://example.com', 19285)).toBe(false);
    expect(isAllowedOrigin('http://localhost:3000', 19285)).toBe(false);
  });
});

describe('isAuthorizedRequest', () => {
  test('allows requests when no token is configured', () => {
    expect(isAuthorizedRequest('POST', new Headers(), '')).toBe(true);
  });

  test('does not require tokens for read and preflight methods', () => {
    expect(isAuthorizedRequest('GET', new Headers(), 'secret')).toBe(true);
    expect(isAuthorizedRequest('OPTIONS', new Headers(), 'secret')).toBe(true);
  });

  test('allows bearer and X-ClipBrain-Token credentials', () => {
    expect(isAuthorizedRequest('POST', new Headers({ Authorization: 'Bearer secret' }), 'secret')).toBe(true);
    expect(isAuthorizedRequest('POST', new Headers({ 'X-ClipBrain-Token': 'secret' }), 'secret')).toBe(true);
  });

  test('rejects missing or invalid write credentials', () => {
    expect(isAuthorizedRequest('POST', new Headers(), 'secret')).toBe(false);
    expect(isAuthorizedRequest('POST', new Headers({ Authorization: 'Bearer wrong' }), 'secret')).toBe(false);
  });
});

describe('parseKnowledgeAtoms', () => {
  test('extracts compiler atoms from markdown sections', () => {
    const markdown = [
      '## Summary',
      '',
      'A summary.',
      '',
      '## Knowledge Atoms',
      '',
      '### Claims',
      '',
      '- Memory becomes useful when it is structured.',
      '',
      '### Quotes',
      '',
      '> Capture is not knowledge.',
      '',
      '### Entities',
      '',
      '- **gbrain** (tool) - Stores and queries the compiled memory',
      '',
      '### Open Questions',
      '',
      '- Which clips should become concept pages?',
      '',
      '### Actions',
      '',
      '- [ ] Build context packs for agents.',
      '',
      '## Related',
      '',
      '- [[Karpathy Knowledge Bases]] - Related',
    ].join('\n');

    expect(parseKnowledgeAtoms(markdown)).toEqual({
      claims: ['Memory becomes useful when it is structured.'],
      quotes: ['Capture is not knowledge.'],
      entities: [
        { name: 'gbrain', type: 'tool', relevance: 'Stores and queries the compiled memory' },
      ],
      questions: ['Which clips should become concept pages?'],
      actions: ['Build context packs for agents.'],
    });
  });

  test('returns empty atom lists when no compiler section exists', () => {
    expect(parseKnowledgeAtoms('## Summary\n\nNo atoms.')).toEqual({
      claims: [],
      quotes: [],
      entities: [],
      questions: [],
      actions: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests — HTTP endpoints
// ---------------------------------------------------------------------------

describe('HTTP server', () => {
  const TEST_PORT = Number(process.env.CLIPBRAIN_TEST_PORT || (19385 + Math.floor(Math.random() * 1000)));
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  let serverProc: ReturnType<typeof Bun.spawn> | null = null;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'clipbrain-test-data-'));

    // Start the server as a subprocess (import.meta.main guard means import alone won't start it)
    serverProc = Bun.spawn(['bun', 'run', 'server.ts', '--port', String(TEST_PORT)], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        GBRAIN_CAPTURE_HOST: '127.0.0.1',
        GBRAIN_BIN: process.env.GBRAIN_BIN || '/usr/bin/true',
        CLIPBRAIN_DATA_DIR: dataDir,
        OPENAI_API_KEY: '',
        CLIPBRAIN_API_TOKEN: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Wait for the server to be ready (up to 5 seconds)
    for (let i = 0; i < 50; i++) {
      try {
        const resp = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(200) });
        if (resp.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
  });

  afterAll(() => {
    if (serverProc) {
      serverProc.kill();
      serverProc = null;
    }
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('GET /health returns ok', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('GET /health has CORS headers', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('GET /health rejects unrelated browser origins', async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Origin: 'https://example.com' },
    });
    expect(res.status).toBe(403);
  });

  test('GET /health allows Chrome extension origins', async () => {
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const res = await fetch(`${BASE}/health`, { headers: { Origin: origin } });
    expect(res.status).toBe(200);
  });

  test('OPTIONS preflight returns 204', async () => {
    const res = await fetch(`${BASE}/api/capture`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  test('OPTIONS preflight rejects unrelated browser origins', async () => {
    const res = await fetch(`${BASE}/api/capture`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    });
    expect(res.status).toBe(403);
  });

  test('POST /api/capture with missing url returns 400', async () => {
    const res = await fetch(`${BASE}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('url');
  });

  test('POST /api/capture with missing title returns 400', async () => {
    const res = await fetch(`${BASE}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('title');
  });

  test('POST /api/capture with invalid JSON returns 400', async () => {
    const res = await fetch(`${BASE}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/capture with valid payload returns 202', async () => {
    const res = await fetch(`${BASE}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/article?utm_source=test',
        title: 'Test Article',
        content: 'Some content',
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('accepted');
    expect(body.slug).toBe('web/example-com/article');
  });

  test('POST /api/capture with kindle:// URL returns 202 with kindle slug', async () => {
    const res = await fetch(`${BASE}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'kindle://book/deep-work-by-cal-newport',
        title: 'Deep Work by Cal Newport',
        content: '## Highlights\n\n> "Deep work is important" (Location 42)\n',
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('accepted');
    expect(body.slug).toBe('kindle/cal-newport/deep-work');
  });

  test('GET /unknown returns 404', async () => {
    const res = await fetch(`${BASE}/unknown`);
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PDF upload tests
  // -------------------------------------------------------------------------

  test('GET /api/upload-pdf returns HTML upload form', async () => {
    const res = await fetch(`${BASE}/api/upload-pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Upload PDF');
    expect(html).toContain('multipart/form-data');
  });

  test('POST /api/upload-pdf with valid PDF returns 202', async () => {
    const pdfBuf = makeMinimalPdf('Test document content');
    const form = new FormData();
    form.append('file', new File([pdfBuf], 'My Research Paper.pdf', { type: 'application/pdf' }));

    const res = await fetch(`${BASE}/api/upload-pdf`, { method: 'POST', body: form });
    expect(res.status).toBe(202);

    const data = await res.json();
    expect(data.status).toBe('accepted');
    expect(data.slug).toBe('pdf/my-research-paper');
    expect(data.title).toBe('My Research Paper');
    expect(data.pages).toBeGreaterThanOrEqual(1);
  });

  test('POST /api/upload-pdf rejects non-PDF files', async () => {
    const form = new FormData();
    form.append('file', new File([Buffer.from('not a pdf')], 'notes.txt', { type: 'text/plain' }));

    const res = await fetch(`${BASE}/api/upload-pdf`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('PDF');
  });

  test('POST /api/upload-pdf rejects files over 50MB', async () => {
    // Create a FormData with an oversized file
    const bigBuf = Buffer.alloc(51 * 1024 * 1024, 0);
    const form = new FormData();
    form.append('file', new File([bigBuf], 'huge.pdf', { type: 'application/pdf' }));

    const res = await fetch(`${BASE}/api/upload-pdf`, { method: 'POST', body: form });
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error).toContain('too large');
  });

  test('POST /api/upload-pdf generates correct slug from filename', async () => {
    const pdfBuf = makeMinimalPdf('slug test');
    const form = new FormData();
    form.append('file', new File([pdfBuf], 'Machine Learning 101 - Chapter 2.pdf', { type: 'application/pdf' }));

    const res = await fetch(`${BASE}/api/upload-pdf`, { method: 'POST', body: form });
    expect(res.status).toBe(202);

    const data = await res.json();
    expect(data.slug).toBe('pdf/machine-learning-101-chapter-2');
  });

  test('POST /api/upload-pdf returns 400 when no file provided', async () => {
    const form = new FormData();
    const res = await fetch(`${BASE}/api/upload-pdf`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // /api/digest — daily digest endpoint
  // -------------------------------------------------------------------------

  test('GET /api/digest returns empty digest when window has no captures', async () => {
    const res = await fetch(`${BASE}/api/digest?since=2099-01-01`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(0);
    expect(data.markdown).toContain('Sin lecturas nuevas');
    expect(data.since).toContain('2099-01-01');
  });

  test('GET /api/digest rejects malformed since param', async () => {
    const res = await fetch(`${BASE}/api/digest?since=not-a-date`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid since');
  });

  test('GET /api/digest defaults to last day when no params given', async () => {
    const res = await fetch(`${BASE}/api/digest`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const sinceMs = new Date(data.since).getTime();
    const expected = Date.now() - 24 * 3600 * 1000;
    expect(Math.abs(sinceMs - expected)).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Daily digest — pure helpers
// ---------------------------------------------------------------------------

describe('detectCaptureType', () => {
  test('classifies kindle slugs', () => {
    expect(detectCaptureType('kindle/cal-newport/deep-work')).toBe('kindle');
  });
  test('classifies youtube slugs', () => {
    expect(detectCaptureType('youtube/lex-fridman/some-talk')).toBe('youtube');
  });
  test('classifies email slugs', () => {
    expect(detectCaptureType('email/stratechery/strategy-letter')).toBe('email');
  });
  test('classifies pdf slugs', () => {
    expect(detectCaptureType('pdf/some-paper')).toBe('pdf');
  });
  test('falls back to web for unknown prefix', () => {
    expect(detectCaptureType('web/example-com/article')).toBe('web');
    expect(detectCaptureType('random-thing')).toBe('web');
  });
});

describe('formatDigestMarkdown', () => {
  const since = new Date('2026-04-27T00:00:00Z');
  const empty = { since, kindle: [], web: [], youtube: [], email: [], pdf: [] };

  test('returns "no captures" message when empty', () => {
    const md = formatDigestMarkdown(empty);
    expect(md).toContain('Sin lecturas nuevas');
    expect(md).toContain('2026-04-27');
  });

  test('renders kindle section with highlight totals and pluralization', () => {
    const kindle: CaptureLogEntry[] = [
      { slug: 'kindle/cal-newport/deep-work', type: 'kindle', title: 'Deep Work', capturedAt: '2026-04-27T10:00:00Z', newHighlights: 3, author: 'cal-newport' },
      { slug: 'kindle/anne-lamott/bird-by-bird', type: 'kindle', title: 'Bird by Bird', capturedAt: '2026-04-27T11:00:00Z', newHighlights: 1, author: 'anne-lamott' },
    ];
    const md = formatDigestMarkdown({ ...empty, kindle });
    expect(md).toContain('*Kindle* — 4 highlights nuevos en 2 libros');
    expect(md).toContain('- Deep Work — Cal Newport (3 nuevos)');
    expect(md).toContain('- Bird by Bird — Anne Lamott (1 nuevo)');
  });

  test('singular pluralization for 1 highlight in 1 book', () => {
    const kindle: CaptureLogEntry[] = [
      { slug: 'kindle/x/y', type: 'kindle', title: 'Y', capturedAt: '2026-04-27T10:00:00Z', newHighlights: 1, author: 'x' },
    ];
    const md = formatDigestMarkdown({ ...empty, kindle });
    expect(md).toContain('1 highlight nuevo en 1 libro');
  });

  test('renders web section with hostname extracted from url', () => {
    const web: CaptureLogEntry[] = [
      { slug: 'web/x/y', type: 'web', title: 'Hello World', capturedAt: '2026-04-27T10:00:00Z', url: 'https://www.stratechery.com/2026/some-post' },
    ];
    const md = formatDigestMarkdown({ ...empty, web });
    expect(md).toContain('*Web* — 1 artículo');
    expect(md).toContain('- Hello World — stratechery.com');
  });

  test('renders youtube and email sections together', () => {
    const youtube: CaptureLogEntry[] = [
      { slug: 'youtube/lex/talk', type: 'youtube', title: 'AI Talk', capturedAt: '2026-04-27T10:00:00Z', channel: 'Lex Fridman' },
    ];
    const email: CaptureLogEntry[] = [
      { slug: 'email/strat/letter', type: 'email', title: 'Weekly Letter', capturedAt: '2026-04-27T10:00:00Z', from: 'Stratechery' },
    ];
    const md = formatDigestMarkdown({ ...empty, youtube, email });
    expect(md).toContain('*YouTube* — 1 video');
    expect(md).toContain('- AI Talk — Lex Fridman');
    expect(md).toContain('*Email* — 1 newsletter');
    expect(md).toContain('- Weekly Letter — Stratechery');
  });

  test('renders pdf section', () => {
    const pdf: CaptureLogEntry[] = [
      { slug: 'pdf/paper', type: 'pdf', title: 'Attention Is All You Need', capturedAt: '2026-04-27T10:00:00Z' },
    ];
    const md = formatDigestMarkdown({ ...empty, pdf });
    expect(md).toContain('*PDF* — 1 documento');
    expect(md).toContain('- Attention Is All You Need');
  });
});
