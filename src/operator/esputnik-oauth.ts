/**
 * Self-service eSputnik MCP OAuth — /esputnik_connect kicks this off
 * (person-commands.ts), the new public callback route (oauth-server.ts)
 * finishes it. See CLAUDE.md's eSputnik OAuth design note for the full
 * rationale; this module owns everything specific to eSputnik's OAuth
 * server (dynamic client registration, PKCE, the pending-request map, the
 * actual code<->token exchange) — oauth-server.ts stays a thin, isolated
 * HTTP wrapper with no OAuth logic of its own.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { CoreV1Api } from '@kubernetes/client-node';

import { log } from '../shared/log.js';
import { ESPUTNIK_SERVER_URL, type ChatMessage } from '../shared/types.js';
import type { OperatorConfig } from './config.js';
import { enqueueChatMessage } from './delivery.js';
import { createJsonConfigMap, isConflict, readJsonConfigMap } from './k8s.js';
import { writeEsputnikCredential, type EsputnikTokenSet } from './nfs.js';
import { readPeopleIndex } from './people-index.js';
import { postControl } from './pod-control.js';
import { upsertEsputnikConnection } from './person-state.js';

const REDIRECT_PATH = '/oauth/esputnik/callback';
const ESPUTNIK_ISSUER = 'https://mcp.esputnik.com/';
const ESPUTNIK_SCOPE = 'esputnik.api';
const CLIENT_CONFIGMAP_NAME = 'pan-agent-esputnik-oauth-client';
const CLIENT_DATA_KEY = 'client.json';
const PENDING_TTL_MS = 10 * 60_000;

interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  registeredAt: string;
}

interface PendingConnect {
  slug: string;
  account: string;
  serverKey: string;
  codeVerifier: string;
  expiresAt: number;
}

// Doesn't need to survive an operator restart — a lost pending request just
// means the person re-runs /esputnik_connect (design doc's own explicit
// call). Swept lazily rather than on a timer since entries are naturally
// bounded (one per in-flight /esputnik_connect, at this project's scale).
const pending = new Map<string, PendingConnect>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [state, p] of pending) {
    if (p.expiresAt < now) pending.delete(state);
  }
}

function redirectUriFor(cfg: OperatorConfig): string {
  return `https://${cfg.publicCallbackHost}${REDIRECT_PATH}`;
}

/**
 * Registers this deployment's OAuth client once via Dynamic Client
 * Registration and caches it in a small ConfigMap — a client identity, not a
 * per-person credential, safe to keep at the operator level (design doc's
 * framing). `token_endpoint_auth_method: 'none'` since the design doc's own
 * live test found the token endpoint accepts a refresh without a client
 * secret — this client is effectively public/PKCE-only.
 */
