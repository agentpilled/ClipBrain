#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type GitCommit = {
  hash: string;
  message: string;
};

export type ChangelogSignal = {
  version: string;
  date: string;
  notes: string[];
};

export type RepoSignals = {
  date: string;
  topic?: string;
  valueProp: string;
  latestChangelog?: ChangelogSignal;
  recentCommits: GitCommit[];
  profileContext?: string;
  voiceSamples?: VoiceSampleSignals;
  replyTargets: ReplyTarget[];
};

export type VoiceSampleSignals = {
  count: number;
  averageChars: number;
  traits: string[];
};

export type TweetDraft = {
  label: string;
  text: string;
  why: string;
};

export type ThreadDraft = {
  label: string;
  posts: string[];
};

export type DemoIdea = {
  title: string;
  steps: string[];
  caption: string;
};

export type ReplyTarget = {
  url?: string;
  context: string;
  angle?: string;
};

export type EngagementPlan = {
  dailyRoutine: string[];
  searchQueries: string[];
  replyTargets: ReplyTarget[];
};

export type TwitterDraftPack = {
  date: string;
  sourceSignals: string[];
  shortPosts: TweetDraft[];
  thread: ThreadDraft;
  demoIdea: DemoIdea;
  engagementPlan: EngagementPlan;
  replies: TweetDraft[];
  warnings: string[];
  editorChecklist: string[];
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandRunner = (args: string[], cwd: string) => Promise<CommandResult>;

type TwitterAgentOptions = {
  cwd?: string;
  date?: string;
  topic?: string;
  commitLimit?: number;
  outDir?: string;
  dryRun?: boolean;
  commandRunner?: CommandRunner;
};

const DEFAULT_COMMIT_LIMIT = 6;
const DEFAULT_OUT_DIR = 'content/twitter/drafts';
const DEFAULT_VALUE_PROP = 'Clip anything into agent-ready memory.';
const PROFILE_CONTEXT_PATH = 'content/twitter/profile-context.md';
const VOICE_SAMPLES_PATH = 'content/twitter/voice-samples.local.md';
const REPLY_TARGETS_PATH = 'content/twitter/reply-targets.local.md';
const STORE_URL = 'https://chromewebstore.google.com/detail/clipbrain/gmoehecpamcidfjdeonfigjenpjbbjoa';

export function parseArgs(argv: string[]): TwitterAgentOptions & { help?: boolean } {
  const opts: TwitterAgentOptions & { help?: boolean } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--date') {
      opts.date = requireValue(arg, next);
      i++;
    } else if (arg === '--topic') {
      opts.topic = requireValue(arg, next);
      i++;
    } else if (arg === '--commit-limit') {
      opts.commitLimit = parsePositiveInt(requireValue(arg, next), arg);
      i++;
    } else if (arg === '--out-dir') {
      opts.outDir = requireValue(arg, next);
      i++;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

export async function collectRepoSignals(opts: TwitterAgentOptions = {}): Promise<RepoSignals> {
  const cwd = opts.cwd || import.meta.dir;
  const date = opts.date || todayLocalIso();
  const commitLimit = opts.commitLimit || DEFAULT_COMMIT_LIMIT;
  const commandRunner = opts.commandRunner || runCommand;

  const [readme, changelog, profileContext, voiceSamples, replyTargets, gitLog] = await Promise.all([
    readRepoFile(cwd, 'README.md'),
    readRepoFile(cwd, 'CHANGELOG.md'),
    readRepoFile(cwd, PROFILE_CONTEXT_PATH),
    readRepoFile(cwd, VOICE_SAMPLES_PATH),
    readRepoFile(cwd, REPLY_TARGETS_PATH),
    commandRunner(['git', 'log', '--oneline', '-n', String(commitLimit)], cwd)
      .then(result => result.exitCode === 0 ? result.stdout : ''),
  ]);

  return {
    date,
    topic: opts.topic,
    valueProp: extractReadmeValueProp(readme),
    latestChangelog: extractLatestChangelog(changelog),
    recentCommits: parseGitLog(gitLog),
    profileContext,
    voiceSamples: parseVoiceSamples(voiceSamples),
    replyTargets: parseReplyTargets(replyTargets),
  };
}

export function generateDraftPack(signals: RepoSignals): TwitterDraftPack {
  const primary = primaryBuildSignal(signals);
  const latestRelease = latestReleasePost(signals);
  const topicLine = signals.topic
    ? `Current focus: ${signals.topic}.`
    : `Current repo signal: ${primary}.`;

  const shortPosts: TweetDraft[] = [
    {
      label: 'Pinned story follow-up',
      why: 'Continues the public origin story instead of sounding like a cold launch post.',
      text: [
        'the thing i want from ClipBrain is simple:',
        '',
        'i read something once.',
        'my agents can use it later.',
        '',
        'kindle highlights, clips, pdfs, saved posts, videos.',
        '',
        'not as a folder.',
        'as working memory.',
      ].join('\n'),
    },
    {
      label: 'Build log',
      why: 'Turns repo progress into a public artifact without overclaiming.',
      text: [
        "Today's ClipBrain build log:",
        '',
        `Working on ${primary}.`,
        '',
        'The product is not done when capture works.',
        '',
        'It is done when the first useful agent answer feels obvious.',
      ].join('\n'),
    },
    {
      label: 'Product detail',
      why: 'Shows the product bar through an implementation detail.',
      text: [
        'A bookmark is inert.',
        '',
        'A ClipBrain capture should become working context:',
        '',
        '- retrieve the source',
        '- pull the highlights',
        '- cite the answer',
        '- surface related reading',
        '- stay local',
        '',
        'That is the bar.',
      ].join('\n'),
    },
    latestRelease,
    {
      label: 'Taste',
      why: 'Positions ClipBrain against the default note-taking graveyard.',
      text: [
        'The taste target for ClipBrain:',
        '',
        'Not a notes app.',
        'Not a bookmark graveyard.',
        'Not another chat wrapper.',
        '',
        'A quiet memory layer between everything you read and the agents doing work with you.',
      ].join('\n'),
    },
    {
      label: 'Founder loop',
      why: 'Makes the building-in-public arc explicit.',
      text: [
        'I am building ClipBrain in public.',
        '',
        `${topicLine}`,
        '',
        'The bar: a stranger should clone it, clip one thing, ask their AI, and feel the click.',
      ].join('\n'),
    },
  ];

  const thread: ThreadDraft = {
    label: 'Why ClipBrain exists',
    posts: [
      'Agents are getting better at doing work.\n\nBut most of them still start every task with a blank memory.',
      'That context is scattered everywhere:\n\nKindle highlights, articles, PDFs, YouTube transcripts, newsletters, old notes, half-remembered links.',
      'ClipBrain turns those saved things into local, searchable, cited memory for MCP agents.\n\nNot a hosted cloud brain. Not a manual prompt dump. A local memory layer.',
      `The current build focus: ${primary}.\n\nI want every improvement to make the first useful agent handoff faster, clearer, or more trustworthy.`,
      'The feeling I am chasing:\n\nclip something once, then later ask your AI a real question and get an answer grounded in what you actually read.',
    ],
  };

  const demoIdea: DemoIdea = {
    title: 'One clip to cited agent context',
    steps: [
      'Clip one article with Cmd+Shift+S.',
      'Open the dashboard and show it appears locally.',
      'Ask the ClipBrain context pack endpoint or MCP tool about that topic.',
      'Show the agent answer with source citations and related saved notes.',
    ],
    caption: 'A bookmark is inert. A ClipBrain capture becomes context your agent can use.',
  };

  const engagementPlan = buildEngagementPlan(signals);
  const replies = buildReplyDrafts(signals);

  return {
    date: signals.date,
    sourceSignals: formatSourceSignals(signals),
    shortPosts,
    thread,
    demoIdea,
    engagementPlan,
    replies,
    warnings: buildWarnings(shortPosts, thread, replies),
    editorChecklist: [
      'Pick one post and make it more specific before posting.',
      'Check profile fit: does this sound like @agentpilled, or like generic product marketing?',
      'Continue the pinned origin story when possible: personal itch, trusted external spark, build proof.',
      signals.voiceSamples
        ? `Compare against ${signals.voiceSamples.count} local voice sample(s) without quoting them verbatim.`
        : `Add 10-20 posts or replies to ${VOICE_SAMPLES_PATH} for stronger voice calibration.`,
      'Attach a screenshot or short screen recording if the post claims product magic.',
      'Remove private captures, email content, exact corpus counts, and provider/API details.',
      'If a post is over 280 characters, either trim it or intentionally post it as a long-form X post.',
      'Spend 20 minutes replying to agent-memory, MCP, local-first AI, and second-brain conversations after posting.',
    ],
  };
}

export function formatDraftPackMarkdown(pack: TwitterDraftPack): string {
  const lines = [
    `# ClipBrain Twitter Drafts - ${pack.date}`,
    '',
    'Draft-only. Review manually before posting.',
    '',
    `Best first post: ${pack.shortPosts[0].label} (${characterCount(pack.shortPosts[0].text)} chars).`,
    '',
    '## Source Signals',
    ...pack.sourceSignals.map(signal => `- ${signal}`),
    '',
    '## Short Posts',
    '',
  ];

  pack.shortPosts.forEach((draft, index) => {
    lines.push(formatDraftTitle(index + 1, draft), '', draft.text, '', `Why: ${draft.why}`, '');
  });

  lines.push('## Thread', '', `### ${pack.thread.label}`, '');
  pack.thread.posts.forEach((post, index) => {
    lines.push(`**${index + 1}. (${characterCount(post)} chars)**`, '', post, '');
  });

  lines.push(
    '## Demo Idea',
    '',
    `### ${pack.demoIdea.title}`,
    '',
    ...pack.demoIdea.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    `Caption: ${pack.demoIdea.caption}`,
    '',
    '## Engagement Plan',
    '',
    '### Daily Routine',
    '',
    ...pack.engagementPlan.dailyRoutine.map(item => `- ${item}`),
    '',
    '### Search Queries',
    '',
    ...pack.engagementPlan.searchQueries.map(query => `- \`${query}\``),
    '',
    '### Reply Targets',
    '',
    ...formatReplyTargets(pack.engagementPlan.replyTargets),
    '',
    '## Suggested Replies',
    '',
  );

  pack.replies.forEach((draft, index) => {
    lines.push(formatDraftTitle(index + 1, draft), '', draft.text, '', `Why: ${draft.why}`, '');
  });

  lines.push('## Editor Checklist', '', ...pack.editorChecklist.map(item => `- ${item}`), '');
  lines.push('## Warnings', '', ...pack.warnings.map(warning => `- ${warning}`), '');

  return lines.join('\n');
}

export async function runTwitterAgent(opts: TwitterAgentOptions = {}): Promise<{ path?: string; markdown: string }> {
  const cwd = opts.cwd || import.meta.dir;
  const signals = await collectRepoSignals({ ...opts, cwd });
  const pack = generateDraftPack(signals);
  const markdown = formatDraftPackMarkdown(pack);

  if (opts.dryRun) return { markdown };

  const outDir = join(cwd, opts.outDir || DEFAULT_OUT_DIR);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${signals.date}.md`);
  await Bun.write(outPath, markdown);
  return { path: outPath, markdown };
}

export function parseGitLog(output: string): GitCommit[] {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^([a-f0-9]+)\s+(.+)$/i);
      if (!match) return null;
      return { hash: match[1], message: match[2] };
    })
    .filter((commit): commit is GitCommit => !!commit);
}

export function extractReadmeValueProp(readme: string): string {
  const bold = readme.match(/\*\*([^*]+)\*\*/);
  if (bold?.[1]) return cleanInlineMarkdown(bold[1]);

  const firstParagraph = readme
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#'));

  return firstParagraph ? cleanInlineMarkdown(firstParagraph) : DEFAULT_VALUE_PROP;
}

export function extractLatestChangelog(changelog: string): ChangelogSignal | undefined {
  const heading = changelog.match(/^## \[([^\]]+)\] - ([0-9-]+)/m);
  if (!heading) return undefined;

  const start = heading.index || 0;
  const rest = changelog.slice(start + heading[0].length);
  const nextHeading = rest.search(/\n## /);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const notes = section
    .split('\n')
    .map(line => cleanInlineMarkdown(line.replace(/^- /, '').trim()))
    .filter(line => line.length > 0)
    .slice(0, 4);

  return {
    version: heading[1],
    date: heading[2],
    notes,
  };
}

export function parseVoiceSamples(markdown: string): VoiceSampleSignals | undefined {
  const samples = [...markdown.matchAll(/```(?:text|tweet)?\n([\s\S]*?)```/g)]
    .map(match => match[1].trim())
    .filter(Boolean);

  if (samples.length === 0) return undefined;

  const averageChars = Math.round(
    samples.reduce((sum, sample) => sum + sample.length, 0) / samples.length,
  );
  const traits = summarizeVoiceTraits(samples);

  return {
    count: samples.length,
    averageChars,
    traits,
  };
}

export function parseReplyTargets(markdown: string): ReplyTarget[] {
  return markdown
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.replace(/^- /, '').trim())
    .map(line => {
      const url = line.match(/https?:\/\/\S+/)?.[0];
      const withoutUrl = url ? line.replace(url, '').trim() : line;
      const cleaned = withoutUrl
        .replace(/^[-:| ]+/, '')
        .replace(/[-:| ]+$/, '')
        .trim();
      const [context, angle] = cleaned.split(/\s+\|\s+/, 2).map(part => part.trim());
      return {
        url,
        context: context || 'Public X conversation',
        angle,
      };
    })
    .filter(target => target.url || target.context);
}

function buildEngagementPlan(signals: RepoSignals): EngagementPlan {
  return {
    dailyRoutine: [
      'Post 1 original idea or product proof before the first reply session.',
      'Reply to 8-12 relevant conversations without links; make the other thread better first.',
      'Use at most 1-2 link replies per day, only when the thread asks for a tool or demo.',
      'Save strong replies that get traction back into the voice sample file later.',
      'End the day by adding promising tweet URLs to content/twitter/reply-targets.local.md.',
    ],
    searchQueries: [
      '"MCP" "memory"',
      '"Claude Code" "memory"',
      '"Codex" "MCP"',
      '"AI agents" "context"',
      '"local-first AI"',
      '"personal knowledge base" "LLM"',
      '"Kindle highlights" "AI"',
      '"Readwise" "agents"',
      '"Obsidian" "MCP"',
      '"GBrain" OR "OpenClaw"',
    ],
    replyTargets: signals.replyTargets,
  };
}

function buildReplyDrafts(signals: RepoSignals): TweetDraft[] {
  const targetReplies = signals.replyTargets.slice(0, 4).map((target, index) => ({
    label: `Target reply ${index + 1}`,
    why: target.url
      ? `Draft against saved target: ${target.url}`
      : 'Draft against a saved local reply target.',
    text: [
      target.angle || 'This is close to the problem I keep thinking about.',
      '',
      'The missing layer is not just more tools.',
      'It is trusted context from what you already read, saved, clipped, or highlighted.',
    ].join('\n'),
  }));

  return [
    ...targetReplies,
    {
      label: 'Reply to agent tooling discussion',
      why: 'Adds a useful angle without hijacking the thread.',
      text: 'Very cool. Tools let agents act, but memory tells them what matters to you. That is the gap I keep coming back to: agents need context from what you already read and saved.',
    },
    {
      label: 'Reply to second brain discussion',
      why: 'Positions ClipBrain as agent-native, not another notes app.',
      text: 'Exactly. The shift is from "a place I can search later" to "context my agents can use now." Same Kindle highlights, blogs, posts, videos. Different product bar.',
    },
    {
      label: 'Reply to local-first AI discussion',
      why: 'Keeps privacy/local-first as a product quality point.',
      text: 'Local-first should still feel magical. I want setup, capture, retrieval, and citations to feel fast enough that owning the memory layer does not feel like a tax.',
    },
    {
      label: 'Reply to MCP discussion',
      why: 'Connects MCP to durable context instead of only tool calls.',
      text: 'MCP gets much more interesting when the server is not just a tool wrapper, but a memory boundary. The agent can ask for cited context instead of making the user rebuild it in the prompt.',
    },
    {
      label: 'Reply to Codex or Claude Code workflow',
      why: 'Bridges coding-agent workflows to personal context.',
      text: 'The part I want for Codex/Claude Code is simple: when I ask for work, the agent should be able to pull context from things I already read, not only from files in the repo.',
    },
    {
      label: 'Reply to Kindle highlights',
      why: 'Turns reader workflows into a concrete wedge.',
      text: 'Kindle highlights are underrated agent memory. You already filtered the book once with your attention. The next step is making those highlights usable by the AI doing work with you.',
    },
    {
      label: 'Reply to Readwise or note-taking thread',
      why: 'Uses a familiar analogy while clarifying the agent-native angle.',
      text: 'Readwise made highlights easier to revisit. The agent-native version is different: can my AI retrieve the exact highlight, cite it, and use it while helping me think or build?',
    },
    {
      label: 'Reply to GBrain or OpenClaw discussion',
      why: 'Credits the underlying engine and places ClipBrain as capture/workflow layer.',
      text: 'GBrain is the important primitive here: local knowledge that agents can query. ClipBrain is me trying to make the capture side feel natural enough that the memory actually gets fed.',
    },
    {
      label: 'Reply with product link',
      why: 'Use sparingly when someone asks for a tool, demo, or implementation.',
      text: [
        'This is exactly the workflow I built ClipBrain for:',
        '',
        'clip once -> store locally -> let MCP agents pull cited context later.',
        '',
        STORE_URL,
      ].join('\n'),
    },
    {
      label: 'Reply to privacy concern',
      why: 'Answers trust objections without sounding defensive.',
      text: 'Totally. I do not want a hosted memory cloud either. My preferred shape is: browser extension captures, local server stores, MCP exposes context to the tools I already use.',
    },
    {
      label: 'Reply to generic AI memory take',
      why: 'Raises the bar from vague memory to source-grounded memory.',
      text: 'The word "memory" gets fuzzy fast. The bar I care about is: can the agent retrieve the source, quote the relevant part, cite it, and show what related reading I saved?',
    },
    {
      label: 'Reply to builder asking what to demo',
      why: 'Creates conversation without forcing a product pitch.',
      text: 'The most convincing demo is usually tiny: save one thing, ask one real question, show the source coming back. If that loop feels obvious, the product has a shot.',
    },
  ];
}

function formatSourceSignals(signals: RepoSignals): string[] {
  const sourceSignals = [`Value prop: ${signals.valueProp}`];
  const profileSummary = summarizeProfileContext(signals.profileContext);

  if (profileSummary) sourceSignals.push(`X profile: ${profileSummary}`);
  if (signals.voiceSamples) {
    sourceSignals.push(`Voice samples: ${formatVoiceSampleSignals(signals.voiceSamples)}`);
  }

  if (signals.topic) sourceSignals.push(`Topic: ${signals.topic}`);
  if (signals.replyTargets.length > 0) {
    sourceSignals.push(`Reply targets: ${signals.replyTargets.length} local target(s) from ${REPLY_TARGETS_PATH}`);
  }

  if (signals.latestChangelog) {
    const note = truncateForSignal(signals.latestChangelog.notes[0] || 'latest release notes available');
    sourceSignals.push(`Latest changelog ${signals.latestChangelog.version}: ${note}`);
  }

  for (const commit of signals.recentCommits.slice(0, 5)) {
    sourceSignals.push(`Commit ${commit.hash}: ${commit.message}`);
  }

  if (signals.recentCommits.length === 0) {
    sourceSignals.push('No recent commits available from git log.');
  }

  return sourceSignals;
}

function formatVoiceSampleSignals(samples: VoiceSampleSignals): string {
  const traitSummary = samples.traits.length > 0
    ? `; ${samples.traits.join('; ')}`
    : '';
  return `${samples.count} local sample(s), avg ${samples.averageChars} chars${traitSummary}`;
}

function summarizeVoiceTraits(samples: string[]): string[] {
  const has = (pattern: RegExp) => samples.filter(sample => pattern.test(sample)).length;
  const halfOrMore = (count: number) => count / samples.length >= 0.5;
  const some = (count: number) => count > 0;

  const firstPerson = has(/\b(i|i'm|i.?ve|my|me)\b/i);
  const memorySources = has(/\b(kindle|highlight|blog|tweet|saved|youtube|pdf|note|clip)\b/i);
  const proof = has(/\b(demo|video|screenshot|build|repo|commit|shipped|added|fixed)\b/i);
  const externalSpark = has(/@\w+|\bposted about\b|\bopen sourced\b/i);
  const warmReply = has(/\b(hey|very cool|appreciate|glad you liked|you.?ll probably like|haha)\b/i);
  const analogy = has(/\b(readwise|plumbing|paint|taste|brain for|favorite ai|superpowers)\b/i);
  const enthusiasm = has(/!{2,}|\.{3}|…/);
  const lowercaseStart = samples.filter(sample => /^[a-z]/.test(sample.trim())).length;
  const compact = samples.filter(sample => sample.length <= 280).length;

  return [
    halfOrMore(firstPerson) ? 'mostly first-person' : undefined,
    some(memorySources) ? 'anchored in concrete memory sources' : undefined,
    some(proof) ? 'pairs claims with build or demo proof' : undefined,
    some(externalSpark) ? 'uses external sparks/references' : undefined,
    some(warmReply) ? 'uses warm direct reply openers' : undefined,
    some(analogy) ? 'uses memorable product analogies' : undefined,
    some(enthusiasm) ? 'allows enthusiastic punctuation when earned' : undefined,
    halfOrMore(lowercaseStart) ? 'often starts lowercase' : undefined,
    halfOrMore(compact) ? 'mostly short-post length' : undefined,
  ].filter((trait): trait is string => !!trait);
}

function summarizeProfileContext(profileContext?: string): string | undefined {
  if (!profileContext?.trim()) return undefined;

  const handle = matchMarkdownListValue(profileContext, 'Handle');
  const bio = matchMarkdownListValue(profileContext, 'Bio');
  const performance = matchMarkdownListValue(profileContext, 'Public performance at capture');

  return [
    handle,
    bio ? `bio "${bio}"` : undefined,
    performance ? `pinned post: ${performance}` : undefined,
  ].filter(Boolean).join('; ');
}

function matchMarkdownListValue(markdown: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^- ${escaped}: (.+)$`, 'm'));
  return match?.[1]?.trim();
}

