import { isClipBrainSlug, parseGbrainList } from './backfill.ts';
import type { BackfillListItem } from './backfill.ts';

export const CLIPBRAIN_CAPTURE_PREFIXES = ['kindle/', 'web/', 'pdf/', 'youtube/', 'email/'];
export const GBRAIN_LIST_FALLBACK_TYPES = ['reference', 'note'];
export const GBRAIN_LIST_FALLBACK_SORTS = ['updated_desc', 'updated_asc', 'created_desc', 'slug'];

export type GbrainExec = (args: string[]) => Promise<string>;

export function isClipBrainCaptureSlug(slug: string): boolean {
  return CLIPBRAIN_CAPTURE_PREFIXES.some(prefix => slug.startsWith(prefix));
}

export function buildGbrainListCommands(listLimit: number): string[][] {
  const commands: string[][] = [['list', '--limit', String(listLimit)]];

  for (const type of GBRAIN_LIST_FALLBACK_TYPES) {
    for (const sort of GBRAIN_LIST_FALLBACK_SORTS) {
      commands.push(['list', '--type', type, '--limit', String(listLimit), '--sort', sort]);
    }
  }

  return commands;
}

export function mergeUniqueGbrainListItems(outputs: string[]): BackfillListItem[] {
  const bySlug = new Map<string, BackfillListItem>();

  for (const output of outputs) {
    for (const item of parseGbrainList(output)) {
      if (!item.slug || bySlug.has(item.slug)) continue;
      bySlug.set(item.slug, item);
    }
  }

  return [...bySlug.values()];
}

export function mergeUniqueGbrainListOutputs(outputs: string[]): string {
  return mergeUniqueGbrainListItems(outputs)
    .map(item => [item.slug, item.type, item.date, item.title].join('\t'))
    .join('\n');
}

export async function loadGbrainListOutputs(
  exec: GbrainExec,
  listLimit: number,
): Promise<string[]> {
  const outputs: string[] = [];
  const errors: string[] = [];

  for (const command of buildGbrainListCommands(listLimit)) {
    try {
      outputs.push(await exec(command));
    } catch (err: any) {
      errors.push(`${command.join(' ')}: ${err?.message || String(err)}`);
    }
  }

  if (outputs.length === 0) {
    throw new Error(`All gbrain list commands failed: ${errors.join('; ')}`);
  }

  return outputs;
}

export async function loadGbrainListItems(
  exec: GbrainExec,
  listLimit: number,
): Promise<BackfillListItem[]> {
  return mergeUniqueGbrainListItems(await loadGbrainListOutputs(exec, listLimit));
}

export async function loadClipBrainListItems(
  exec: GbrainExec,
  listLimit: number,
): Promise<BackfillListItem[]> {
  return (await loadGbrainListItems(exec, listLimit)).filter(item => isClipBrainSlug(item.slug));
}

export async function loadClipBrainListOutput(
  exec: GbrainExec,
  listLimit: number,
): Promise<string> {
  const items = await loadClipBrainListItems(exec, listLimit);
  return items.map(item => [item.slug, item.type, item.date, item.title].join('\t')).join('\n');
}
