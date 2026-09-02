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

function generateRequestId(): string {
  // 12 hex chars — short enough to stay well under Telegram's 64-byte
  // callback_data cap alongside the "pm:" prefix and decision suffix, plenty
  // unique for this pod's concurrent-request cardinality (effectively always
  // 0 or 1 outstanding, given single-flight turns).
  return randomBytes(6).toString('hex');
}

const INPUT_PREVIEW_MAX_LEN = 3000;

function previewInput(input: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return json.length > INPUT_PREVIEW_MAX_LEN ? `${json.slice(0, INPUT_PREVIEW_MAX_LEN)}…` : json;
}

export function createPermissionGate(cfg: RunnerConfig, timeoutMs = PERMISSION_TIMEOUT_MS): PermissionGate {
  const alwaysAllowed = new Set(cfg.toolPermissions);
  const pending = new Map<string, PendingRequest>();

  async function request(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    if (alwaysAllowed.has(toolName)) return 'always';

    const requestId = generateRequestId();
    const decision = await new Promise<PermissionDecision>((resolvePromise) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolvePromise('deny');
        void sendTelegramReply(
          cfg.telegramBotToken,
          cfg.chatId,
          `⏱ No response to the permission request for ${toolName} in time — treated as denied.`,
        ).catch((err) => log.error('permission_timeout_notice_failed', err, { person: cfg.slug, requestId, toolName }));
      }, timeoutMs);
      pending.set(requestId, { toolName, timer, resolve: resolvePromise });

      void sendPermissionRequest(cfg.telegramBotToken, cfg.chatId, requestId, toolName, previewInput(input)).catch((err) => {
        // Left pending — a send failure isn't distinguishable here from "sent
        // but not yet tapped," and the timeout above already fails closed.
        log.error('permission_request_send_failed', err, { person: cfg.slug, requestId, toolName });
      });
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
