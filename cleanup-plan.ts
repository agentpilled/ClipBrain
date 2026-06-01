import { parseFrontmatter } from './post-process.ts';
import {
  buildCorpusReport,
  loadCorpusItems,
  normalizeCorpusTitle,
} from './corpus-report.ts';
import type { CorpusItem } from './corpus-report.ts';

export type CleanupAction = 'delete' | 'review_merge' | 'merge_duplicate' | 'fix_title';
export type CleanupConfidence = 'high' | 'medium' | 'low';

export type CleanupRecommendation = {
  action: CleanupAction;
  confidence: CleanupConfidence;
  slugs: string[];
  reason: string;
  keepSlug?: string;
  deleteSlugs?: string[];
  suggestedTitle?: string;
};

export type CleanupPlan = {
  scanned: number;
  recommendations: CleanupRecommendation[];
};

type MarkdownBySlug = Record<string, string>;

export function buildCleanupPlan(items: CorpusItem[], markdownBySlug: MarkdownBySlug): CleanupPlan {
  const recommendations: CleanupRecommendation[] = [];
  const deleteSlugs = new Set<string>();
  const reviewMergeSlugs = new Set<string>();
  const duplicateDeleteSlugs = new Set<string>();
  const itemsBySlug = new Map(items.map(item => [item.slug, item]));

  for (const item of items) {
    const markdown = markdownBySlug[item.slug] || '';

    if (item.issueFlags.includes('test-capture')) {
      recommendations.push({
        action: 'delete',
        confidence: 'high',
        slugs: [item.slug],
        reason: 'Obvious placeholder/test web capture, not user knowledge.',
      });
      deleteSlugs.add(item.slug);
      continue;
    }

    if (item.issueFlags.includes('sample-pdf')) {
      recommendations.push({
        action: 'delete',
        confidence: 'high',
        slugs: [item.slug],
        reason: 'Sample PDF fixture with placeholder content.',
      });
      deleteSlugs.add(item.slug);
      continue;
    }

    if (item.issueFlags.includes('kindle-import-artifact')) {
      const canonicalSlug = findCanonicalKindleSlug(item.slug, itemsBySlug);
      if (isKindleNoteShell(markdown)) {
        recommendations.push({
          action: 'delete',
          confidence: 'high',
          slugs: [item.slug],
          reason: 'Kindle import artifact contains only note/page markers and no substantive highlight text.',
        });
        deleteSlugs.add(item.slug);
      } else {
        recommendations.push({
          action: 'review_merge',
          confidence: canonicalSlug ? 'medium' : 'low',
          slugs: [item.slug],
          keepSlug: canonicalSlug,
          deleteSlugs: canonicalSlug ? [item.slug] : undefined,
          reason: canonicalSlug
            ? 'Malformed Kindle import slug contains substantive highlights; compare and merge anything unique into the canonical book before deleting it.'
            : 'Malformed Kindle import slug contains substantive highlights but no canonical book was found automatically.',
        });
        reviewMergeSlugs.add(item.slug);
      }
    }
  }

  const report = buildCorpusReport(items);
  for (const group of report.duplicateGroups) {
    if (group.slugs.every(slug => deleteSlugs.has(slug))) continue;
    if (group.slugs.some(slug => reviewMergeSlugs.has(slug))) continue;

    const activeSlugs = group.slugs.filter(slug => !deleteSlugs.has(slug));
    if (activeSlugs.length < 2) continue;

    const keepSlug = chooseDuplicateKeepSlug(activeSlugs, itemsBySlug);
    const redundantSlugs = activeSlugs.filter(slug => slug !== keepSlug);
    const sameSourceUrl = hasSingleSourceUrl(activeSlugs, markdownBySlug);
    const confidence: CleanupConfidence = sameSourceUrl ? 'medium' : 'low';

    recommendations.push({
      action: 'merge_duplicate',
      confidence,
      slugs: activeSlugs,
      keepSlug,
      deleteSlugs: redundantSlugs,
      reason: sameSourceUrl
        ? 'Duplicate title group with the same source URL; keep the richest/descriptive slug, verify no unique text, then remove redundant copy.'
        : 'Duplicate title group; inspect content before choosing a canonical item.',
    });

    for (const slug of redundantSlugs) duplicateDeleteSlugs.add(slug);
  }

  for (const item of items) {
    if (deleteSlugs.has(item.slug) || duplicateDeleteSlugs.has(item.slug)) continue;

    const suggestedTitle = inferBetterTitle(item, markdownBySlug[item.slug] || '');
    if (!suggestedTitle) continue;

    const currentTitle = titleForItem(item, markdownBySlug[item.slug] || '');
    if (normalizeCorpusTitle(currentTitle) === normalizeCorpusTitle(suggestedTitle)) continue;

    recommendations.push({
      action: 'fix_title',
      confidence: 'medium',
      slugs: [item.slug],
      suggestedTitle,
      reason: `Current title looks malformed or truncated: "${truncate(currentTitle, 90)}".`,
    });
  }

  return {
    scanned: items.length,
    recommendations,
  };
}