async function getOrRegisterClient(api: CoreV1Api, cfg: OperatorConfig): Promise<OAuthClientConfig> {
  const existing = await readJsonConfigMap<OAuthClientConfig>(api, cfg.namespace, CLIENT_CONFIGMAP_NAME, CLIENT_DATA_KEY);
  if (existing) return existing.value;

  const redirectUri = redirectUriFor(cfg);
  const res = await fetch(`${ESPUTNIK_SERVER_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) throw new Error(`eSputnik client registration failed: ${res.status}`);
  const body = (await res.json()) as { client_id: string; client_secret?: string };
  const config: OAuthClientConfig = {
    clientId: body.client_id,
    ...(body.client_secret ? { clientSecret: body.client_secret } : {}),
    redirectUri,
    registeredAt: new Date().toISOString(),
  };
  try {
    await createJsonConfigMap(api, cfg.namespace, CLIENT_CONFIGMAP_NAME, CLIENT_DATA_KEY, config);
  } catch (err) {
    if (!isConflict(err)) throw err;
    // Lost a create race against another operator instance/restart — the other write won, use it.
    const raced = await readJsonConfigMap<OAuthClientConfig>(api, cfg.namespace, CLIENT_CONFIGMAP_NAME, CLIENT_DATA_KEY);
    if (raced) return raced.value;
    throw err;
  }
  return config;
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Kicks off one OAuth flow — same call whether `account` is brand new or a renewal (person-commands.ts decides the reply wording, not this function). Returns the link to send the person. */
export async function beginEsputnikConnect(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  account: string,
  serverKey: string,
): Promise<{ url: string } | { error: string }> {
  sweepExpired();
  let client: OAuthClientConfig;
  try {
    client = await getOrRegisterClient(api, cfg);
  } catch (err) {
    log.error('esputnik_client_registration_failed', err, { person: slug });
    return { error: 'could not register with eSputnik right now — try again shortly.' };
  }

  const { verifier, challenge } = generatePkce();
  const state = randomBytes(32).toString('base64url');
  pending.set(state, { slug, account, serverKey, codeVerifier: verifier, expiresAt: Date.now() + PENDING_TTL_MS });

  const url = new URL(`${ESPUTNIK_SERVER_URL}/authorize`);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', ESPUTNIK_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString() };
}

interface EsputnikTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

async function exchangeCode(client: OAuthClientConfig, code: string, codeVerifier: string): Promise<EsputnikTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    code_verifier: codeVerifier,
  });
  const res = await fetch(`${ESPUTNIK_SERVER_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`eSputnik token exchange failed: ${res.status}`);
  return (await res.json()) as EsputnikTokenResponse;
}

/**
 * Fires a `[System note: ...]` turn the same way person-commands.ts's own
 * notifyModel does — duplicated rather than imported to avoid a circular
 * import (person-commands.ts already imports beginEsputnikConnect from this
 * module). Best-effort: a missing person record (deleted/denied between
 * /esputnik_connect and completing the browser flow) just skips the note.
 */
/**
 * Spells out the tool prefix explicitly rather than just saying "connected"
 * — confirmed live 2026-08-29 that a bare "connected" note isn't enough:
 * asked to verify the connection, the model had no way to know these MCP
 * tools existed at all and reached for the older Basic-Auth esputnik-query
 * skill instead (the only eSputnik mechanism its CLAUDE.md described at the
 * time). CLAUDE.md now documents this mechanism too, but an
 * already-running session won't see that update mid-conversation (persona
 * changes only get nudged into a resumed session around pod restart, not
 * live) — this note is what actually reaches an already-connected session.
 */
async function notifyEsputnikConnected(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  account: string,
  serverKey: string,
): Promise<void> {
  const idx = await readPeopleIndex(api, cfg.namespace);
  const person = idx.people[slug];
  if (!person) return;
  const message: ChatMessage = {
    messageId: 0,
    text: `[System note: eSputnik account "${account}" connected — you now have live tools named mcp__${serverKey}__... (e.g. mcp__${serverKey}__get_account_info), ready to use right now with no further setup. Stay silent unless it's worth mentioning.]`,
    fromHandle: null,
    date: new Date().toISOString(),
  };
  await enqueueChatMessage(api, cfg, slug, person.chatId, person.tz, person.tasksToken, 0, message).catch((err) =>
    log.error('esputnik_connect_notify_failed', err, { person: slug }),
  );
}

export interface CallbackResult {
  ok: boolean;
  /** Generic, safe to render directly in the browser — never the eSputnik error body or an exception message (CLAUDE.md's secret-hygiene rule, extended to error detail here too). */
  message: string;
}

/**
 * The actual callback logic (oauth-server.ts's route handler delegates
 * here). Validates `state` before ever attempting the token exchange — a
 * forged/expired `state` never reaches eSputnik's `/token` endpoint at all.
 */
export async function handleCallback(api: CoreV1Api, cfg: OperatorConfig, query: URLSearchParams): Promise<CallbackResult> {
  sweepExpired();
  const code = query.get('code');
  const stateParam = query.get('state');
  if (!code || !stateParam) {
    return { ok: false, message: 'Missing code or state.' };
  }

  const entry = pending.get(stateParam);
  if (!entry) {
    return { ok: false, message: 'That link is invalid or expired — run /esputnik_connect again in Telegram.' };
  }
  pending.delete(stateParam); // single-use

  let client: OAuthClientConfig;
  try {
    client = await getOrRegisterClient(api, cfg);
  } catch (err) {
    log.error('esputnik_callback_client_lookup_failed', err, { person: entry.slug });
    return { ok: false, message: 'Something went wrong — try /esputnik_connect again in Telegram.' };
  }

  let token: EsputnikTokenResponse;
  try {
    token = await exchangeCode(client, code, entry.codeVerifier);
  } catch (err) {
    log.error('esputnik_token_exchange_failed', err, { person: entry.slug, account: entry.account });
    return { ok: false, message: 'Something went wrong completing the connection — try /esputnik_connect again in Telegram.' };
  }

  const tokens: EsputnikTokenSet = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    issuer: ESPUTNIK_ISSUER,
    scope: token.scope ?? ESPUTNIK_SCOPE,
    discoveryState: {
      authorizationServerUrl: ESPUTNIK_ISSUER,
      resourceMetadataUrl: `${ESPUTNIK_SERVER_URL}/.well-known/oauth-protected-resource`,
      oauthMetadataFound: true,
    },
  };

  try {
    await writeEsputnikCredential(entry.slug, entry.serverKey, tokens);
  } catch (err) {
    log.error('esputnik_credential_write_failed', err, { person: entry.slug, account: entry.account });
    return { ok: false, message: 'Something went wrong saving the connection — try /esputnik_connect again in Telegram.' };
  }

  await upsertEsputnikConnection(api, cfg.namespace, entry.slug, entry.account, entry.serverKey);

  // Best-effort live sync — not fatal on failure, since buildQueryOptions
  // (runner/sdk-session.ts) picks the account up from the credentials file
  // itself on any future restart regardless.
  const syncResult = await postControl(api, cfg, entry.slug, { action: 'sync_esputnik_mcp', serverKey: entry.serverKey });
  if (!syncResult?.ok) {
    log.line('esputnik_sync_deferred', { person: entry.slug, account: entry.account });
  }

  await notifyEsputnikConnected(api, cfg, entry.slug, entry.account, entry.serverKey);

  log.line('esputnik_account_connected', { person: entry.slug, account: entry.account });
  return { ok: true, message: `Connected your eSputnik account "${entry.account}". You can close this tab.` };
}
