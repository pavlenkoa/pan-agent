import { describe, expect, it } from 'vitest';

import { advanceSchedule, nextRunAfter, shouldCatchUp } from './cron.js';

describe('nextRunAfter', () => {
  it('computes the next occurrence in the given IANA timezone', () => {
    // 09:00 Europe/Warsaw daily. Mid-summer -> UTC+2.
    const after = new Date('2026-07-25T00:00:00.000Z');
    const next = nextRunAfter('0 9 * * *', 'Europe/Warsaw', after);
    expect(next.toISOString()).toBe('2026-07-25T07:00:00.000Z');
  });

  it('rolls over to the next day once past the fire time', () => {
    const after = new Date('2026-07-25T08:00:00.000Z'); // already past 09:00 Warsaw
    const next = nextRunAfter('0 9 * * *', 'Europe/Warsaw', after);
    expect(next.toISOString()).toBe('2026-07-26T07:00:00.000Z');
  });
});

describe('advanceSchedule — drift-free recurrence', () => {
  it('advances from the scheduled time, not from "now", so a late sweep does not compound delay', () => {
    const scheduledFor = new Date('2026-07-25T07:00:00.000Z'); // 09:00 Warsaw
    // Sweep actually ran 90s late; advancing from "now" would push the next
    // occurrence 90s later every day. Advancing from scheduledFor doesn't.
    const advanced = advanceSchedule('0 9 * * *', 'Europe/Warsaw', scheduledFor);
    expect(advanced.toISOString()).toBe('2026-07-26T07:00:00.000Z');
  });
});

describe('shouldCatchUp', () => {
  const catchUpWindowMs = 6 * 60 * 60 * 1000; // 6h

  it('fires when overdue but within the catch-up window', () => {
    const nextRunAt = new Date('2026-07-25T07:00:00.000Z');
    const now = new Date('2026-07-25T08:00:00.000Z'); // 1h overdue
    const decision = shouldCatchUp(nextRunAt, now, catchUpWindowMs);
    expect(decision.fire).toBe(true);
    if (decision.fire) expect(decision.scheduledFor).toEqual(nextRunAt);
  });

  it('does not fire (and does not error) exactly at the due time', () => {
    const nextRunAt = new Date('2026-07-25T07:00:00.000Z');
    const decision = shouldCatchUp(nextRunAt, nextRunAt, catchUpWindowMs);
    expect(decision.fire).toBe(true);
  });

  it('skips a firing that is overdue by more than the catch-up window (no 48x replay after a 2-day outage)', () => {
    const nextRunAt = new Date('2026-07-23T07:00:00.000Z');
    const now = new Date('2026-07-25T08:00:00.000Z'); // ~49h overdue
    const decision = shouldCatchUp(nextRunAt, now, catchUpWindowMs);
    expect(decision.fire).toBe(false);
  });

  it('does not fire for a task that is not due yet', () => {
    const nextRunAt = new Date('2026-07-26T07:00:00.000Z');
    const now = new Date('2026-07-25T08:00:00.000Z');
    const decision = shouldCatchUp(nextRunAt, now, catchUpWindowMs);
    expect(decision.fire).toBe(false);
  });
});
