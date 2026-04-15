import { describe, test, expect } from 'bun:test';
import {
  parseOpenAIResponse,
  enrichMarkdown,
  generateWikilinks,
  isAlreadyProcessed,
  parseFrontmatter,
} from '../post-process.ts';
import type { ProcessResult, Connection } from '../post-process.ts';

// ---------------------------------------------------------------------------
// parseOpenAIResponse
// ---------------------------------------------------------------------------

describe('parseOpenAIResponse', () => {
  test('parses valid OpenAI response', () => {
    const data = {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'This article discusses cognitive biases.',
            tags: ['psychology', 'decision-making', 'biases'],
            connections: [
              { title: 'Thinking Fast and Slow', reason: 'Both cover System 1 vs System 2 thinking' },
            ],
          }),
        },
      }],
    };

    const result = parseOpenAIResponse(data);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('This article discusses cognitive biases.');
    expect(result!.tags).toEqual(['psychology', 'decision-making', 'biases']);
    expect(result!.connections).toHaveLength(1);
    expect(result!.connections[0].title).toBe('Thinking Fast and Slow');
    expect(result!.connections[0].reason).toBe('Both cover System 1 vs System 2 thinking');
  });

  test('handles missing choices gracefully', () => {
    const result = parseOpenAIResponse({});
    expect(result).toBeNull();
  });

  test('handles malformed JSON content', () => {
    const data = {
      choices: [{ message: { content: 'not valid json' } }],
    };
    const result = parseOpenAIResponse(data);
    expect(result).toBeNull();
  });

  test('handles empty content', () => {
    const data = {
      choices: [{ message: { content: '' } }],
    };
    const result = parseOpenAIResponse(data);
    expect(result).toBeNull();
  });

  test('limits tags to 5', () => {
    const data = {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'Test',
            tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
            connections: [],
          }),
        },
      }],
    };

    const result = parseOpenAIResponse(data);
    expect(result!.tags).toHaveLength(5);
  });

  test('filters out non-string tags', () => {
    const data = {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'Test',
            tags: ['valid', 123, null, 'also-valid'],
            connections: [],
          }),
        },
      }],
    };

    const result = parseOpenAIResponse(data);
    expect(result!.tags).toEqual(['valid', 'also-valid']);
  });

  test('filters out malformed connections', () => {
    const data = {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'Test',
            tags: ['test'],
            connections: [
              { title: 'Valid', reason: 'Good reason' },
              { title: 123, reason: 'Bad title' },
              { title: 'Missing reason' },
              null,
            ],
          }),
        },
      }],
    };

    const result = parseOpenAIResponse(data);
    expect(result!.connections).toHaveLength(1);
    expect(result!.connections[0].title).toBe('Valid');
  });
});

// ---------------------------------------------------------------------------
// enrichMarkdown
// ---------------------------------------------------------------------------

