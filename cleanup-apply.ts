import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  buildCleanupPlan,
  loadMarkdownBySlug,
} from './cleanup-plan.ts';
import type {
  CleanupAction,
  CleanupConfidence,
  CleanupPlan,
  CleanupRecommendation,
} from './cleanup-plan.ts';
import { loadCorpusItems } from './corpus-report.ts';

export type CleanupApplyAction = 'delete' | 'fix-title';
export type CleanupApplyStatus = 'pending_approval' | 'approved_dry_run' | 'applied' | 'failed' | 'skipped';

export type CleanupApplyOperation = {
  action: CleanupApplyAction;
  approval: string;
  slug: string;
  sourceAction: CleanupAction;
  confidence: CleanupConfidence;
  reason: string;
  keepSlug?: string;
  suggestedTitle?: string;
};

export type CleanupApplyOptions = {
  dryRun: boolean;
  listLimit: number;
  approvals: string[];
  actions: Array<CleanupApplyAction | CleanupAction>;
  slugs: string[];
  json: boolean;
  logPath?: string;
  backupDir?: string;
};

export type CleanupApplyResult = {
  operation: CleanupApplyOperation;
  status: CleanupApplyStatus;
  backupPath?: string;
  error?: string;
};

export type CleanupApplySummary = {
  dryRun: boolean;
  scanned: number;
  selected: number;
  approved: number;
  applied: number;
  skipped: number;
  failed: number;
  logPath?: string;
  backupDir?: string;
  results: CleanupApplyResult[];
};

type GbrainClient = {
  get(slug: string): Promise<string>;
  put(slug: string, markdown: string): Promise<void>;
  delete(slug: string): Promise<void>;
};

type AuditEvent = {
  timestamp: string;
  runId: string;
  status: 'applied' | 'failed';
  action: CleanupApplyAction;
  approval: string;
  slug: string;
  sourceAction: CleanupAction;
  confidence: CleanupConfidence;
  reason: string;
  keepSlug?: string;
  suggestedTitle?: string;
  backupPath?: string;
  error?: string;
};

export function buildApplyOperations(plan: CleanupPlan): CleanupApplyOperation[] {
  const operations: CleanupApplyOperation[] = [];

  for (const rec of plan.recommendations) {
    if (rec.action === 'delete') {
      for (const slug of rec.slugs) {
        operations.push(deleteOperation(rec, slug));
      }
      continue;
    }

    if ((rec.action === 'merge_duplicate' || rec.action === 'review_merge') && rec.deleteSlugs) {
      for (const slug of rec.deleteSlugs) {
        operations.push(deleteOperation(rec, slug));
      }
      continue;
    }

    if (rec.action === 'fix_title' && rec.suggestedTitle) {
      const slug = rec.slugs[0];
      if (!slug) continue;
      operations.push({
        action: 'fix-title',
        approval: `fix-title:${slug}`,
        slug,
        sourceAction: rec.action,
        confidence: rec.confidence,
        reason: rec.reason,
        suggestedTitle: rec.suggestedTitle,
      });
    }
  }

  return operations;
}

export function filterApplyOperations(
  operations: CleanupApplyOperation[],
  opts: Pick<CleanupApplyOptions, 'actions' | 'slugs'>
): CleanupApplyOperation[] {
  return operations.filter(op => {
    if (opts.actions.length > 0 && !opts.actions.some(action => matchesActionFilter(op, action))) {
      return false;
    }
    if (opts.slugs.length > 0 && !opts.slugs.includes(op.slug)) {
      return false;
    }
    return true;
  });
}

function matchesActionFilter(
  operation: CleanupApplyOperation,
  action: CleanupApplyAction | CleanupAction
): boolean {
  if (action === 'fix-title') return operation.action === 'fix-title';
  return operation.sourceAction === action;
}

