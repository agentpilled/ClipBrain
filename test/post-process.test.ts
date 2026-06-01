import { describe, test, expect } from 'bun:test';
import {
  parseOpenAIResponse,
  enrichMarkdown,
  generateWikilinks,
  getBackfillReason,
  getKnowledgeCompilerVersion,
  isAlreadyProcessed,
  isCurrentKnowledgeCompiler,
  KNOWLEDGE_COMPILER_VERSION,
  parseFrontmatter,
  wrapLongMarkdownLines,
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
            importance: 'It sharpens how agents should reason about user decisions.',
            tags: ['psychology', 'decision-making', 'biases'],
            atoms: {
              claims: ['Cognitive biases systematically distort judgment.'],
              quotes: ['What you see is all there is.'],
              entities: [
                { name: 'Daniel Kahneman', type: 'person', relevance: 'Author connected to the core concept' },
              ],
              questions: ['Where do these biases affect product decisions?'],
              actions: ['Use this as a checklist when reviewing strategy.'],
            },
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
    expect(result!.importance).toBe('It sharpens how agents should reason about user decisions.');
    expect(result!.tags).toEqual(['psychology', 'decision-making', 'biases']);
    expect(result!.atoms!.claims).toEqual(['Cognitive biases systematically distort judgment.']);
    expect(result!.atoms!.quotes).toEqual(['What you see is all there is.']);
    expect(result!.atoms!.entities[0]).toEqual({
      name: 'Daniel Kahneman',
      type: 'person',
      relevance: 'Author connected to the core concept',
    });
    expect(result!.atoms!.questions).toEqual(['Where do these biases affect product decisions?']);
    expect(result!.atoms!.actions).toEqual(['Use this as a checklist when reviewing strategy.']);
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

  test('defaults missing atoms to empty arrays for legacy responses', () => {
    const data = {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'Legacy response',
            tags: ['legacy'],
            connections: [],
          }),
        },
      }],
    };

    const result = parseOpenAIResponse(data);
    expect(result!.atoms).toEqual({
      claims: [],
      quotes: [],
      entities: [],
      questions: [],
      actions: [],
    });
  });

  test('limits and sanitizes knowledge atoms', () => {
    const data = {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'Test',
            tags: ['test'],
            atoms: {
              claims: ['Claim 1', 'Claim 1', 'Claim 2', 'Claim 3', 'Claim 4', 'Claim 5', 'Claim 6'],
              quotes: ['Quote 1', 'Quote 2', 'Quote 3', 'Quote 4'],
              entities: [
                { name: 'OpenAI', type: 'company', relevance: 'Model provider' },
                { name: 'OpenAI', type: 'company', relevance: 'Duplicate' },
                { name: 'Unknown Type', type: 'organization', relevance: 'Falls back' },
              ],
              questions: ['Q1?', 'Q2?', 'Q3?', 'Q4?'],
              actions: ['A1', 'A2', 'A3', 'A4'],
            },
            connections: [],
          }),
        },
      }],
    };

    const result = parseOpenAIResponse(data);
    expect(result!.atoms!.claims).toEqual(['Claim 1', 'Claim 2', 'Claim 3', 'Claim 4', 'Claim 5']);
    expect(result!.atoms!.quotes).toEqual(['Quote 1', 'Quote 2', 'Quote 3']);
    expect(result!.atoms!.entities).toEqual([
      { name: 'OpenAI', type: 'company', relevance: 'Model provider' },
      { name: 'Unknown Type', type: 'other', relevance: 'Falls back' },
    ]);
    expect(result!.atoms!.questions).toEqual(['Q1?', 'Q2?', 'Q3?']);
    expect(result!.atoms!.actions).toEqual(['A1', 'A2', 'A3']);
  });
});

