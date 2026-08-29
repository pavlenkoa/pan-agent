import { describe, expect, it } from 'vitest';

import { parseEsputnikAccount, parseSetVarArgs } from './person-commands.js';

describe('parseSetVarArgs', () => {
  it('parses a bare KEY=VALUE with no description', () => {
    expect(parseSetVarArgs(['ESPUTNIK_TOKEN=abc123'])).toEqual({
      key: 'ESPUTNIK_TOKEN',
      value: 'abc123',
      description: '',
    });
  });

  it('joins everything after the first token as the description', () => {
    expect(parseSetVarArgs(['ESPUTNIK_TOKEN=abc123', 'for', 'sending', 'SMS'])).toEqual({
      key: 'ESPUTNIK_TOKEN',
      value: 'abc123',
      description: 'for sending SMS',
    });
  });

  it('allows = inside the value', () => {
    expect(parseSetVarArgs(['TOKEN=a=b=c'])).toEqual({ key: 'TOKEN', value: 'a=b=c', description: '' });
  });

  it('rejects missing args', () => {
    expect(parseSetVarArgs([])).toEqual({ error: expect.stringContaining('Usage') });
  });

  it('rejects a token with no =', () => {
    expect(parseSetVarArgs(['NOEQUALS'])).toEqual({ error: expect.stringContaining('Usage') });
  });

  it('rejects an invalid key (starts with a digit)', () => {
    expect(parseSetVarArgs(['1FOO=bar'])).toEqual({ error: expect.stringContaining('Invalid variable name') });
  });

  it('rejects an invalid key (contains a dash)', () => {
    expect(parseSetVarArgs(['MY-VAR=bar'])).toEqual({ error: expect.stringContaining('Invalid variable name') });
  });

  it('rejects a reserved system name', () => {
    expect(parseSetVarArgs(['GH_TOKEN=evil'])).toEqual({ error: expect.stringContaining('reserved') });
  });

  it('rejects an empty value', () => {
    expect(parseSetVarArgs(['FOO='])).toEqual({ error: expect.stringContaining('empty') });
  });
});

describe('parseEsputnikAccount', () => {
  it('accepts a lowercase account label', () => {
    expect(parseEsputnikAccount(['work'])).toEqual({ account: 'work' });
  });

  it('accepts digits and underscores after the first letter', () => {
    expect(parseEsputnikAccount(['work_2'])).toEqual({ account: 'work_2' });
  });

  it('rejects missing args', () => {
    expect(parseEsputnikAccount([])).toEqual({ error: expect.stringContaining('Usage') });
  });

  it('rejects an uppercase label', () => {
    expect(parseEsputnikAccount(['Work'])).toEqual({ error: expect.stringContaining('Invalid account label') });
  });

  it('rejects a label starting with a digit', () => {
    expect(parseEsputnikAccount(['1work'])).toEqual({ error: expect.stringContaining('Invalid account label') });
  });

  it('rejects a label with a dash', () => {
    expect(parseEsputnikAccount(['my-work'])).toEqual({ error: expect.stringContaining('Invalid account label') });
  });
});