export function validateApprovals(operations: CleanupApplyOperation[], approvals: string[]): void {
  const known = new Set(operations.map(op => op.approval));
  const unknown = approvals.filter(approval => !known.has(approval));
  if (unknown.length > 0) {
    throw new Error(`Approval token does not match the current selected plan: ${unknown.join(', ')}`);
  }
}

export function updateMarkdownTitle(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') {
    return [
      '---',
      `title: ${yamlString(title)}`,
      '---',
      '',
      markdown,
    ].join('\n');
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return [
      '---',
      `title: ${yamlString(title)}`,
      '---',
      '',
      markdown,
    ].join('\n');
  }

  const frontmatter = lines.slice(1, endIdx);
  const body = lines.slice(endIdx);
  const updatedFrontmatter: string[] = [];
  let titleWritten = false;

  for (let i = 0; i < frontmatter.length; i++) {
    const line = frontmatter[i];
    const match = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    const key = match?.[1] || '';
    const value = match?.[2]?.trim() || '';

    if (key === 'title') {
      updatedFrontmatter.push(`title: ${yamlString(title)}`);
      titleWritten = true;
      if (isYamlBlockScalar(value)) {
        while (i + 1 < frontmatter.length && /^\s+/.test(frontmatter[i + 1])) i++;
      }
      continue;
    }

    if (isMalformedTitleFragment(line, title)) continue;
    updatedFrontmatter.push(line);
  }

  if (!titleWritten) {
    updatedFrontmatter.unshift(`title: ${yamlString(title)}`);
  }

  return ['---', ...updatedFrontmatter, ...body].join('\n');
}

export async function runCleanupApply(
  opts: CleanupApplyOptions,
  gbrain: GbrainClient = defaultGbrainClient()
): Promise<CleanupApplySummary> {
  if (!opts.dryRun && opts.approvals.length === 0) {
    throw new Error('--execute requires at least one --approve action:slug token');
  }

  const items = await loadCorpusItems(opts.listLimit);
  const markdownBySlug = await loadMarkdownBySlug(items);
  const plan = buildCleanupPlan(items, markdownBySlug);
  const selected = filterApplyOperations(buildApplyOperations(plan), opts);
  validateApprovals(selected, opts.approvals);

  const approvalSet = new Set(opts.approvals);
  const results: CleanupApplyResult[] = [];
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = opts.logPath || defaultDataPath('.cleanup-actions.jsonl');
  const backupDir = opts.backupDir || path.join(defaultDataPath('.cleanup-backups'), runId);

  for (const operation of selected) {
    const approved = approvalSet.has(operation.approval);
    if (opts.dryRun) {
      results.push({
        operation,
        status: approved ? 'approved_dry_run' : 'pending_approval',
      });
      continue;
    }

    if (!approved) {
      results.push({ operation, status: 'skipped' });
      continue;
    }

    try {
      const before = markdownBySlug[operation.slug] || await gbrain.get(operation.slug);
      const backupPath = await writeBackup(backupDir, operation.slug, before);

      if (operation.action === 'delete') {
        await gbrain.delete(operation.slug);
      } else if (operation.action === 'fix-title') {
        const updated = updateMarkdownTitle(before, operation.suggestedTitle || '');
        await gbrain.put(operation.slug, updated);
      }

      await writeAuditEvent(logPath, {
        timestamp: new Date().toISOString(),
        runId,
        status: 'applied',
        action: operation.action,
        approval: operation.approval,
        slug: operation.slug,
        sourceAction: operation.sourceAction,
        confidence: operation.confidence,
        reason: operation.reason,
        keepSlug: operation.keepSlug,
        suggestedTitle: operation.suggestedTitle,
        backupPath,
      });

      results.push({ operation, status: 'applied', backupPath });
    } catch (err: any) {
      const error = err?.message || String(err);
      await writeAuditEvent(logPath, {
        timestamp: new Date().toISOString(),
        runId,
        status: 'failed',
        action: operation.action,
        approval: operation.approval,
        slug: operation.slug,
        sourceAction: operation.sourceAction,
        confidence: operation.confidence,
        reason: operation.reason,
        keepSlug: operation.keepSlug,
        suggestedTitle: operation.suggestedTitle,
        error,
      });
      results.push({ operation, status: 'failed', error });
    }
  }

  return summarizeApplyResults({
    dryRun: opts.dryRun,
    scanned: plan.scanned,
    logPath,
    backupDir,
    results,
  });
}

