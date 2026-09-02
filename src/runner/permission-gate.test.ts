import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunnerConfig } from './config.js';
import { createPermissionGate, formatInputPreview, PERMISSION_TIMEOUT_MS } from './permission-gate.js';

vi.mock('./telegram-send.js', () => ({
  sendPermissionRequest: vi.fn().mockResolvedValue(undefined),
  sendTelegramReply: vi.fn().mockResolvedValue(undefined),
}));

function fakeConfig(toolPermissions: string[] = []): RunnerConfig {
  return {
    slug: 'andrii',
    chatId: 111,
    tz: 'UTC',
    port: 8080,
    operatorTasksUrl: 'http://operator.invalid',
    tasksToken: 'test-token',
    telegramBotToken: 'bot-token',
    journalDir: '/tmp/journal',
    workspaceCwd: '/tmp/workspace',
    claudeHome: '/tmp/claude',
    sessionIdFile: '/tmp/session-id',
    customVarsDoc: [],
    toolPermissions,
  };
}

describe('createPermissionGate', () => {
  it('resolves "once" without persisting — a second request for the same tool asks again', async () => {
    const gate = createPermissionGate(fakeConfig());
    const first = gate.request('mcp__esputnik-work__create_email_message', { message_id: 1 });
    // Wait a tick for sendPermissionRequest's fire-and-forget call to register the pending entry.
    await new Promise((r) => setTimeout(r, 10));
    const { sendPermissionRequest } = await import('./telegram-send.js');
    const requestId = vi.mocked(sendPermissionRequest).mock.calls[0]?.[2];
    expect(requestId).toBeTruthy();
    expect(gate.resolve(requestId!, 'once')).toEqual({ applied: true, toolName: 'mcp__esputnik-work__create_email_message' });
    expect(await first).toBe('once');

    vi.mocked(sendPermissionRequest).mockClear();
    const second = gate.request('mcp__esputnik-work__create_email_message', { message_id: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(sendPermissionRequest).toHaveBeenCalledTimes(1); // asked again — 'once' isn't remembered
    const requestId2 = vi.mocked(sendPermissionRequest).mock.calls[0]?.[2];
    gate.resolve(requestId2!, 'deny');
    expect(await second).toBe('deny');
  });

  it('resolves "always" and remembers it in-memory — a later request for the same tool never asks again', async () => {
    const gate = createPermissionGate(fakeConfig());
    const { sendPermissionRequest } = await import('./telegram-send.js');
    vi.mocked(sendPermissionRequest).mockClear();

    const first = gate.request('mcp__esputnik-work__delete_contact', {});
    await new Promise((r) => setTimeout(r, 10));
    const requestId = vi.mocked(sendPermissionRequest).mock.calls[0]?.[2];
    gate.resolve(requestId!, 'always');
    expect(await first).toBe('always');

    vi.mocked(sendPermissionRequest).mockClear();
    expect(await gate.request('mcp__esputnik-work__delete_contact', {})).toBe('always');
    expect(sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('seeds already-granted tools from cfg.toolPermissions — never asks for those at all', async () => {
    const gate = createPermissionGate(fakeConfig(['mcp__esputnik-work__create_email_message']));
    const { sendPermissionRequest } = await import('./telegram-send.js');
    vi.mocked(sendPermissionRequest).mockClear();

    expect(await gate.request('mcp__esputnik-work__create_email_message', {})).toBe('always');
    expect(sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('resolve() on an unknown requestId reports not applied, without throwing', () => {
    const gate = createPermissionGate(fakeConfig());
    expect(gate.resolve('nonexistent', 'once')).toEqual({ applied: false });
  });

  it('auto-denies and notifies the person after the timeout elapses', async () => {
    const gate = createPermissionGate(fakeConfig(), 30);
    const { sendTelegramReply } = await import('./telegram-send.js');
    vi.mocked(sendTelegramReply).mockClear();

    const decision = await gate.request('mcp__esputnik-work__create_email_message', {});
    expect(decision).toBe('deny');
    expect(sendTelegramReply).toHaveBeenCalledWith(
      'bot-token',
      111,
      expect.stringContaining('mcp__esputnik-work__create_email_message'),
    );
  });

  it('a decision that arrives after the timeout already fired is a no-op (already removed from pending)', async () => {
    const gate = createPermissionGate(fakeConfig(), 20);
    const { sendPermissionRequest } = await import('./telegram-send.js');
    vi.mocked(sendPermissionRequest).mockClear();

    const pending = gate.request('mcp__esputnik-work__create_email_message', {});
    await new Promise((r) => setTimeout(r, 10));
    const requestId = vi.mocked(sendPermissionRequest).mock.calls[0]?.[2];
    expect(await pending).toBe('deny'); // timed out first

    expect(gate.resolve(requestId!, 'always')).toEqual({ applied: false });
  });
});

describe('formatInputPreview', () => {
  it('flattens a nested payload wrapper into plain key: value lines, no braces or quotes', () => {
    const preview = formatInputPreview({
      payload: { name: 'Test SMS', from: 'marketing', text: 'Third test message' },
    });
    expect(preview).toBe('name: Test SMS\nfrom: marketing\ntext: Third test message');
  });

  it('flattens a flat (non-wrapped) input the same way', () => {
    expect(formatInputPreview({ message_id: '4667476' })).toBe('message_id: 4667476');
  });

  it('replaces uploadSessionId with an explanatory note instead of the raw opaque token', () => {
    const preview = formatInputPreview({
      payload: { uploadSessionId: 'upl_pZMDYM1uUKvVBMPYFFom-ZiU', name: 'yaaaay!' },
    });
    expect(preview).toContain('content: already uploaded (upl_pZMDYM1uUKvV…), not shown here');
    expect(preview).not.toContain('upl_pZMDYM1uUKvVBMPYFFom-ZiU'); // full token never shown
    expect(preview).toContain('name: yaaaay!');
  });

  it('renders null/undefined/empty-array values explicitly rather than dropping them silently', () => {
    const preview = formatInputPreview({ a: null, b: undefined, c: [] });
    expect(preview).toBe('a: null\nb: (unset)\nc: (empty)');
  });

  it('joins a primitive array inline rather than flattening it into separate lines', () => {
    expect(formatInputPreview({ tags: ['a', 'b', 'c'] })).toBe('tags: a, b, c');
  });

  it('truncates a very long string value rather than dumping the whole thing', () => {
    const preview = formatInputPreview({ body: 'x'.repeat(1000) });
    expect(preview.length).toBeLessThan(1000);
    expect(preview).toContain('…');
  });

  it('falls back to "(no arguments)" for an empty input object', () => {
    expect(formatInputPreview({})).toBe('(no arguments)');
  });
});

describe('createPermissionGate — send retries (2026-09-02 incident: a single failed fetch left a request silently pending)', () => {
  // Real timers, not fake ones — same reasoning as session-controller.test.ts:
  // advanceTimersByTimeAsync's interaction with promise-chain-heavy code here
  // is finicky, so tests shrink the actual delays instead of faking wall-clock
  // time. `retryDelaysMs` is a constructor parameter for exactly this reason.
  const shortRetryDelays = [5, 5];

  // A previous test earlier in this file may leave stray calls in these
  // mocks' history (they're only ever cleared at the *start* of each of
  // this file's other tests, not the end) — reset before, not just after.
  beforeEach(async () => {
    const { sendPermissionRequest, sendTelegramReply } = await import('./telegram-send.js');
    vi.mocked(sendPermissionRequest).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendTelegramReply).mockReset().mockResolvedValue(undefined);
  });

  it('retries a failed send and succeeds on the second attempt', async () => {
    const gate = createPermissionGate(fakeConfig(), PERMISSION_TIMEOUT_MS, shortRetryDelays);
    const { sendPermissionRequest } = await import('./telegram-send.js');
    vi.mocked(sendPermissionRequest).mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValueOnce(undefined);

    const pending = gate.request('mcp__esputnik-work__create_email_message', {});
    await new Promise((r) => setTimeout(r, 30)); // both attempts have had time to run

    expect(sendPermissionRequest).toHaveBeenCalledTimes(2);
    const requestId = vi.mocked(sendPermissionRequest).mock.calls[1]?.[2];
    expect(gate.resolve(requestId!, 'once')).toEqual({ applied: true, toolName: 'mcp__esputnik-work__create_email_message' });
    expect(await pending).toBe('once');
  });

  it('gives up after exhausting retries but the request stays pending — the overall timeout still fails it closed', async () => {
    const gate = createPermissionGate(fakeConfig(), 40, shortRetryDelays);
    const { sendPermissionRequest } = await import('./telegram-send.js');
    vi.mocked(sendPermissionRequest).mockRejectedValue(new Error('fetch failed'));

    const pending = gate.request('mcp__esputnik-work__create_email_message', {});
    expect(await pending).toBe('deny'); // overall timeout fires after both retries are exhausted
    expect(sendPermissionRequest).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, all failed
  });
});
