/**
 * Cron expression -> next fire time, IANA-tz aware (delegated to cron-parser
 * so DST edge cases aren't hand-rolled).
 */
import { CronExpressionParser } from 'cron-parser';

export function nextRunAfter(cronExpr: string, tz: string, after: Date): Date {
  const interval = CronExpressionParser.parse(cronExpr, { currentDate: after, tz });
  return interval.next().toDate();
}

/**
 * Drift-free recurrence (architecture doc section 2, step 4): the next
 * occurrence is always computed from the *scheduled* time, not from "now" —
 * so a sweep that runs a few seconds late doesn't compound delay across
 * firings.
 */
export function advanceSchedule(cronExpr: string, tz: string, scheduledFor: Date): Date {
  return nextRunAfter(cronExpr, tz, scheduledFor);
}

export type CatchUpDecision = { fire: true; scheduledFor: Date } | { fire: false };

/**
 * Decide whether a task whose nextRunAt is in the past should fire now.
 * Overdue by more than `catchUpWindowMs` -> skip this occurrence entirely
 * (a subscription check that missed two days shouldn't fire 48 times) and
 * the caller advances nextRunAt from the originally scheduled time.
 */
export function shouldCatchUp(nextRunAt: Date, now: Date, catchUpWindowMs: number): CatchUpDecision {
  const overdueMs = now.getTime() - nextRunAt.getTime();
  if (overdueMs < 0) return { fire: false };
  if (overdueMs > catchUpWindowMs) return { fire: false };
  return { fire: true, scheduledFor: nextRunAt };
}
