import { describe, expect, test } from 'bun:test';
import {
  buildCorpusReport,
  classifyCorpusIssues,
  countKnowledgeAtoms,
  findDuplicateGroups,
  normalizeCorpusTitle,
} from '../corpus-report.ts';
import type { CorpusItem } from '../corpus-report.ts';

describe('corpus report helpers', () => {
  test('normalizes titles for duplicate detection', () => {
    expect(normalizeCorpusTitle("'''Range: Why Generalists Triumph'''"))
      .toBe('range why generalists triumph');
    expect(normalizeCorpusTitle('Awareness: Conversations with the Masters by Settings'))
      .toBe('awareness conversations with the masters');
  });

  test('counts knowledge atoms from generated markdown', () => {
    const markdown = [
      '## Knowledge Atoms',
      '',
      '### Claims',
      '',
      '- Claim one',
      '- Claim two',
      '',
      '### Quotes',
      '',
      '> Quote one',
      '',
      '---',
    ].join('\n');

    expect(countKnowledgeAtoms(markdown)).toBe(3);
  });

  test('classifies obvious cleanup candidates', () => {
    expect(classifyCorpusIssues({
      slug: 'web/example-com/article',
      title: 'Test Article',
      frontmatterTitle: 'Test Article',
    })).toContain('test-capture');

    expect(classifyCorpusIssues({
      slug: 'kindle/awareness-conversations-with-the-masters-by-settings',
      title: 'Awareness: Conversations with the Masters by Settings',
      frontmatterTitle: '',
    })).toContain('kindle-import-artifact');

    expect(classifyCorpusIssues({
      slug: 'pdf/my-research-paper',
      title: 'My Research Paper',
      frontmatterTitle: '',
    })).toContain('sample-pdf');
  });

  test('finds duplicate title groups', () => {
    const items: CorpusItem[] = [
      item('kindle/range-a', 'Range: Why Generalists Triumph'),
      item('kindle/range-b', "'''Range: Why Generalists Triumph'''"),
      item('kindle/deep-work', 'Deep Work'),
    ];

    const groups = findDuplicateGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].slugs).toEqual(['kindle/range-a', 'kindle/range-b']);
  });

  test('builds summary report counts', () => {
    const report = buildCorpusReport([
      { ...item('web/test-article', 'Test Article'), issueFlags: ['test-capture'], backfillReason: 'legacy-processed' },
      item('kindle/current', 'Current Book'),
    ]);

    expect(report.scanned).toBe(2);
    expect(report.issueCount).toBe(1);
    expect(report.backfillPending).toBe(1);
  });
});

function item(slug: string, title: string): CorpusItem {
  return {
    slug,
    type: slug.split('/')[0],
    title,
    frontmatterTitle: title,
    backfillReason: null,
    atomCount: 0,
    issueFlags: [],
  };
}
