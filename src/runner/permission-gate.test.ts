import { describe, expect, it, vi } from 'vitest';

import type { RunnerConfig } from './config.js';
import { createPermissionGate } from './permission-gate.js';

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