export function formatCleanupPlan(plan: CleanupPlan): string {
  const deleteRecs = plan.recommendations.filter(rec => rec.action === 'delete');
  const mergeRecs = plan.recommendations.filter(rec => rec.action === 'review_merge' || rec.action === 'merge_duplicate');
  const titleRecs = plan.recommendations.filter(rec => rec.action === 'fix_title');
  const lines: string[] = [
    'ClipBrain cleanup plan (read-only)',
    `Scanned: ${plan.scanned}`,
    `Recommendations: ${plan.recommendations.length}`,
    `Delete candidates: ${deleteRecs.length}`,
    `Merge/review candidates: ${mergeRecs.length}`,
    `Title fixes: ${titleRecs.length}`,
    'Writes executed: 0',
  ];

  if (deleteRecs.length > 0) {
    lines.push('');
    lines.push('Delete candidates:');
    for (const rec of deleteRecs) {
      lines.push(`- ${rec.slugs.join(', ')} [${rec.confidence}] ${rec.reason}`);
    }
  }

  if (mergeRecs.length > 0) {
    lines.push('');
    lines.push('Review / merge before delete:');
    for (const rec of mergeRecs) {
      const keep = rec.keepSlug ? ` keep=${rec.keepSlug}` : '';
      const remove = rec.deleteSlugs?.length ? ` remove_after_verify=${rec.deleteSlugs.join(',')}` : '';
      lines.push(`- ${rec.slugs.join(', ')} [${rec.confidence}]${keep}${remove}`);
      lines.push(`  ${rec.reason}`);
    }
  }

  if (titleRecs.length > 0) {
    lines.push('');
    lines.push('Title fixes:');
    for (const rec of titleRecs) {
      lines.push(`- ${rec.slugs.join(', ')} [${rec.confidence}] title="${rec.suggestedTitle}"`);
      lines.push(`  ${rec.reason}`);
    }
  }

  return lines.join('\n');
}

export function isKindleNoteShell(markdown: string): boolean {
  const sourceBody = extractSourceBody(markdown);
  const lines = sourceBody
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^#+\s+/.test(line));

  if (lines.length === 0) return true;

  const contentLines = lines.filter(line => !isKindleMarkerLine(line));
  return contentLines.join(' ').replace(/\s+/g, ' ').trim().length < 40;
}

