#!/usr/bin/env bun

type CheckStatus = 'ok' | 'warn' | 'fail';

export type DoctorCheck = {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
};

export type DoctorReport = {
  status: CheckStatus;
  checks: DoctorCheck[];
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type DoctorOptions = {
  cwd?: string;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
  commandRunner?: (args: string[]) => Promise<CommandResult>;
  homeDir?: string;
};

const DEFAULT_SERVER_URL = 'http://127.0.0.1:19285';

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = opts.cwd || import.meta.dir;
  const homeDir = opts.homeDir || process.env.HOME || '';
  const serverUrl = opts.serverUrl || process.env.CLIPBRAIN_SERVER_URL || DEFAULT_SERVER_URL;
  const fetchImpl = opts.fetchImpl || fetch;
  const commandRunner = opts.commandRunner || runCommand;

  const checks: DoctorCheck[] = [];

  checks.push(await checkCommand('Bun', ['bun', '--version'], commandRunner));
  checks.push(await checkCommand('gbrain CLI', ['gbrain', '--version'], commandRunner));
  checks.push(await checkRequiredFile('Chrome extension manifest', `${cwd}/manifest.json`));
  checks.push(await checkRequiredFile('Vendored Readability', `${cwd}/lib/readability.js`));
  checks.push(await checkRequiredFile('ClipBrain MCP bridge', `${cwd}/clipbrain-mcp.ts`));
  checks.push(await checkServerHealth(serverUrl, fetchImpl));
  checks.push(await checkServerDiagnostics(serverUrl, fetchImpl));
  checks.push(await checkClaudeMcpConfig(homeDir));

  return {
    status: summarizeStatus(checks),
    checks,
  };
}

export function summarizeStatus(checks: DoctorCheck[]): CheckStatus {
  if (checks.some(check => check.status === 'fail')) return 'fail';
  if (checks.some(check => check.status === 'warn')) return 'warn';
  return 'ok';
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    'ClipBrain doctor',
    `Status: ${report.status.toUpperCase()}`,
    '',
  ];

  for (const check of report.checks) {
    lines.push(`${statusIcon(check.status)} ${check.name}: ${check.message}`);
    if (check.detail) lines.push(`   ${check.detail}`);
  }

  if (report.status === 'ok') {
    lines.push('', 'Ready: capture a page, then ask your AI with ClipBrain context.');
  } else {
    lines.push('', 'Fix the FAIL items first. WARN items reduce polish but do not block basic capture.');
  }

  return lines.join('\n');
}

export function hasMcpServers(settings: unknown): { gbrain: boolean; clipbrain: boolean } {
  const root = settings && typeof settings === 'object' ? settings as Record<string, any> : {};
  const servers = root.mcpServers && typeof root.mcpServers === 'object'
    ? root.mcpServers as Record<string, unknown>
    : {};
  return {
    gbrain: !!servers.gbrain,
    clipbrain: !!servers.clipbrain,
  };
}

async function checkCommand(
  name: string,
  args: string[],
  commandRunner: (args: string[]) => Promise<CommandResult>,
): Promise<DoctorCheck> {
  try {
    const result = await commandRunner(args);
    if (result.exitCode !== 0) {
      return {
        name,
        status: 'fail',
        message: 'not available',
        detail: result.stderr.trim() || `${args.join(' ')} exited ${result.exitCode}`,
      };
    }
    return {
      name,
      status: 'ok',
      message: result.stdout.trim().split('\n')[0] || 'available',
    };
  } catch (err: any) {
    return { name, status: 'fail', message: 'not available', detail: err?.message || String(err) };
  }
}

async function checkRequiredFile(name: string, path: string): Promise<DoctorCheck> {
  try {
    const file = Bun.file(path);
    if (await file.exists()) return { name, status: 'ok', message: 'found' };
    return { name, status: 'fail', message: 'missing', detail: path };
  } catch (err: any) {
    return { name, status: 'fail', message: 'could not inspect file', detail: err?.message || String(err) };
  }
}

async function checkServerHealth(serverUrl: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(new URL('/health', normalizeBaseUrl(serverUrl)));
    if (!response.ok) return { name: 'Local server', status: 'fail', message: `HTTP ${response.status}` };
    const body = await response.json().catch(() => ({}));
    if (body?.status === 'ok') return { name: 'Local server', status: 'ok', message: serverUrl };
    return { name: 'Local server', status: 'warn', message: 'responded without expected health payload' };
  } catch (err: any) {
    return {
      name: 'Local server',
      status: 'fail',
      message: 'offline',
      detail: `Start it with: bun run serve (${err?.message || String(err)})`,
    };
  }
}

async function checkServerDiagnostics(serverUrl: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(new URL('/api/diagnostics', normalizeBaseUrl(serverUrl)));
    if (!response.ok) return { name: 'Runtime diagnostics', status: 'warn', message: `HTTP ${response.status}` };
    const diag = await response.json();
    const missing: string[] = [];

    if (!diag.gbrain) missing.push('gbrain');
    if (!diag.openaiKey) missing.push('OPENAI_API_KEY');
    if (!diag.ytDlp) missing.push('yt-dlp');
    if (!diag.mcpConfigured) missing.push('MCP config');

    if (missing.length === 0) {
      return { name: 'Runtime diagnostics', status: 'ok', message: `${diag.captures || 0} captures visible` };
    }

    const hardMissing = missing.includes('gbrain');
    return {
      name: 'Runtime diagnostics',
      status: hardMissing ? 'fail' : 'warn',
      message: `missing: ${missing.join(', ')}`,
      detail: 'Capture works without optional AI/YouTube pieces, but launch polish is better when they are configured.',
    };
  } catch (err: any) {
    return { name: 'Runtime diagnostics', status: 'warn', message: 'unavailable', detail: err?.message || String(err) };
  }
}

async function checkClaudeMcpConfig(homeDir: string): Promise<DoctorCheck> {
  if (!homeDir) return { name: 'Claude MCP config', status: 'warn', message: 'HOME not set' };

  const path = `${homeDir}/.claude/settings.json`;
  try {
    const text = await Bun.file(path).text();
    const servers = hasMcpServers(JSON.parse(text));
    if (servers.gbrain && servers.clipbrain) {
      return { name: 'Claude MCP config', status: 'ok', message: 'gbrain + clipbrain configured' };
    }
    const missing = [
      servers.gbrain ? '' : 'gbrain',
      servers.clipbrain ? '' : 'clipbrain',
    ].filter(Boolean);
    return {
      name: 'Claude MCP config',
      status: 'warn',
      message: `missing: ${missing.join(', ')}`,
      detail: 'Run ./setup-mcp.sh or ./setup.sh after installing Claude Code.',
    };
  } catch {
    return {
      name: 'Claude MCP config',
      status: 'warn',
      message: 'not found',
      detail: 'Run ./setup-mcp.sh after installing Claude Code, Claude Desktop, Cursor, or another MCP client.',
    };
  }
}

async function runCommand(args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim() || DEFAULT_SERVER_URL;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function statusIcon(status: CheckStatus): string {
  if (status === 'ok') return 'OK  ';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}

if (import.meta.main) {
  const report = await runDoctor();
  console.log(formatDoctorReport(report));
  process.exit(report.status === 'fail' ? 1 : 0);
}
