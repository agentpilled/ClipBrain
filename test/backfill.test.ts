import { describe, expect, test } from 'bun:test';
import {
  isClipBrainSlug,
  parseBackfillArgs,
  parseGbrainList,
  shouldInspectItem,
} from '../backfill.ts';

describe('backfill helpers', () => {
  test('parses gbrain list output', () => {
    const items = parseGbrainList([
      'web/example-com/article\treference\t2026-06-01\tExample Article',
      'kindle/ryan-holiday/stillness\tbook\t2026-06-01\tStillness Is the Key',
      '',
    ].join('\n'));

    expect(items).toEqual([
      {
        slug: 'web/example-com/article',
        type: 'reference',
        date: '2026-06-01',
        title: 'Example Article',
      },
      {
        slug: 'kindle/ryan-holiday/stillness',
        type: 'book',
        date: '2026-06-01',
        title: 'Stillness Is the Key',
      },
    ]);
  });

  test('recognizes ClipBrain capture slugs', () => {
    expect(isClipBrainSlug('web/example/article')).toBe(true);
    expect(isClipBrainSlug('kindle/author/book')).toBe(true);
    expect(isClipBrainSlug('daily/calendar/2026-06-01')).toBe(false);
  });

  test('filters by capture type and slug prefix', () => {
    const item = {
      slug: 'kindle/ryan-holiday/stillness',
      type: 'book',
      date: '2026-06-01',
      title: 'Stillness Is the Key',
    };

    expect(shouldInspectItem(item, { type: 'kindle' })).toBe(true);
    expect(shouldInspectItem(item, { type: 'web' })).toBe(false);
    expect(shouldInspectItem(item, { slug: 'kindle/ryan-holiday/stillness' })).toBe(true);
    expect(shouldInspectItem(item, { slug: 'kindle/ryan-holiday/other' })).toBe(false);
    expect(shouldInspectItem(item, { slugPrefix: 'kindle/ryan-holiday/' })).toBe(true);
    expect(shouldInspectItem(item, { slugPrefix: 'kindle/other/' })).toBe(false);
  });

  test('parses CLI args safely', () => {
    expect(parseBackfillArgs(['--apply', '--limit', '3', '--slug', 'web/example-com/article', '--type', 'web', '--sleep-ms', '10'])).toEqual({
      dryRun: false,
      force: false,
      limit: 3,
      listLimit: 10000,
      sleepMs: 10,
      json: false,
      slug: 'web/example-com/article',
      type: 'web',
    });
  });

  test('rejects unsafe or malformed filters', () => {
    expect(() => parseBackfillArgs(['--limit', '0'])).toThrow('positive integer');
    expect(() => parseBackfillArgs(['--type', 'daily'])).toThrow('--type');
    expect(() => parseBackfillArgs(['--slug', 'daily/test'])).toThrow('--slug');
    expect(() => parseBackfillArgs(['--slug-prefix', 'daily/'])).toThrow('--slug-prefix');
  });
});
