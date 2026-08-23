import { describe, expect, it } from 'vitest';

import { turnKey } from '../shared/types.js';
import { buildPrompt } from './sdk-session.js';

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

describe('turnKey', () => {
  it('gives control turns their own dedup namespace, keyed by updateId', () => {
    expect(turnKey({ kind: 'control', updateId: 7, chatId: 42, command: '/compact' })).toBe('ctl:7');
  });
});