function primaryBuildSignal(signals: RepoSignals): string {
  if (signals.topic) return `${signals.topic} from clone to first useful agent answer`;
  const latestNote = signals.latestChangelog?.notes[0];
  if (/you also saved/i.test(latestNote || '')) {
    return 'You Also Saved pack-level connections from exact matches to related saved context';
  }
  if (latestNote) return truncateForSentence(latestNote);
  if (signals.recentCommits[0]?.message) return humanizeCommit(signals.recentCommits[0].message);
  return signals.valueProp;
}

function humanizeCommit(message: string): string {
  return message
    .replace(/^fix[:\s-]*/i, 'fixed ')
    .replace(/^add[:\s-]*/i, 'added ')
    .replace(/^prepare[:\s-]*/i, 'prepared ')
    .replace(/^bump[:\s-]*/i, 'bumped ')
    .trim();
}

function latestReleasePost(signals: RepoSignals): TweetDraft {
  const latestNote = signals.latestChangelog?.notes[0] || '';
  const hasYouAlsoSaved = /you also saved/i.test(latestNote);

  if (hasYouAlsoSaved) {
    return {
      label: 'Latest release',
      why: 'Turns the latest changelog into a concrete product story.',
      text: [
        'I added a small ClipBrain feature I care a lot about: "You Also Saved."',
        '',
        'When your agent asks about a topic, it should not only return literal matches.',
        '',
        'It should surface the connected reading you forgot you saved.',
        '',
        'That is the difference between search and memory.',
      ].join('\n'),
    };
  }

  const release = signals.latestChangelog
    ? `v${signals.latestChangelog.version}`
    : 'the latest build';
  const note = latestNote ? truncateForSentence(latestNote) : 'making saved context more useful for agents';

  return {
    label: 'Latest release',
    why: 'Turns the latest changelog into a concrete product story.',
    text: [
      `Latest ClipBrain release: ${release}.`,
      '',
      note,
      '',
      'The pattern I keep coming back to: less manual context assembly, more source-grounded agent memory.',
    ].join('\n'),
  };
}

