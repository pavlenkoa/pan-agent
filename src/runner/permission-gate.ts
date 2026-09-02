/**
 * Telegram Allow-once / Always-allow / Deny prompt for a gated tool call
 * (currently: eSputnik write tools — see `sdk-session.ts`'s
 * `ESPUTNIK_WRITE_TOOL_NAMES`). Mid-turn, in-process: `canUseTool` calls
 * `request()` and awaits its promise; the operator resolves it later via
 * `resolve()` once the person taps a button (see `shared/types.ts`'s
 * `permission_decision` ControlRequest for why the tool name never travels
 * through Telegram's `callback_data` and instead comes back out of
 * `resolve()`'s own return value).
 */
import { randomBytes } from 'node:crypto';

import { log } from '../shared/log.js';
import type { RunnerConfig } from './config.js';
import { sendPermissionRequest, sendTelegramReply } from './telegram-send.js';

// Same order of magnitude as session-controller.ts's controlTurnTimeoutMs
// precedent — long enough that a person glancing at their phone a few
// minutes later still catches it, short enough that a turn can't hang
// forever on an unanswered prompt (fail closed: times out to 'deny').
export const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

export type PermissionDecision = 'once' | 'always' | 'deny';

interface PendingRequest {
  toolName: string;
  timer: NodeJS.Timeout;
  resolve: (decision: PermissionDecision) => void;
}

export interface PermissionGate {
  /** Resolves once the person answers (or the request times out). Already-granted tools resolve immediately with no Telegram round trip. */
  request(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision>;
  /** Called from the runner's /control handler once the operator relays a button tap. `applied: false` means this requestId is unknown (already resolved, timed out, or lost to a pod restart). */
  resolve(requestId: string, decision: PermissionDecision): { applied: boolean; toolName?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same capped-backoff shape as session-controller.ts's RESTART_BACKOFFS_MS /
// operator/delivery.ts's backoffMs — short and bounded (worst case ~3s added
// latency), not a substitute for the 10-minute timeout above. Exists because
// of a confirmed live incident (2026-09-02): a single transient `fetch`
// failure sending the Telegram prompt left a request silently pending with
// nothing ever shown to the person, indistinguishable from "sent but not
// tapped yet" — they had no way to know anything was waiting on them until
// the full timeout elapsed. A couple of quick retries turns "one blip = 10
// minutes of silence" into "one blip = invisible." A constructor parameter
// on `createPermissionGate` (not a bare module constant) for the same
// reason `timeoutMs` already is — real timers only in this file's tests
// (per session-controller.test.ts's own note on why: advanceTimersByTimeAsync
// interacts badly with promise-chain-heavy code here), so tests shrink this
// instead of faking wall-clock time.
export const SEND_RETRY_DELAYS_MS = [1000, 2000];

async function sendWithRetries(
  send: () => Promise<void>,
  evt: string,
  fields: Record<string, unknown>,
  retryDelaysMs: number[],
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await send();
      return;
    } catch (err) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        log.error(evt, err, fields);
        return;
      }
      await sleep(delay);
    }
  }
}

function generateRequestId(): string {
  // 12 hex chars — short enough to stay well under Telegram's 64-byte
  // callback_data cap alongside the "pm:" prefix and decision suffix, plenty
  // unique for this pod's concurrent-request cardinality (effectively always
  // 0 or 1 outstanding, given single-flight turns).
  return randomBytes(6).toString('hex');
}

const INPUT_PREVIEW_MAX_LEN = 3000;
const VALUE_MAX_LEN = 300;

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '(unset)';
  if (typeof v === 'string') return truncate(v, VALUE_MAX_LEN);
  if (Array.isArray(v)) {
    if (v.length === 0) return '(empty)';
    return v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  }
  return String(v);
}

/**
 * Flattens a tool-input object into readable "key: value" lines instead of
 * raw JSON — a person approving/denying a call needs to see what's actually
 * changing, not `{`/`}`/quoting noise. Nested wrapper objects (eSputnik's
 * common `{payload: {...}}` shape, but this isn't hardcoded to that one key
 * — any nested object flattens the same way) use just the leaf key name
 * rather than a dotted path: these payloads are shallow enough in practice
 * that a path prefix would add noise without disambiguating anything real.
 *
 * `uploadSessionId` gets special-cased: it's an opaque reference to content
 * already uploaded in an earlier, ungated step (`prepare_email_message_upload`
 * + a plain `curl PUT`, confirmed live neither of which is a gated write
 * tool) — by the time this permission check fires, the actual content is
 * already gone from view. Showing the raw token would look like something
 * inspectable when it isn't; the honest thing is to say so explicitly
 * rather than let a person think the JSON is just terse.
 */
function flattenForDisplay(value: unknown, lines: string[]): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'uploadSessionId' && typeof v === 'string') {
        lines.push(`content: already uploaded (${truncate(v, 16)}), not shown here`);
        continue;
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        flattenForDisplay(v, lines);
      } else {
        lines.push(`${key}: ${formatScalar(v)}`);
      }
    }
    return;
  }
  lines.push(formatScalar(value));
}

export function formatInputPreview(input: Record<string, unknown>): string {
  const lines: string[] = [];
  try {
    flattenForDisplay(input, lines);
  } catch {
    lines.push(String(input));
  }
  if (lines.length === 0) lines.push('(no arguments)');
  return truncate(lines.join('\n'), INPUT_PREVIEW_MAX_LEN);
}

export function createPermissionGate(
  cfg: RunnerConfig,
  timeoutMs = PERMISSION_TIMEOUT_MS,
  retryDelaysMs = SEND_RETRY_DELAYS_MS,
): PermissionGate {
  const alwaysAllowed = new Set(cfg.toolPermissions);
  const pending = new Map<string, PendingRequest>();

  async function request(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    if (alwaysAllowed.has(toolName)) return 'always';

    const requestId = generateRequestId();
    const decision = await new Promise<PermissionDecision>((resolvePromise) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolvePromise('deny');
        void sendWithRetries(
          () =>
            sendTelegramReply(
              cfg.telegramBotToken,
              cfg.chatId,
              `⏱ No response to the permission request for ${toolName} in time — treated as denied.`,
            ),
          'permission_timeout_notice_failed',
          { person: cfg.slug, requestId, toolName },
          retryDelaysMs,
        );
      }, timeoutMs);
      pending.set(requestId, { toolName, timer, resolve: resolvePromise });

      // Left pending either way — a send failure (even after retries) isn't
      // distinguishable here from "sent but not yet tapped," and the timeout
      // above already fails closed.
      void sendWithRetries(
        () => sendPermissionRequest(cfg.telegramBotToken, cfg.chatId, requestId, toolName, formatInputPreview(input)),
        'permission_request_send_failed',
        { person: cfg.slug, requestId, toolName },
        retryDelaysMs,
      );
    });

    if (decision === 'always') alwaysAllowed.add(toolName);
    return decision;
  }

  function resolve(requestId: string, decision: PermissionDecision): { applied: boolean; toolName?: string } {
    const entry = pending.get(requestId);
    if (!entry) return { applied: false };
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    return { applied: true, toolName: entry.toolName };
  }

  return { request, resolve };
}
