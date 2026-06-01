import {
  getBackfillReason,
  KNOWLEDGE_COMPILER_VERSION,
  postProcess,
} from './post-process.ts';

const CLIPBRAIN_PREFIXES = ['kindle/', 'web/', 'pdf/', 'youtube/', 'email/'];

export type BackfillListItem = {
  slug: string;
  type: string;
  date: string;
  title: string;
};

export type BackfillCandidate = {
  slug: string;
  type: string;
  title: string;
  reason: string;
};

export type BackfillOptions = {
  dryRun: boolean;
  force: boolean;
  limit: number;
  listLimit: number;
  slug?: string;
  type?: string;
  slugPrefix?: string;
  sleepMs: number;
  json: boolean;
};

export type BackfillSummary = {
  dryRun: boolean;
  compilerVersion: string;
  scanned: number;
  candidates: BackfillCandidate[];
  processed: number;
  skipped: number;
  failed: Array<{ slug: string; error: string }>;
};

export function parseGbrainList(output: string): BackfillListItem[] {
  return output
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      const slug = parts[0]?.trim() || '';
      const type = parts[1]?.trim() || inferTypeFromSlug(slug);
      const date = parts[2]?.trim() || '';
      const title = parts.length >= 4
        ? parts.slice(3).join('\t').trim()
        : slug.split('/').pop()?.replace(/-/g, ' ') || slug;
      return { slug, type, date, title };
    })
    .filter(item => item.slug);
}

export function isClipBrainSlug(slug: string): boolean {
  return CLIPBRAIN_PREFIXES.some(prefix => slug.startsWith(prefix));
}

export function shouldInspectItem(item: BackfillListItem, opts: Pick<BackfillOptions, 'slug' | 'type' | 'slugPrefix'>): boolean {
  if (!isClipBrainSlug(item.slug)) return false;
  if (opts.slug && item.slug !== opts.slug) return false;
  if (opts.type && !item.slug.startsWith(`${opts.type}/`)) return false;
  if (opts.slugPrefix && !item.slug.startsWith(opts.slugPrefix)) return false;
  return true;
}

export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const opts: BackfillOptions = {
    dryRun: true,
    force: false,
    limit: 20,
    listLimit: 10000,
    sleepMs: 0,
    json: false,
  };

  let explicitAll = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--apply') opts.dryRun = false;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--all') explicitAll = true;
    else if (arg === '--limit') opts.limit = parsePositiveInt(next(), '--limit');
    else if (arg === '--list-limit') opts.listLimit = parsePositiveInt(next(), '--list-limit');
    else if (arg === '--slug') opts.slug = next();
    else if (arg === '--type') opts.type = normalizeType(next());
    else if (arg === '--slug-prefix') opts.slugPrefix = next();
    else if (arg === '--sleep-ms') opts.sleepMs = parseNonNegativeInt(next(), '--sleep-ms');
    else if (arg === '--help' || arg === '-h') throw new HelpRequested();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (explicitAll) opts.limit = opts.listLimit;
  if (opts.slug && !isClipBrainSlug(opts.slug)) {
    throw new Error(`--slug must start with one of: ${CLIPBRAIN_PREFIXES.join(', ')}`);
  }
  if (opts.slugPrefix && !CLIPBRAIN_PREFIXES.some(prefix => opts.slugPrefix!.startsWith(prefix))) {
    throw new Error(`--slug-prefix must start with one of: ${CLIPBRAIN_PREFIXES.join(', ')}`);
  }

  return opts;
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillSummary> {
  if (!opts.dryRun && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for --apply. Run without --apply for a dry run.');
  }

  const output = await gbrainExec(['list', '--limit', String(opts.listLimit)]);
  const items = parseGbrainList(output);
  const summary: BackfillSummary = {
    dryRun: opts.dryRun,
    compilerVersion: KNOWLEDGE_COMPILER_VERSION,
    scanned: 0,
    candidates: [],
    processed: 0,
    skipped: 0,
    failed: [],
  };

  for (const item of items) {
    if (!shouldInspectItem(item, opts)) continue;
    summary.scanned++;

    try {
      const markdown = await gbrainExec(['get', item.slug]);
      const reason = getBackfillReason(markdown, opts.force);
      if (!reason) {
        summary.skipped++;
        continue;
      }

      const candidate = {
        slug: item.slug,
        type: item.type || inferTypeFromSlug(item.slug),
        title: item.title,
        reason,
      };
      summary.candidates.push(candidate);

      if (!opts.dryRun) {
        await postProcess(item.slug, markdown, true);
        summary.processed++;
        if (opts.sleepMs > 0) await new Promise(resolve => setTimeout(resolve, opts.sleepMs));
      }

      if (summary.candidates.length >= opts.limit) break;
    } catch (err: any) {
      summary.failed.push({ slug: item.slug, error: err?.message || String(err) });
    }
  }

  return summary;
}

export function formatBackfillSummary(summary: BackfillSummary): string {
  const lines: string[] = [
    `ClipBrain backfill ${summary.dryRun ? 'dry run' : 'apply'} (${summary.compilerVersion})`,
    `Scanned: ${summary.scanned}`,
    `Candidates: ${summary.candidates.length}`,
    `Processed: ${summary.processed}`,
    `Skipped current: ${summary.skipped}`,
    `Failed: ${summary.failed.length}`,
  ];

  if (summary.candidates.length > 0) {
    lines.push('');
    lines.push('Candidates:');
    for (const candidate of summary.candidates) {
      lines.push(`- ${candidate.slug} (${candidate.reason})`);
    }
  }

  if (summary.failed.length > 0) {
    lines.push('');
    lines.push('Failures:');
    for (const failure of summary.failed) {
      lines.push(`- ${failure.slug}: ${failure.error}`);
    }
  }

  return lines.join('\n');
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

function inferTypeFromSlug(slug: string): string {
  return slug.split('/')[0] || 'unknown';
}

function normalizeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!['kindle', 'web', 'pdf', 'youtube', 'email'].includes(normalized)) {
    throw new Error('--type must be one of: kindle, web, pdf, youtube, email');
  }
  return normalized;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

class HelpRequested extends Error {}

function printHelp() {
  console.log([
    'Usage: bun run backfill.ts [options]',
    '',
    'Dry-run is the default. Use --apply to call OpenAI and write enriched pages.',
    '',
    'Options:',
    '  --apply              Process candidates instead of only listing them',
    '  --dry-run            List candidates without writes (default)',
    '  --force              Reprocess even current compiler-version pages',
    '  --limit N            Max candidates to inspect/process (default: 20)',
    '  --all                Use --list-limit as the candidate limit',
    '  --list-limit N       Max pages to list from gbrain (default: 10000)',
    '  --slug S            Process one exact slug',
    '  --type T             Filter to kindle, web, pdf, youtube, or email',
    '  --slug-prefix P      Filter by slug prefix, e.g. kindle/ryan-holiday/',
    '  --sleep-ms N         Delay between applied pages',
    '  --json               Emit JSON summary',
  ].join('\n'));
}

if (import.meta.main) {
  try {
    const opts = parseBackfillArgs(process.argv.slice(2));
    const summary = await runBackfill(opts);
    console.log(opts.json ? JSON.stringify(summary, null, 2) : formatBackfillSummary(summary));
  } catch (err: any) {
    if (err instanceof HelpRequested) {
      printHelp();
      process.exit(0);
    }
    console.error(`[backfill] ${err?.message || String(err)}`);
    process.exit(1);
  }
}
