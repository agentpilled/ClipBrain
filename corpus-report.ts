import { getBackfillReason, parseFrontmatter } from './post-process.ts';
import { loadClipBrainListItems } from './gbrain-list.ts';
export { buildGbrainListCommands, mergeUniqueGbrainListItems } from './gbrain-list.ts';

export type CorpusItem = {
  slug: string;
  type: string;
  title: string;
  frontmatterTitle: string;
  backfillReason: string | null;
  atomCount: number;
  issueFlags: string[];
};

export type DuplicateGroup = {
  key: string;
  title: string;
  slugs: string[];
};

export type CorpusReport = {
  scanned: number;
  backfillPending: number;
  issueCount: number;
  duplicateGroups: DuplicateGroup[];
  issues: CorpusItem[];
  pending: CorpusItem[];
};

export function normalizeCorpusTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['"`]+/g, '')
    .replace(/\s+by\s+(settings|saturday,\s*january\s+\d{1,2},\s*\d{4})$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function countKnowledgeAtoms(markdown: string): number {
  const section = markdown.match(/## Knowledge Atoms\s*\n([\s\S]*?)(?=\n## |\n---\n|$)/);
  if (!section) return 0;
  return section[1].split('\n').filter(line => /^-\s+|^>\s+/.test(line.trim())).length;
}

export function classifyCorpusIssues(item: Pick<CorpusItem, 'slug' | 'title' | 'frontmatterTitle'>): string[] {
  const flags: string[] = [];
  const haystack = `${item.slug} ${item.title} ${item.frontmatterTitle}`.toLowerCase();

  if (/web\/example-com\/|web\/test-article|test article/.test(haystack)) {
    flags.push('test-capture');
  }
  if (/pdf\/my-research-paper|my research paper/.test(haystack)) {
    flags.push('sample-pdf');
  }
  if (/kindle\/.*-by-settings\b| by settings\b/.test(haystack)) {
    flags.push('kindle-import-artifact');
  }
  if (/kindle\/.*-by-[a-z]+day-[a-z]+-\d{1,2}-\d{4}\b| by [a-z]+day,? [a-z]+ \d{1,2},? \d{4}\b/.test(haystack)) {
    flags.push('kindle-import-artifact');
  }
  if (/garry tan on x:\\\s*$/.test(`${item.title} ${item.frontmatterTitle}`.toLowerCase())) {
    flags.push('truncated-title');
  }

  return flags;
}

export function findDuplicateGroups(items: CorpusItem[]): DuplicateGroup[] {
  const groups = new Map<string, CorpusItem[]>();

  for (const item of items) {
    const key = normalizeCorpusTitle(item.frontmatterTitle || item.title);
    if (!key || key.length < 8) continue;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      title: group[0].frontmatterTitle || group[0].title,
      slugs: group.map(item => item.slug),
    }));
}

export function buildCorpusReport(items: CorpusItem[]): CorpusReport {
  const issues = items.filter(item => item.issueFlags.length > 0);
  const pending = items.filter(item => item.backfillReason);

  return {
    scanned: items.length,
    backfillPending: pending.length,
    issueCount: issues.length,
    duplicateGroups: findDuplicateGroups(items),
    issues,
    pending,
  };
}

export function formatCorpusReport(report: CorpusReport): string {
  const lines: string[] = [
    'ClipBrain corpus report',
    `Scanned: ${report.scanned}`,
    `Backfill pending: ${report.backfillPending}`,
    `Issue flags: ${report.issueCount}`,
    `Duplicate groups: ${report.duplicateGroups.length}`,
  ];

  if (report.issues.length > 0) {
    lines.push('');
    lines.push('Issue candidates:');
    for (const item of report.issues) {
      lines.push(`- ${item.slug} [${item.issueFlags.join(', ')}]`);
    }
  }

  if (report.duplicateGroups.length > 0) {
    lines.push('');
    lines.push('Duplicate title groups:');
    for (const group of report.duplicateGroups) {
      lines.push(`- ${group.title}`);
      for (const slug of group.slugs) {
        lines.push(`  - ${slug}`);
      }
    }
  }

  return lines.join('\n');
}

export async function loadCorpusItems(listLimit: number): Promise<CorpusItem[]> {
  const items = await loadClipBrainListItems(gbrainExec, listLimit);
  const result: CorpusItem[] = [];

  for (const item of items) {
    try {
      const markdown = await gbrainExec(['get', item.slug]);
      const { frontmatter } = parseFrontmatter(markdown);
      const frontmatterTitle = typeof frontmatter.title === 'string' ? frontmatter.title : '';
      const corpusItem: CorpusItem = {
        slug: item.slug,
        type: item.type,
        title: item.title,
        frontmatterTitle,
        backfillReason: getBackfillReason(markdown),
        atomCount: countKnowledgeAtoms(markdown),
        issueFlags: [],
      };
      corpusItem.issueFlags = classifyCorpusIssues(corpusItem);
      result.push(corpusItem);
    } catch (err: any) {
      result.push({
        slug: item.slug,
        type: item.type,
        title: item.title,
        frontmatterTitle: '',
        backfillReason: null,
        atomCount: 0,
        issueFlags: [`read-error:${err?.message || String(err)}`],
      });
    }
  }

  return result;
}

function resolveGbrainCommand(): string[] {
  if (process.env.GBRAIN_BIN) return [process.env.GBRAIN_BIN];
  return ['gbrain'];
}

async function gbrainExec(args: string[]): Promise<string> {
  const proc = Bun.spawn([...resolveGbrainCommand(), ...args], {
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
        'Usage: bun run corpus-report.ts [options]',
        '',
        'Options:',
        '  --json           Emit JSON report',
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
    const report = buildCorpusReport(await loadCorpusItems(opts.listLimit));
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatCorpusReport(report));
  } catch (err: any) {
    console.error(`[corpus-report] ${err?.message || String(err)}`);
    process.exit(1);
  }
}