export function summarizeApplyResults(input: {
  dryRun: boolean;
  scanned: number;
  logPath?: string;
  backupDir?: string;
  results: CleanupApplyResult[];
}): CleanupApplySummary {
  const approved = input.results.filter(result =>
    result.status === 'approved_dry_run' || result.status === 'applied' || result.status === 'failed'
  ).length;
  const applied = input.results.filter(result => result.status === 'applied').length;
  const skipped = input.results.filter(result => result.status === 'pending_approval' || result.status === 'skipped').length;
  const failed = input.results.filter(result => result.status === 'failed').length;

  return {
    dryRun: input.dryRun,
    scanned: input.scanned,
    selected: input.results.length,
    approved,
    applied,
    skipped,
    failed,
    logPath: input.logPath,
    backupDir: input.backupDir,
    results: input.results,
  };
}

export function formatCleanupApplySummary(summary: CleanupApplySummary): string {
  const lines: string[] = [
    `ClipBrain cleanup apply ${summary.dryRun ? 'dry run' : 'execute'}`,
    `Scanned: ${summary.scanned}`,
    `Selected operations: ${summary.selected}`,
    `Approved: ${summary.approved}`,
    `Applied: ${summary.applied}`,
    `Skipped: ${summary.skipped}`,
    `Failed: ${summary.failed}`,
  ];

  if (!summary.dryRun) {
    if (summary.logPath) lines.push(`Audit log: ${summary.logPath}`);
    if (summary.backupDir) lines.push(`Backups: ${summary.backupDir}`);
  }

  if (summary.results.length > 0) {
    lines.push('');
    lines.push('Operations:');
    for (const result of summary.results) {
      const op = result.operation;
      const title = op.suggestedTitle ? ` title="${op.suggestedTitle}"` : '';
      const keep = op.keepSlug ? ` keep=${op.keepSlug}` : '';
      const error = result.error ? ` error="${result.error}"` : '';
      lines.push(`- ${result.status} ${op.approval} [${op.confidence}/${op.sourceAction}]${keep}${title}${error}`);
    }
  }

  if (summary.dryRun) {
    lines.push('');
    lines.push('To execute, rerun with --execute and repeat each exact --approve token you want applied.');
  }

  return lines.join('\n');
}