export function inferBetterTitle(item: CorpusItem, markdown: string): string | null {
  const { frontmatter, body } = parseFrontmatter(markdown);
  const sourceUrl = typeof frontmatter.source_url === 'string' ? frontmatter.source_url : '';
  const currentTitle = titleForItem(item, markdown);
  const text = `${currentTitle}\n${body.slice(0, 2000)}\n${item.slug}`;

  if (normalizeCorpusTitle(text).includes('resolvers the routing table for intelligence')) {
    return 'Resolvers: The Routing Table for Intelligence';
  }

  if (/x\.com|twitter\.com/.test(sourceUrl) && looksTruncatedXTitle(currentTitle)) {
    const fromBody = body.match(/^\s*([^#\n]{12,120})\s+\/\s+X\b/m)?.[1]?.trim();
    if (fromBody && !looksTruncatedXTitle(fromBody)) return fromBody;
  }

  return null;
}

function extractSourceBody(markdown: string): string {
  const { body } = parseFrontmatter(markdown);
  const generatedBoundary = body.match(/^\s*## Summary\s*[\s\S]*?\n---\s*\n([\s\S]*)$/);
  return generatedBoundary ? generatedBoundary[1] : body;
}

function isKindleMarkerLine(line: string): boolean {
  const clean = line.replace(/^>\s*/, '').replace(/\u00a0/g, ' ').trim();
  return /^(note|highlight)\s*\|\s*(page|location):\s*[\w.-]+(?:\s*\([^)]*\))?$/i.test(clean) ||
    /^(page|location):\s*[\w.-]+(?:\s*\([^)]*\))?$/i.test(clean);
}

function findCanonicalKindleSlug(slug: string, itemsBySlug: Map<string, CorpusItem>): string | undefined {
  const canonical = slug
    .replace(/-by-settings$/, '')
    .replace(/-by-[a-z]+day-[a-z]+-\d{1,2}-\d{4}$/i, '');

  if (canonical !== slug && itemsBySlug.has(canonical)) return canonical;
  return undefined;
}

function chooseDuplicateKeepSlug(slugs: string[], itemsBySlug: Map<string, CorpusItem>): string {
  return [...slugs].sort((a, b) => duplicateScore(b, itemsBySlug) - duplicateScore(a, itemsBySlug) || b.length - a.length)[0];
}

function duplicateScore(slug: string, itemsBySlug: Map<string, CorpusItem>): number {
  const item = itemsBySlug.get(slug);
  if (!item) return 0;

  let score = 0;
  score += item.atomCount * 10;
  if (!item.backfillReason) score += 25;
  if (item.issueFlags.length === 0) score += 10;
  if (!/\/[^/]+-on-x$/.test(slug)) score += 8;
  score += Math.min(slug.length, 140) / 20;
  return score;
}

function hasSingleSourceUrl(slugs: string[], markdownBySlug: MarkdownBySlug): boolean {
  const urls = new Set<string>();
  for (const slug of slugs) {
    const { frontmatter } = parseFrontmatter(markdownBySlug[slug] || '');
    const sourceUrl = typeof frontmatter.source_url === 'string' ? frontmatter.source_url.trim() : '';
    if (sourceUrl) urls.add(sourceUrl);
  }
  return urls.size === 1;
}

function titleForItem(item: CorpusItem, markdown: string): string {
  const { frontmatter } = parseFrontmatter(markdown);
  if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) return frontmatter.title.trim();
  return item.frontmatterTitle || item.title || item.slug;
}

function looksTruncatedXTitle(title: string): boolean {
  const clean = title.replace(/\s+/g, ' ').trim();
  return /on x:\s*\\?\s*$/i.test(clean) || /\\\s*$/.test(clean);
}

function truncate(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3)}...`;
}

async function loadMarkdownBySlug(items: CorpusItem[]): Promise<MarkdownBySlug> {
  const markdownBySlug: MarkdownBySlug = {};
  for (const item of items) {
    markdownBySlug[item.slug] = await gbrainGet(item.slug);
  }
  return markdownBySlug;
}

function resolveGbrainCommand(): string[] {
  if (process.env.GBRAIN_BIN) return [process.env.GBRAIN_BIN];
  return ['gbrain'];
}

async function gbrainGet(slug: string): Promise<string> {
  const proc = Bun.spawn([...resolveGbrainCommand(), 'get', slug], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`gbrain get failed for ${slug}: ${stderr}`);
  }

  return stdout;
}

function parseArgs(argv: string[]): { listLimit: number; json: boolean } {
  let listLimit = 10000;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--list-limit') {
      const raw = argv[++i];
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error('--list-limit must be a positive integer');
      listLimit = parsed;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: bun run cleanup-plan.ts [options]',
        '',
        'Read-only cleanup recommendations. This command never deletes or writes gbrain pages.',
        '',
        'Options:',
        '  --json           Emit JSON plan',
        '  --list-limit N   Max pages to list from gbrain (default: 10000)',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { listLimit, json };
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const items = await loadCorpusItems(opts.listLimit);
    const markdownBySlug = await loadMarkdownBySlug(items);
    const plan = buildCleanupPlan(items, markdownBySlug);
    console.log(opts.json ? JSON.stringify(plan, null, 2) : formatCleanupPlan(plan));
  } catch (err: any) {
    console.error(`[cleanup-plan] ${err?.message || String(err)}`);
    process.exit(1);
  }
}
