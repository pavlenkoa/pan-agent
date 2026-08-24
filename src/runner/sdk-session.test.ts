import { describe, expect, it } from 'vitest';

import { turnKey } from '../shared/types.js';
import { buildPrompt, resolveReplyText, TASK_NO_UPDATE_MARKER } from './sdk-session.js';

describe('buildPrompt — ControlTurn', () => {
  it('returns the bare command with no prefix, regardless of chatId', () => {
    // Confirmed live 2026-08-23: the SDK only recognizes /compact and /clear
    // as bare text — a ChatTurn's `${fromHandle}: ${text}` prefix silently
    // breaks recognition and the model just answers the text as a normal
    // question instead. This guards against that regression.
    expect(buildPrompt({ kind: 'control', updateId: 1, chatId: 42, command: '/compact' })).toBe('/compact');
    expect(buildPrompt({ kind: 'control', updateId: 1, chatId: 42, command: '/clear' })).toBe('/clear');
  });
});

describe('buildPrompt — ChatTurn (regression guard)', () => {
  it('still prefixes chat messages with fromHandle when present', () => {
    const prompt = buildPrompt({
      kind: 'chat',
      updateId: 1,
      chatId: 42,
      messages: [{ messageId: 1, text: '/compact', fromHandle: '@andrii', date: '2026-08-23T00:00:00Z' }],
    });
    expect(prompt).toBe('@andrii: /compact');
  });

  it('omits the prefix when fromHandle is null', () => {
    const prompt = buildPrompt({
      kind: 'chat',
      updateId: 1,
      chatId: 42,
      messages: [{ messageId: 1, text: 'hello', fromHandle: null, date: '2026-08-23T00:00:00Z' }],
    });
    expect(prompt).toBe('hello');
  });
});

describe('buildPrompt — TaskTurn', () => {
  it('includes the task prompt and instructs the no-update marker', () => {
    const prompt = buildPrompt({
      kind: 'task',
      taskId: 'task-1',
      scheduledFor: '2026-08-24T09:00:00Z',
      chatId: 42,
      prompt: 'Check if Silo has new episodes.',
    });
    expect(prompt).toContain('[Scheduled task task-1, due 2026-08-24T09:00:00Z]');
    expect(prompt).toContain('Check if Silo has new episodes.');
    expect(prompt).toContain(TASK_NO_UPDATE_MARKER);
  });
});

describe('resolveReplyText — TaskTurn no-update suppression', () => {
  const task = { kind: 'task' as const, taskId: 'task-1', scheduledFor: '2026-08-24T09:00:00Z', chatId: 42, prompt: 'check' };

  it('suppresses delivery on a bare TASK_NO_UPDATE_MARKER reply', () => {
    expect(resolveReplyText(task, { replyText: TASK_NO_UPDATE_MARKER, ok: true })).toEqual({
      replyText: '',
      isTaskNoUpdate: true,
      suppressedReasoning: '',
    });
  });

  it('still suppresses when the marker has surrounding whitespace', () => {
    expect(resolveReplyText(task, { replyText: `  ${TASK_NO_UPDATE_MARKER}  `, ok: true })).toEqual({
      replyText: '',
      isTaskNoUpdate: true,
      suppressedReasoning: '',
    });
  });

  it('suppresses when the marker sits on its own trailing line after reasoning, preserving the reasoning', () => {
    // Confirmed live: the model sometimes prepends reasoning before the bare
    // marker line — an exact `trim() === MARKER` match misses this entirely
    // and delivers the literal marker text to Telegram.
    const reasoning = 'Still only TELESYNC/HDTS cam-rips, no real upgrade.';
    expect(resolveReplyText(task, { replyText: `${reasoning}\n\n${TASK_NO_UPDATE_MARKER}`, ok: true })).toEqual({
      replyText: '',
      isTaskNoUpdate: true,
      suppressedReasoning: reasoning,
    });
  });

  it('suppresses when the marker line has trailing spaces and a trailing newline', () => {
    const reasoning = 'checking tomorrow instead';
    expect(resolveReplyText(task, { replyText: `${reasoning}\n${TASK_NO_UPDATE_MARKER} \n`, ok: true })).toEqual({
      replyText: '',
      isTaskNoUpdate: true,
      suppressedReasoning: reasoning,
    });
  });

  it('does NOT suppress when the marker is not on its own trailing line', () => {
    const replyText = `${TASK_NO_UPDATE_MARKER} available yet, still checking tomorrow`;
    expect(resolveReplyText(task, { replyText, ok: true })).toEqual({
      replyText,
      isTaskNoUpdate: false,
      suppressedReasoning: '',
    });
  });

  it('passes through a real task reply untouched', () => {
    expect(resolveReplyText(task, { replyText: 'нова серія вийшла!', ok: true })).toEqual({
      replyText: 'нова серія вийшла!',
      isTaskNoUpdate: false,
      suppressedReasoning: '',
    });
  });

  it('does not suppress a ChatTurn even if its reply happens to equal the marker text', () => {
    const chat = { kind: 'chat' as const, updateId: 1, chatId: 42, messages: [] };
    expect(resolveReplyText(chat, { replyText: TASK_NO_UPDATE_MARKER, ok: true })).toEqual({
      replyText: TASK_NO_UPDATE_MARKER,
      isTaskNoUpdate: false,
      suppressedReasoning: '',
    });
  });
});

describe('resolveReplyText — ControlTurn synthesized replies', () => {
  it('synthesizes a success message for /compact with an empty SDK result', () => {
    const turn = { kind: 'control' as const, updateId: 1, chatId: 42, command: '/compact' as const };
    expect(resolveReplyText(turn, { replyText: '', ok: true }).replyText).toBe('✅ Compacted your conversation history.');
  });

  it('synthesizes a success message for /clear with an empty SDK result', () => {
    const turn = { kind: 'control' as const, updateId: 1, chatId: 42, command: '/clear' as const };
    expect(resolveReplyText(turn, { replyText: '', ok: true }).replyText).toBe(
      '✅ Cleared — starting fresh from here. Memory notes and scheduled tasks are unaffected.',
    );
  });

  it('synthesizes a timeout warning when the control turn failed with no reply', () => {
    const turn = { kind: 'control' as const, updateId: 1, chatId: 42, command: '/compact' as const };
    expect(resolveReplyText(turn, { replyText: '', ok: false }).replyText).toBe('⚠️ /compact timed out — try again in a moment.');
  });

  it('prefers an actual SDK reply over synthesizing one', () => {
    const turn = { kind: 'control' as const, updateId: 1, chatId: 42, command: '/compact' as const };
    expect(resolveReplyText(turn, { replyText: 'real reply', ok: true }).replyText).toBe('real reply');
  });
});

describe('resolveReplyText — ChatTurn', () => {
  it('passes an empty reply straight through as empty (no synthesis for chat)', () => {
    const turn = { kind: 'chat' as const, updateId: 1, chatId: 42, messages: [] };
    expect(resolveReplyText(turn, { replyText: '', ok: true }).replyText).toBe('');
  });
});

describe('turnKey', () => {
  it('gives control turns their own dedup namespace, keyed by updateId', () => {
    expect(turnKey({ kind: 'control', updateId: 7, chatId: 42, command: '/compact' })).toBe('ctl:7');
  });
});