describe('enrichMarkdown', () => {
  const sampleMarkdown = [
    '---',
    'title: "Test Article"',
    'type: reference',
    'tags: [web-capture, example.com]',
    'source_url: https://example.com/test',
    'captured_at: 2026-04-14T12:00:00.000Z',
    '---',
    '',
    'Some article content here.',
    '',
    '> A highlight from the article',
    '',
  ].join('\n');

  const sampleResult: ProcessResult = {
    summary: 'This article covers important topics about testing.',
    tags: ['testing', 'software', 'quality'],
    connections: [
      { slug: '', title: 'Unit Testing Guide', reason: 'Both discuss testing methodologies' },
    ],
  };

  const relatedContent = [
    { slug: 'web/example-com/unit-testing-guide', title: 'Unit Testing Guide' },
    { slug: 'kindle/author/some-book', title: 'Some Book' },
  ];

  test('adds summary section', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('## Summary');
    expect(enriched).toContain('This article covers important topics about testing.');
  });

  test('adds AI-generated tags to frontmatter', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('tags: [testing, software, quality]');
  });

  test('adds summary to frontmatter', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('summary: "This article covers important topics about testing."');
  });

  test('adds processed_at timestamp', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toMatch(/^processed_at: \d{4}-\d{2}-\d{2}T/m);
  });

  test('preserves original source_url and captured_at', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('source_url: https://example.com/test');
    expect(enriched).toContain('captured_at: 2026-04-14T12:00:00.000Z');
  });

  test('adds connections with wikilinks', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('## Related');
    expect(enriched).toContain('[[Unit Testing Guide]]');
    expect(enriched).toContain('Both discuss testing methodologies');
  });

  test('adds connections to frontmatter', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('connections:');
    expect(enriched).toContain('  - slug: web/example-com/unit-testing-guide');
  });

  test('preserves original content', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('Some article content here.');
    expect(enriched).toContain('> A highlight from the article');
  });

  test('only keeps connections that match related content slugs', () => {
    const resultWithUnmatched: ProcessResult = {
      summary: 'Test',
      tags: ['test'],
      connections: [
        { slug: '', title: 'Unit Testing Guide', reason: 'Related' },
        { slug: '', title: 'Nonexistent Page', reason: 'Not in knowledge base' },
      ],
    };

    const enriched = enrichMarkdown(sampleMarkdown, resultWithUnmatched, relatedContent);
    expect(enriched).toContain('[[Unit Testing Guide]]');
    expect(enriched).not.toContain('[[Nonexistent Page]]');
  });

  test('handles no connections gracefully', () => {
    const noConnResult: ProcessResult = {
      summary: 'A simple summary.',
      tags: ['simple'],
      connections: [],
    };

    const enriched = enrichMarkdown(sampleMarkdown, noConnResult, []);
    expect(enriched).toContain('## Summary');
    expect(enriched).not.toContain('## Related');
    expect(enriched).not.toContain('connections:');
  });
});

// ---------------------------------------------------------------------------
// generateWikilinks
// ---------------------------------------------------------------------------

describe('generateWikilinks', () => {
  test('generates wikilinks from connections', () => {
    const connections: Connection[] = [
      { slug: 'kindle/sapiens', title: 'Sapiens', reason: 'Both discuss human evolution' },
      { slug: 'web/pg/ideas', title: 'How to Get Startup Ideas', reason: 'Complementary views on ideation' },
    ];

    const result = generateWikilinks(connections);
    expect(result).toContain('[[Sapiens]]');
    expect(result).toContain('[[How to Get Startup Ideas]]');
    expect(result).toContain('Both discuss human evolution');
    expect(result).toContain('Complementary views on ideation');
  });

  test('returns empty string for empty connections', () => {
    expect(generateWikilinks([])).toBe('');
  });

  test('filters out connections with no title', () => {
    const connections: Connection[] = [
      { slug: 'test', title: '', reason: 'No title' },
      { slug: 'test2', title: 'Valid', reason: 'Has title' },
    ];

    const result = generateWikilinks(connections);
    expect(result).not.toContain('[[]]');
    expect(result).toContain('[[Valid]]');
  });
});

// ---------------------------------------------------------------------------
// isAlreadyProcessed
// ---------------------------------------------------------------------------

describe('isAlreadyProcessed', () => {
  test('returns true when processed_at is present', () => {
    const md = '---\ntitle: "Test"\nprocessed_at: 2026-04-14T12:00:00.000Z\n---\nContent';
    expect(isAlreadyProcessed(md)).toBe(true);
  });

  test('returns false when processed_at is absent', () => {
    const md = '---\ntitle: "Test"\ncaptured_at: 2026-04-14T12:00:00.000Z\n---\nContent';
    expect(isAlreadyProcessed(md)).toBe(false);
  });

  test('returns false for empty markdown', () => {
    expect(isAlreadyProcessed('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('parses frontmatter and body', () => {
    const md = '---\ntitle: "Test"\ntype: reference\n---\n\nBody content';
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.title).toBe('Test');
    expect(frontmatter.type).toBe('reference');
    expect(body).toContain('Body content');
  });

  test('handles markdown without frontmatter', () => {
    const md = 'Just some content';
    const { frontmatter, body } = parseFrontmatter(md);
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe('Just some content');
  });

  test('parses array values', () => {
    const md = '---\ntags: [foo, bar, baz]\n---\nContent';
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.tags).toEqual(['foo', 'bar', 'baz']);
  });
});
