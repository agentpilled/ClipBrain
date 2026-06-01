import { describe, expect, test } from 'bun:test';
import {
  addDuplicateSafetyChecks,
  buildApplyOperations,
  filterApplyOperations,
  formatCleanupApplySummary,
  parseCleanupApplyArgs,
  summarizeApplyResults,
  updateMarkdownTitle,
  validateApprovals,
  verifyDuplicateDeleteSafety,
} from '../cleanup-apply.ts';
import type { CleanupPlan } from '../cleanup-plan.ts';

describe('cleanup apply helpers', () => {
  test('builds approval-scoped operations from a cleanup plan', () => {
    const operations = buildApplyOperations(planFixture());

    expect(operations).toEqual([
      expect.objectContaining({
        action: 'delete',
        approval: 'delete:web/test-article',
        sourceAction: 'delete',
      }),
      expect.objectContaining({
        action: 'delete',
        approval: 'delete:web/garry-tan-on-x',
        sourceAction: 'merge_duplicate',
        keepSlug: 'web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x',
      }),
      expect.objectContaining({
        action: 'fix-title',
        approval: 'fix-title:web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x',
        suggestedTitle: 'Resolvers: The Routing Table for Intelligence',
      }),
    ]);
  });

  test('filters operations by operation action, source action, and slug', () => {
    const operations = buildApplyOperations(planFixture());

    expect(filterApplyOperations(operations, { actions: ['fix-title'], slugs: [] }))
      .toHaveLength(1);
    expect(filterApplyOperations(operations, { actions: ['delete'], slugs: [] }))
      .toEqual([expect.objectContaining({ slug: 'web/test-article' })]);
    expect(filterApplyOperations(operations, { actions: ['merge_duplicate'], slugs: [] }))
      .toEqual([expect.objectContaining({ slug: 'web/garry-tan-on-x' })]);
    expect(filterApplyOperations(operations, { actions: [], slugs: ['web/test-article'] }))
      .toEqual([expect.objectContaining({ approval: 'delete:web/test-article' })]);
  });

  test('requires approval tokens to match the selected current plan', () => {
    const operations = buildApplyOperations(planFixture());

    expect(() => validateApprovals(operations, ['delete:web/test-article'])).not.toThrow();
    expect(() => validateApprovals(operations, ['delete:web/missing']))
      .toThrow('Approval token does not match');
  });

  test('updates frontmatter title and removes malformed title fragments', () => {
    const original = [
      '---',
      "type: reference",
      "title: 'Garry Tan on X: \\'",
      'summary: >-',
      '  The content emphasizes resolvers.',
      'Resolvers: The Routing Table for Intelligence\\" / X"',
      "source_url: 'https://x.com/garrytan/status/1'",
      '---',
      '',
      'Body',
    ].join('\n');

    const updated = updateMarkdownTitle(original, 'Resolvers: The Routing Table for Intelligence');

    expect(updated).toContain('title: "Resolvers: The Routing Table for Intelligence"');
    expect(updated).not.toContain('Resolvers: The Routing Table for Intelligence\\" / X"');
    expect(updated).toContain("source_url: 'https://x.com/garrytan/status/1'");
  });

  test('parses CLI args with dry-run default and explicit approvals', () => {
    expect(parseCleanupApplyArgs([])).toEqual(expect.objectContaining({
      dryRun: true,
      approvals: [],
    }));

    expect(parseCleanupApplyArgs([
      '--execute',
      '--approve',
      'fix_title:web/garry-tan-on-x',
      '--action',
      'fix_title',
      '--slug',
      'web/garry-tan-on-x',
    ])).toEqual(expect.objectContaining({
      dryRun: false,
      approvals: ['fix-title:web/garry-tan-on-x'],
      actions: ['fix-title'],
      slugs: ['web/garry-tan-on-x'],
    }));
  });

  test('formats approval status in dry-run summary', () => {
    const operation = buildApplyOperations(planFixture())[0];
    const summary = summarizeApplyResults({
      dryRun: true,
      scanned: 3,
      results: [
        { operation, status: 'pending_approval' },
      ],
    });

    expect(formatCleanupApplySummary(summary)).toContain('ClipBrain cleanup apply dry run');
    expect(formatCleanupApplySummary(summary)).toContain('pending_approval delete:web/test-article');
    expect(formatCleanupApplySummary(summary)).toContain('To execute, rerun with --execute');
  });

  test('verifies duplicate deletes by checking quoted evidence coverage', () => {
    const deleteMarkdown = [
      '---',
      'title: "Delete"',
      'processed_at: 2026-04-15T00:00:00.000Z',
      '---',
      '',
      '## Summary',
      '',
      'Generated text.',
      '',
      '---',
      '',
      '## Highlights',
      '',
      '> Same duplicate quote. (Page 1)',
      '> Another duplicate quote. (Location 42)',
    ].join('\n');
    const keepMarkdown = [
      '---',
      'title: "Keep"',
      'processed_at: 2026-06-01T00:00:00.000Z',
      '---',
      '',
      '## Summary',
      '',
      'Generated text.',
      '',
      '---',
      '',
      '## Highlights',
      '',
      '> Same duplicate quote.',
      '> Another duplicate quote.',
      '> Extra duplicate quote.',
    ].join('\n');

    expect(verifyDuplicateDeleteSafety(deleteMarkdown, keepMarkdown)).toEqual(expect.objectContaining({
      status: 'verified_duplicate',
      evidenceCount: 2,
      missingEvidenceCount: 0,
    }));
  });

  test('flags duplicate deletes that contain missing quoted evidence', () => {
    const check = verifyDuplicateDeleteSafety(
      '---\ntitle: "Delete"\n---\n\n> Unique quote.\n',
      '---\ntitle: "Keep"\n---\n\n> Different quote.\n',
    );

    expect(check).toEqual(expect.objectContaining({
      status: 'needs_review',
      missingEvidenceCount: 1,
      missingSamples: ['Unique quote.'],
    }));
  });

  test('normalizes duplicate evidence with diacritics', () => {
    const check = verifyDuplicateDeleteSafety(
      '---\ntitle: "Delete"\n---\n\n> Café útil para acción rápida.\n',
      '---\ntitle: "Keep"\n---\n\n> Cafe util para accion rapida.\n',
    );

    expect(check).toEqual(expect.objectContaining({
      status: 'verified_duplicate',
      evidenceCount: 1,
      missingEvidenceCount: 0,
    }));
  });

  test('formats duplicate safety in apply summaries', () => {
    const operations = addDuplicateSafetyChecks(buildApplyOperations(planFixture()), {
      'web/garry-tan-on-x': '---\ntitle: "Delete"\n---\n\n> Same duplicate quote.\n',
      'web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x': '---\ntitle: "Keep"\n---\n\n> Same duplicate quote.\n',
    });
    const operation = operations.find(op => op.sourceAction === 'merge_duplicate')!;
    const summary = summarizeApplyResults({
      dryRun: true,
      scanned: 3,
      results: [{ operation, status: 'pending_approval' }],
    });

    expect(formatCleanupApplySummary(summary))
      .toContain('safety=verified_duplicate evidence=1');
  });
});

function planFixture(): CleanupPlan {
  return {
    scanned: 3,
    recommendations: [
      {
        action: 'delete',
        confidence: 'high',
        slugs: ['web/test-article'],
        reason: 'Test capture.',
      },
      {
        action: 'merge_duplicate',
        confidence: 'medium',
        slugs: [
          'web/garry-tan-on-x',
          'web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x',
        ],
        keepSlug: 'web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x',
        deleteSlugs: ['web/garry-tan-on-x'],
        reason: 'Duplicate source URL.',
      },
      {
        action: 'fix_title',
        confidence: 'medium',
        slugs: ['web/garry-tan-on-x-resolvers-the-routing-table-for-intelligence-x'],
        suggestedTitle: 'Resolvers: The Routing Table for Intelligence',
        reason: 'Malformed title.',
      },
    ],
  };
}
