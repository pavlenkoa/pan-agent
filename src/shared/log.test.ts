import { afterEach, describe, expect, it, vi } from 'vitest';
import { levelFor, log, logLine } from './log.js';

describe('levelFor', () => {
  it('treats failure-shaped events as errors', () => {
    expect(levelFor('turn_delivery_failed', {})).toBe('error');
    expect(levelFor('runner_fatal', {})).toBe('error');
    expect(levelFor('session_restart_exhausted', {})).toBe('error');
    expect(levelFor('tasks_api_unauthorized', {})).toBe('error');
  });

  it('treats a failed turn as an error but a failed tool call as a warning', () => {
    expect(levelFor('turn_end', { ok: false })).toBe('error');
    expect(levelFor('tool_result', { ok: false })).toBe('warn');
  });

  it('defaults to info and marks thinking as debug', () => {
    expect(levelFor('turn_end', { ok: true })).toBe('info');
    expect(levelFor('reply_sent', {})).toBe('info');
    expect(levelFor('thinking', {})).toBe('debug');
  });
});

describe('logLine output', () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(fn: () => void): Record<string, unknown> {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      fn();
      return JSON.parse(String(write.mock.calls[0]?.[0]));
    } finally {
      write.mockRestore();
    }
  }

  it('adds a level field and lets call sites override it', () => {
    expect(capture(() => logLine('turn_start', { person: 'a' }))['level']).toBe('info');
    expect(capture(() => logLine('turn_start', { level: 'warn' }))['level']).toBe('warn');
  });

  it('log.error is an error and keeps ok:false', () => {
    const line = capture(() => log.error('reconcile_oops', new Error('boom')));
    expect(line['level']).toBe('error');
    expect(line['ok']).toBe(false);
  });
});