function buildWarnings(shortPosts: TweetDraft[], thread: ThreadDraft, replies: TweetDraft[]): string[] {
  const allText = [
    ...shortPosts.map(post => post.text),
    ...thread.posts,
    ...replies.map(reply => reply.text),
  ];

  const warnings = [
    'Draft-only: this agent does not publish or schedule posts.',
    'Review for private captures, emails, exact corpus counts, customer names, or API/provider details before posting.',
    'Prefer adding a screenshot or short demo before posting any claim about magic.',
  ];

  const longDrafts = allText.filter(text => text.length > 280).length;
  if (longDrafts > 0) {
    warnings.push(`${longDrafts} drafts are longer than 280 characters; use them as long posts or trim before posting.`);
  }

  if (allText.some(text => /gmail|email/i.test(text))) {
    warnings.push('Gmail/email mentions can imply private data. Keep demos synthetic or explicitly sanitized.');
  }

  return warnings;
}

function formatReplyTargets(targets: ReplyTarget[]): string[] {
  if (targets.length === 0) {
    return [
      `No saved reply targets found. Add public tweet URLs or notes to ${REPLY_TARGETS_PATH}.`,
      '',
      'Example:',
      '- https://x.com/someone/status/123456789 | Bridge MCP tools to memory with source-grounded context.',
    ];
  }

  return targets.map((target, index) => {
    const parts = [
      `${index + 1}. ${target.context}`,
      target.url ? `URL: ${target.url}` : undefined,
      target.angle ? `Angle: ${target.angle}` : undefined,
    ].filter(Boolean);
    return parts.join('\n   ');
  });
}

