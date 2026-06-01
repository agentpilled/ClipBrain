import { describe, expect, test } from 'bun:test';
import {
  buildCleanupPlan,
  formatCleanupPlan,
  inferBetterTitle,
  isKindleNoteShell,
} from '../cleanup-plan.ts';
import type { CorpusItem } from '../corpus-report.ts';

describe('cleanup plan helpers', () => {
  test('detects Kindle note shells without substantive content', () => {
    const shell = markdown('Awareness by Settings', [
      '> Note | Page:\u00a03 (Page 3)',
      '> Note | Page:\u00a06 (Page 6)',
      '> Note | Page:\u00a012 (Page 12)',
    ].join('\n'));

    const substantive = markdown('Awareness by Saturday, January 24, 2026', [
      'Highlight | Page: 3',
      'The only way someone can be of help to you is in challenging your ideas.',
    ].join('\n'));

    expect(isKindleNoteShell(shell)).toBe(true);
    expect(isKindleNoteShell(substantive)).toBe(false);
  });

  test('proposes deletes for obvious fixtures and review merge for substantive Kindle artifacts', () => {
    const items = [
      item('pdf/my-research-paper', 'My Research Paper', ['sample-pdf']),
      item('web/test-article', 'Test Article', ['test-capture']),
      item('kindle/awareness-conversations-with-the-masters', 'Awareness Conversations With The Masters'),
      item(
        'kindle/awareness-conversations-with-the-masters-by-settings',
        'Awareness Conversations With The Masters by Settings',
        ['kindle-import-artifact'],
      ),
      item(
        'kindle/awareness-conversations-with-the-masters-by-saturday-january-24-2026',
        'Awareness Conversations With The Masters by Saturday, January 24, 2026',
        ['kindle-import-artifact'],
      ),
    ];

    const plan = buildCleanupPlan(items, {
      'pdf/my-research-paper': markdown('My Research Paper', 'Test document content'),
      'web/test-article': markdown('Test Article', 'Some content'),
      'kindle/awareness-conversations-with-the-masters': markdown('Awareness Conversations With The Masters', 'Canonical book'),
      'kindle/awareness-conversations-with-the-masters-by-settings': markdown(
        'Awareness Conversations With The Masters by Settings',
        'Note | Page: 3\nNote | Page: 6',
      ),
      'kindle/awareness-conversations-with-the-masters-by-saturday-january-24-2026': markdown(
        'Awareness Conversations With The Masters by Saturday, January 24, 2026',
        'Highlight | Page: 3\nThe only way someone can be of help to you is in challenging your ideas.',
      ),
    });

    expect(plan.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'delete', slugs: ['pdf/my-research-paper'] }),
      expect.objectContaining({ action: 'delete', slugs: ['web/test-article'] }),
      expect.objectContaining({ action: 'delete', slugs: ['kindle/awareness-conversations-with-the-masters-by-settings'] }),
      expect.objectContaining({
        action: 'review_merge',
        keepSlug: 'kindle/awareness-conversations-with-the-masters',
        deleteSlugs: ['kindle/awareness-conversations-with-the-masters-by-saturday-january-24-2026'],
      }),
    ]));
  });

  test('proposes duplicate merge and keeps the richer descriptive slug', () => {
    const items = [
      item('web/garry-tan-on-x', 'Garry Tan on X'),
      item('web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x', 'Garry Tan on X'),
    ];

    const plan = buildCleanupPlan(items, {
      'web/garry-tan-on-x': markdown('Garry Tan on X: \\', 'Resolvers: The Routing Table for Intelligence / X', 'https://x.com/garrytan/status/1'),
      'web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x': markdown(
        'Garry Tan on X: \\',
        'Resolvers: The Routing Table for Intelligence / X',
        'https://x.com/garrytan/status/1',
      ),
    });

    expect(plan.recommendations).toContainEqual(expect.objectContaining({
      action: 'merge_duplicate',
      confidence: 'medium',
      keepSlug: 'web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x',
      deleteSlugs: ['web/garry-tan-on-x'],
    }));

    expect(plan.recommendations).toContainEqual(expect.objectContaining({
      action: 'fix_title',
      slugs: ['web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x'],
      suggestedTitle: 'Resolvers: The Routing Table for Intelligence',
    }));
  });

  test('formats a read-only plan summary', () => {
    const plan = buildCleanupPlan([
      item('web/test-article', 'Test Article', ['test-capture']),
    ], {
      'web/test-article': markdown('Test Article', 'Some content'),
    });

    expect(formatCleanupPlan(plan)).toContain('Writes executed: 0');
    expect(formatCleanupPlan(plan)).toContain('Delete candidates:');
  });

  test('infers better X titles from source text', () => {
    const fixture = item('web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x', 'Garry Tan on X');
    expect(inferBetterTitle(fixture, markdown(
      'Garry Tan on X: \\',
      'In "", I introduced five definitions for building agent systems.',
      'https://x.com/garrytan/status/1',
    ))).toBe('Resolvers: The Routing Table for Intelligence');
  });
});

function item(slug: string, title: string, issueFlags: string[] = []): CorpusItem {
  return {
    slug,
    type: slug.split('/')[0],
    title,
    frontmatterTitle: title,
    backfillReason: null,
    atomCount: 0,
    issueFlags,
  };
}

function markdown(title: string, body: string, sourceUrl = ''): string {
  return [
    '---',
    `title: "${title}"`,
    `type: ${title.toLowerCase().includes('awareness') ? 'kindle' : 'web'}`,
    sourceUrl ? `source_url: ${sourceUrl}` : '',
    '---',
    '',
    body,
  ].filter(line => line !== '').join('\n');
}
