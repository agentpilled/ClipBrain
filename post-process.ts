// ClipBrain — AI post-processing layer
// After every capture, generates: summary, semantic tags, and connections to existing content.

export interface ProcessResult {
  summary: string;           // 2-3 sentence summary
  tags: string[];            // 3-5 semantic tags (e.g., "startups", "psychology")
  connections: Connection[];  // Related content in the knowledge base
}

export interface Connection {
  slug: string;
  title: string;
  reason: string;  // Why this is connected (1 sentence)
}

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

  const gbrainSrc = import.meta.dir + '/node_modules/gbrain/src/cli.ts';
  if (require('fs').existsSync(gbrainSrc)) return ['bun', 'run', gbrainSrc];

  const localBin = import.meta.dir + '/bin/gbrain';
  if (require('fs').existsSync(localBin)) return [localBin];

  return ['gbrain'];
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

    const subfolder = slug.startsWith('kindle/') ? 'kindle' : slug.startsWith('pdf/') ? 'pdf' : 'web';
    const cleanTitle = title.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').trim();
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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'system',
        content: 'You are a knowledge librarian. Given content and a list of existing items in the knowledge base, generate: 1) a 2-3 sentence summary, 2) 3-5 semantic tags (single words or short phrases, lowercase), 3) which existing items are genuinely related and why (1 sentence each). Respond in JSON format: { "summary": "...", "tags": ["..."], "connections": [{"title": "...", "reason": "..."}] }'
      }, {
        role: 'user',
        content: `Content to process:\n${content.slice(0, 2000)}\n\nExisting items in knowledge base:\n${relatedTitles.join('\n')}`
      }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}

// ---------------------------------------------------------------------------
// Parse OpenAI response
// ---------------------------------------------------------------------------

export function parseOpenAIResponse(data: any): ProcessResult | null {
  try {
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);

    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: any) => typeof t === 'string').slice(0, 5) : [],
      connections: Array.isArray(parsed.connections)
        ? parsed.connections
            .filter((c: any) => c && typeof c.title === 'string' && typeof c.reason === 'string')
            .map((c: any) => ({ slug: '', title: c.title, reason: c.reason }))
        : [],
    };
  } catch {
    return null;
  }
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

  for (const line of fmLines) {
    const match = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();

      // Handle quoted strings
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      // Handle arrays like [tag1, tag2]
      if (value.startsWith('[') && value.endsWith(']')) {
        fm[key] = value.slice(1, -1).split(',').map(s => s.trim());
      } else {
        fm[key] = value;
      }
    }
  }

  const body = lines.slice(endIdx + 1).join('\n');
  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Enrich markdown with AI results
// ---------------------------------------------------------------------------

export function enrichMarkdown(
  originalMarkdown: string,
  result: ProcessResult,
  relatedContent: Array<{ slug: string; title: string }>
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

  // Build enriched frontmatter
  const fmLines: string[] = [
    '---',
    `title: "${(frontmatter.title || '').replace(/"/g, '\\"')}"`,
    `type: ${frontmatter.type || 'reference'}`,
    `tags: [${result.tags.join(', ')}]`,
    `summary: "${result.summary.replace(/"/g, '\\"')}"`,
  ];

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
  fmLines.push(`processed_at: ${new Date().toISOString()}`);
  fmLines.push('---');

  // Build summary and related sections
  const enrichedSections: string[] = [];

  enrichedSections.push('');
  enrichedSections.push('## Summary');
  enrichedSections.push('');
  enrichedSections.push(result.summary);

  if (connectionsWithSlugs.length > 0) {
    enrichedSections.push('');
    enrichedSections.push('## Related');
    enrichedSections.push('');
    for (const conn of connectionsWithSlugs) {
      enrichedSections.push(`- [[${conn.title}]] — ${conn.reason}`);
    }
  }

  enrichedSections.push('');
  enrichedSections.push('---');

  // Strip existing Summary/Related sections if re-processing
  let cleanBody = body;
  cleanBody = cleanBody.replace(/\n## Summary\n[\s\S]*?(?=\n---\n|$)/, '');
  cleanBody = cleanBody.replace(/^\n## Summary\n[\s\S]*?(?=\n---\n|$)/, '');
  // Clean up leading whitespace
  cleanBody = cleanBody.replace(/^\n+/, '\n');

  return fmLines.join('\n') + enrichedSections.join('\n') + cleanBody + '\n';
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

  await gbrainPut(slug, enrichedMarkdown);

  // 7. Re-sync to Obsidian with wikilinks
  await obsidianSync(slug, enrichedMarkdown);

  const tagCount = result.tags.length;
  const connCount = result.connections.filter(c => c.slug || relatedContent.some(r => r.title.toLowerCase() === c.title.toLowerCase())).length;
  console.log(`[post-process] processed ${slug} (${tagCount} tags, ${connCount} connections)`);
}