function formatDraftTitle(index: number, draft: TweetDraft): string {
  return `### ${index}. ${draft.label} (${characterCount(draft.text)} chars)`;
}

export function characterCount(text: string): number {
  return text.length;
}

function truncateForSignal(text: string): string {
  return truncateAtWord(text, 220);
}

function truncateForSentence(text: string): string {
  return truncateAtWord(text, 120).replace(/[.!?]*$/, '');
}

function truncateAtWord(text: string, maxLength: number): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxLength) return cleaned;
  const clipped = cleaned.slice(0, maxLength - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  const safe = lastSpace > 80 ? clipped.slice(0, lastSpace) : clipped;
  return `${safe}...`;
}

function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readRepoFile(cwd: string, relativePath: string): Promise<string> {
  try {
    return await Bun.file(join(cwd, relativePath)).text();
  } catch {
    return '';
  }
}

async function runCommand(args: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function todayLocalIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function usage(): string {
  return [
    'Usage: bun run twitter-agent.ts [options]',
    '',
    'Options:',
    '  --dry-run                 Print the draft pack instead of writing it',
    '  --date YYYY-MM-DD          Use a specific draft date',
    '  --topic "first-run magic"  Focus the founder-loop post and thread',
    '  --commit-limit N           Number of recent commits to inspect',
    '  --out-dir PATH             Output directory for draft markdown',
  ].join('\n');
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
      process.exit(0);
    }

    const result = await runTwitterAgent(opts);
    if (opts.dryRun) {
      console.log(result.markdown);
    } else {
      console.log(`Twitter draft pack written: ${result.path}`);
    }
  } catch (err: any) {
    console.error(`[twitter-agent] ${err?.message || String(err)}`);
    console.error('');
    console.error(usage());
    process.exit(1);
  }
}
