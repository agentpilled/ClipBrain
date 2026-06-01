import { describe, expect, test } from 'bun:test';
import {
  formatDoctorReport,
  hasMcpServers,
  summarizeStatus,
} from '../doctor.ts';
import type { DoctorCheck } from '../doctor.ts';

describe('doctor helpers', () => {
  test('summarizes worst check status', () => {
    expect(summarizeStatus([
      check('Bun', 'ok'),
      check('OpenAI', 'warn'),
    ])).toBe('warn');

    expect(summarizeStatus([
      check('Bun', 'ok'),
      check('Server', 'fail'),
      check('OpenAI', 'warn'),
    ])).toBe('fail');
  });

  test('detects required MCP servers in settings JSON', () => {
    expect(hasMcpServers({
      mcpServers: {
        gbrain: { command: 'gbrain', args: ['serve'] },
        clipbrain: { command: 'bun', args: ['clipbrain-mcp.ts'] },
      },
    })).toEqual({ gbrain: true, clipbrain: true });

    expect(hasMcpServers({ mcpServers: { gbrain: {} } }))
      .toEqual({ gbrain: true, clipbrain: false });
  });

  test('formats a launch-friendly report', () => {
    const report = {
      status: 'warn' as const,
      checks: [
        check('Local server', 'ok', 'http://127.0.0.1:19285'),
        check('Runtime diagnostics', 'warn', 'missing: OPENAI_API_KEY'),
      ],
    };

    const text = formatDoctorReport(report);

    expect(text).toContain('ClipBrain doctor');
    expect(text).toContain('Status: WARN');
    expect(text).toContain('Local server: http://127.0.0.1:19285');
    expect(text).toContain('WARN Runtime diagnostics: missing: OPENAI_API_KEY');
  });
});

function check(name: string, status: DoctorCheck['status'], message = 'message'): DoctorCheck {
  return { name, status, message };
}
