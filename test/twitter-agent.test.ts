import { describe, expect, test } from 'bun:test';
import {
  characterCount,
  extractLatestChangelog,
  extractReadmeValueProp,
  formatDraftPackMarkdown,
  generateDraftPack,
  parseArgs,
  parseGitLog,
  runTwitterAgent,
} from '../twitter-agent.ts';
import type { RepoSignals } from '../twitter-agent.ts';

describe('twitter agent helpers', () => {
  test('parses recent git commits from oneline output', () => {
    expect(parseGitLog([
      'abc1234 Add first-run onboarding',
      'def5678 Fix context pack snippets',
      'not-a-commit-line',
    ].join('\n'))).toEqual([
      { hash: 'abc1234', message: 'Add first-run onboarding' },
      { hash: 'def5678', message: 'Fix context pack snippets' },
    ]);
  });

  test('extracts the public value prop from README copy', () => {
    expect(extractReadmeValueProp('# ClipBrain\n\n**Clip anything into agent-ready memory.**'))
      .toBe('Clip anything into agent-ready memory.');
  });

  test('extracts the latest changelog section', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [0.2.5] - 2026-06-15',
      '',
      'Your AI now sees the **bigger picture** across a whole answer.',
      '',
      '## [0.2.4] - 2026-06-09',
      '',
      'Older note.',
    ].join('\n');

    expect(extractLatestChangelog(changelog)).toEqual({
      version: '0.2.5',
      date: '2026-06-15',
      notes: ['Your AI now sees the bigger picture across a whole answer.'],
    });
  });

  test('generates a complete draft pack from repo signals', () => {
    const pack = generateDraftPack(signals());

    expect(pack.shortPosts).toHaveLength(6);
    expect(pack.shortPosts.some(post => post.label === 'Latest release')).toBe(true);
    expect(pack.thread.posts).toHaveLength(5);
    expect(pack.demoIdea.steps.length).toBeGreaterThanOrEqual(4);
    expect(pack.replies).toHaveLength(3);
    expect(pack.editorChecklist.join('\n')).toContain('screenshot');
    expect(pack.warnings.join('\n')).toContain('Draft-only');
    expect(pack.sourceSignals.join('\n')).toContain('Commit abc1234');
  });

  test('formats draft pack as reviewable markdown', () => {
    const text = formatDraftPackMarkdown(generateDraftPack(signals()));

    expect(text).toContain('# ClipBrain Twitter Drafts - 2026-06-26');
    expect(text).toContain('Best first post:');
    expect(text).toContain('chars)');
    expect(text).toContain('## Short Posts');
    expect(text).toContain('## Thread');
    expect(text).toContain('## Demo Idea');
    expect(text).toContain('## Editor Checklist');
    expect(text).toContain('## Warnings');
  });

  test('counts draft characters for review', () => {
    expect(characterCount('abc\n123')).toBe(7);
  });

  test('parses CLI args safely', () => {
    expect(parseArgs(['--dry-run', '--date', '2026-06-26', '--topic', 'first-run magic', '--commit-limit', '3']))
      .toEqual({
        dryRun: true,
        date: '2026-06-26',
        topic: 'first-run magic',
        commitLimit: 3,
      });

    expect(() => parseArgs(['--commit-limit', '0'])).toThrow('positive integer');
    expect(() => parseArgs(['--topic'])).toThrow('requires a value');
  });

  test('dry-run returns markdown without writing a draft file', async () => {
    const result = await runTwitterAgent({
      cwd: import.meta.dir,
      date: '2026-06-26',
      dryRun: true,
      commandRunner: async () => ({
        exitCode: 0,
        stdout: 'abc1234 Add Twitter draft agent\n',
        stderr: '',
      }),
    });

    expect(result.path).toBeUndefined();
    expect(result.markdown).toContain('ClipBrain Twitter Drafts - 2026-06-26');
  });
});

function signals(): RepoSignals {
  return {
    date: '2026-06-26',
    topic: 'first-run magic',
    valueProp: 'Clip anything into agent-ready memory.',
    latestChangelog: {
      version: '0.2.5',
      date: '2026-06-15',
      notes: ['The context pack adds a "You Also Saved" section for connected reading.'],
    },
    recentCommits: [
      { hash: 'abc1234', message: 'Add Twitter draft agent' },
      { hash: 'def5678', message: 'Fix context pack snippets' },
    ],
  };
}