describe('wrapLongMarkdownLines', () => {
  test('wraps long prose lines without dropping content', () => {
    const original = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const wrapped = wrapLongMarkdownLines(original, 80);

    expect(wrapped.split('\n').every(line => line.length <= 80)).toBe(true);
    expect(wrapped.replace(/\s+/g, ' ').trim()).toBe(original);
  });

  test('preserves quote prefixes when wrapping', () => {
    const original = `> ${Array.from({ length: 40 }, (_, i) => `quote${i}`).join(' ')}`;
    const wrapped = wrapLongMarkdownLines(original, 70);

    expect(wrapped.split('\n').every(line => line.startsWith('> '))).toBe(true);
    expect(wrapped.replace(/>\s*/g, '').replace(/\s+/g, ' ').trim())
      .toBe(original.replace(/^>\s*/, ''));
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
    importance: 'It turns a generic testing article into reusable QA guidance.',
    tags: ['testing', 'software', 'quality'],
    atoms: {
      claims: ['Fast feedback loops improve software quality.'],
      quotes: ['Tests are executable expectations.'],
      entities: [
        { name: 'Unit Testing', type: 'concept', relevance: 'Core practice described by the article' },
      ],
      questions: ['Which checks should run before every commit?'],
      actions: ['Add regression tests for changed behavior.'],
    },
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

  test('adds importance to frontmatter and body', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('importance: "It turns a generic testing article into reusable QA guidance."');
    expect(enriched).toContain('## Why It Matters');
    expect(enriched).toContain('It turns a generic testing article into reusable QA guidance.');
  });

  test('adds processed_at timestamp', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toMatch(/^processed_at: \d{4}-\d{2}-\d{2}T/m);
  });

  test('adds compiler version to frontmatter', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain(`compiler_version: ${KNOWLEDGE_COMPILER_VERSION}`);
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

  test('adds knowledge atoms as searchable markdown sections', () => {
    const enriched = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    expect(enriched).toContain('## Knowledge Atoms');
    expect(enriched).toContain('### Claims');
    expect(enriched).toContain('- Fast feedback loops improve software quality.');
    expect(enriched).toContain('### Quotes');
    expect(enriched).toContain('> Tests are executable expectations.');
    expect(enriched).toContain('### Entities');
    expect(enriched).toContain('- **Unit Testing** (concept) - Core practice described by the article');
    expect(enriched).toContain('### Open Questions');
    expect(enriched).toContain('- Which checks should run before every commit?');
    expect(enriched).toContain('### Actions');
    expect(enriched).toContain('- [ ] Add regression tests for changed behavior.');
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

  test('replaces prior generated compiler sections when reprocessing', () => {
    const first = enrichMarkdown(sampleMarkdown, sampleResult, relatedContent);
    const nextResult: ProcessResult = {
      summary: 'Updated summary.',
      tags: ['updated'],
      atoms: {
        claims: ['Updated claim.'],
        quotes: [],
        entities: [],
        questions: [],
        actions: [],
      },
      connections: [],
    };

    const enriched = enrichMarkdown(first, nextResult, []);
    expect(enriched).toContain('Updated summary.');
    expect(enriched).toContain('- Updated claim.');
    expect(enriched).not.toContain('Fast feedback loops improve software quality.');
    expect(enriched.match(/## Summary/g)).toHaveLength(1);
    expect(enriched.match(/## Knowledge Atoms/g)).toHaveLength(1);
    expect(enriched).toContain('Some article content here.');
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

describe('knowledge compiler version helpers', () => {
  test('detects current compiler version', () => {
    const md = `---\ntitle: "Test"\ncompiler_version: ${KNOWLEDGE_COMPILER_VERSION}\nprocessed_at: 2026-04-14T12:00:00.000Z\n---\nContent`;
    expect(getKnowledgeCompilerVersion(md)).toBe(KNOWLEDGE_COMPILER_VERSION);
    expect(isCurrentKnowledgeCompiler(md)).toBe(true);
    expect(getBackfillReason(md)).toBeNull();
  });

  test('marks unprocessed and legacy processed markdown for backfill', () => {
    expect(getBackfillReason('---\ntitle: "Test"\n---\nContent')).toBe('unprocessed');
    expect(getBackfillReason('---\ntitle: "Test"\nprocessed_at: 2026-04-14T12:00:00.000Z\n---\nContent')).toBe('legacy-processed');
  });

  test('marks outdated compiler versions and forced runs', () => {
    const old = '---\ntitle: "Test"\ncompiler_version: old-version\n---\nContent';
    expect(getBackfillReason(old)).toBe('outdated:old-version');
    expect(getBackfillReason(old, true)).toBe('force');
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

  test('parses folded YAML scalars and block arrays from gbrain output', () => {
    const md = [
      '---',
      'title: >-',
      "  '''Range: Why Generalists Triumph",
      "  by David Epstein'''",
      'tags:',
      '  - cognition',
      '  - specialization',
      'compiler_version: clipbrain-kc-v1',
      '---',
      'Content',
    ].join('\n');

    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.title).toBe('Range: Why Generalists Triumph by David Epstein');
    expect(frontmatter.tags).toEqual(['cognition', 'specialization']);
    expect(frontmatter.compiler_version).toBe('clipbrain-kc-v1');
  });
});
