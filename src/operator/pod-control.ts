/**
 * POSTs to a person's own pod's `/control` endpoint — a live call against
 * their already-running session, not a turn (see shared/types.ts). Split out
 * of person-commands.ts since esputnik-oauth.ts's callback handler needs the
 * exact same call (to sync a newly-connected MCP server into the live
 * session) and neither module should import from the other (same
 * dependency-free-shared-module convention CLAUDE.md documents for
 * bot-commands.ts).
 */
import type { CoreV1Api } from '@kubernetes/client-node';

import { log } from '../shared/log.js';
import type { ControlRequest, ControlResponse } from '../shared/types.js';
import type { OperatorConfig } from './config.js';
import { podIp } from './pod-lifecycle.js';
import { RUNNER_PORT } from './pod-template.js';

/** Returns null on any failure to reach the pod. */
export async function postControl(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  body: ControlRequest,
): Promise<ControlResponse | null> {
  const ip = await podIp(api, cfg.namespace, slug);
  if (!ip) return null;
  try {
    const res = await fetch(`http://${ip}:${RUNNER_PORT}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return (await res.json()) as ControlResponse;
  } catch (err) {
    log.error('control_request_failed', err, { person: slug });
    return null;
  }
}