export function parseCleanupApplyArgs(argv: string[]): CleanupApplyOptions {
  const opts: CleanupApplyOptions = {
    dryRun: true,
    listLimit: 10000,
    approvals: [],
    actions: [],
    slugs: [],
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--execute') opts.dryRun = false;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--list-limit') opts.listLimit = parsePositiveInt(next(), '--list-limit');
    else if (arg === '--approve') opts.approvals.push(normalizeApproval(next()));
    else if (arg === '--action') opts.actions.push(parseActionFilter(next()));
    else if (arg === '--slug') opts.slugs.push(next());
    else if (arg === '--log-path') opts.logPath = next();
    else if (arg === '--backup-dir') opts.backupDir = next();
    else if (arg === '--help' || arg === '-h') throw new HelpRequested();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function deleteOperation(rec: CleanupRecommendation, slug: string): CleanupApplyOperation {
  return {
    action: 'delete',
    approval: `delete:${slug}`,
    slug,
    sourceAction: rec.action,
    confidence: rec.confidence,
    reason: rec.reason,
    keepSlug: rec.keepSlug,
  };
}

function normalizeApproval(raw: string): string {
  const [action, ...rest] = raw.split(':');
  const slug = rest.join(':').trim();
  if (!slug) throw new Error('--approve must look like delete:<slug> or fix-title:<slug>');
  const normalizedAction = parseApplyAction(action.trim());
  return `${normalizedAction}:${slug}`;
}

function parseActionFilter(raw: string): CleanupApplyAction | CleanupAction {
  if (raw === 'fix_title') return 'fix-title';
  if (raw === 'fix-title') return 'fix-title';
  if (raw === 'delete') return 'delete';
  if (raw === 'review_merge' || raw === 'merge_duplicate') return raw;
  throw new Error('--action must be one of: delete, fix-title, review_merge, merge_duplicate');
}

function parseApplyAction(raw: string): CleanupApplyAction {
  if (raw === 'delete') return 'delete';
  if (raw === 'fix-title' || raw === 'fix_title') return 'fix-title';
  throw new Error('--approve action must be delete or fix-title');
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function isYamlBlockScalar(value: string): boolean {
  return value === '>' || value === '>-' || value === '>+' || value === '|' || value === '|-' || value === '|+';
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isMalformedTitleFragment(line: string, title: string): boolean {
  const key = title.split(':')[0]?.trim();
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}:\\s+`, 'i').test(line.trim()) && /\/\s*X"?$/i.test(line.trim());
}

function defaultDataPath(name: string): string {
  return path.join(process.env.CLIPBRAIN_DATA_DIR || import.meta.dir, name);
}

async function writeBackup(backupDir: string, slug: string, markdown: string): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const filePath = path.join(backupDir, `${safeSlug(slug)}.md`);
  await Bun.write(filePath, markdown);
  return filePath;
}

function safeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9._-]+/g, '__');
}

async function writeAuditEvent(logPath: string, event: AuditEvent): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(event)}\n`, 'utf8');
}

function resolveGbrainCommand(): string[] {
  if (process.env.GBRAIN_BIN) return [process.env.GBRAIN_BIN];
  return ['gbrain'];
}

function defaultGbrainClient(): GbrainClient {
  return {
    get: slug => gbrainExecText(['get', slug]),
    put: (slug, markdown) => gbrainPut(slug, markdown),
    delete: slug => gbrainExecText(['delete', slug]).then(() => undefined),
  };
}

async function gbrainExecText(args: string[]): Promise<string> {
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

async function gbrainPut(slug: string, markdown: string): Promise<void> {
  const proc = Bun.spawn([...resolveGbrainCommand(), 'put', slug], {
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

class HelpRequested extends Error {}

function printHelp() {
  console.log([
    'Usage: bun run cleanup-apply.ts [options]',
    '',
    'Dry-run is the default. This command only writes when --execute is present',
    'and every operation has an exact --approve token.',
    '',
    'Examples:',
    '  bun run cleanup-apply',
    '  bun run cleanup-apply --action delete',
    '  bun run cleanup-apply --execute --approve delete:web/test-article',
    '  bun run cleanup-apply --execute --approve fix-title:web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x',
    '',
    'Options:',
    '  --execute           Apply approved operations',
    '  --dry-run           Preview operations without writes (default)',
    '  --approve A:S       Approve one operation, e.g. delete:<slug> or fix-title:<slug>',
    '  --action A          Filter to delete, fix-title, review_merge, or merge_duplicate',
    '  --slug S            Filter to one operation slug',
    '  --list-limit N      Max pages to list from gbrain (default: 10000)',
    '  --log-path P        Override audit log path',
    '  --backup-dir P      Override backup directory',
    '  --json              Emit JSON summary',
  ].join('\n'));
}

if (import.meta.main) {
  try {
    const opts = parseCleanupApplyArgs(process.argv.slice(2));
    const summary = await runCleanupApply(opts);
    console.log(opts.json ? JSON.stringify(summary, null, 2) : formatCleanupApplySummary(summary));
  } catch (err: any) {
    if (err instanceof HelpRequested) {
      printHelp();
      process.exit(0);
    }
    console.error(`[cleanup-apply] ${err?.message || String(err)}`);
    process.exit(1);
  }
}
