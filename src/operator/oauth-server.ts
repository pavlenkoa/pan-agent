/**
 * The operator's first-ever public-facing inbound HTTP surface (CLAUDE.md's
 * eSputnik OAuth design note) — a second, isolated `node:http` server, not a
 * route bolted onto tasks-api.ts: no shared state with `/turn`/`/tasks`, so
 * a bug here can't reach the rest of the operator's API surface (the design
 * doc's own explicit security requirement). All actual OAuth logic lives in
 * esputnik-oauth.ts; this file is just the HTTP shell.
 */
import { createServer, type Server } from 'node:http';

import type { CoreV1Api } from '@kubernetes/client-node';

import { sendHtml } from '../shared/http.js';
import { log } from '../shared/log.js';
import type { OperatorConfig } from './config.js';
import { handleCallback } from './esputnik-oauth.js';

const CALLBACK_PATH = '/oauth/esputnik/callback';
// A callback only ever needs a handful of short params (code, state) — well
// under this, so a garbage request costs nothing more than rejecting on
// length before any real work happens.
const MAX_URL_LENGTH = 2048;

// Simple fixed-window per-IP counter — defense in depth, not load-bearing:
// the real protection is the high-entropy single-use `state` map in
// esputnik-oauth.ts, which rejects a forged/replayed request before any
// external call is ever made. See CLAUDE.md's security notes on this route.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const requestCounts = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    requestCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>pan-agent</title></head><body style="font-family: sans-serif; max-width: 32rem; margin: 4rem auto; text-align: center;">${body}</body></html>`;
}

export function startOAuthCallbackServer(api: CoreV1Api, cfg: OperatorConfig): Server {
  const server = createServer((req, res) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if ((req.url?.length ?? 0) > MAX_URL_LENGTH) {
      sendHtml(res, 414, page('<p>Bad request.</p>'));
      return;
    }
    if (isRateLimited(ip)) {
      sendHtml(res, 429, page('<p>Too many requests — try again in a minute.</p>'));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://internal');
    if (req.method === 'GET' && url.pathname === CALLBACK_PATH) {
      void handleCallback(api, cfg, url.searchParams)
        .then((result) => sendHtml(res, result.ok ? 200 : 400, page(`<p>${result.message}</p>`)))
        .catch((err) => {
          // Never echo the internal error back to the browser — logged
          // server-side only (CLAUDE.md's secret-hygiene rule, extended to
          // error detail on this route).
          log.error('oauth_callback_error', err);
          sendHtml(res, 500, page('<p>Something went wrong — try /esputnik_connect again in Telegram.</p>'));
        });
      return;
    }

    sendHtml(res, 404, page('<p>Not found.</p>'));
  });
  server.listen(cfg.oauthCallbackPort, () => log.line('oauth_callback_server_listening', { port: cfg.oauthCallbackPort }));
  return server;
}
