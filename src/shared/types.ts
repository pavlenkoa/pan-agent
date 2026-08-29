/**
 * Shapes shared between the operator and the runner: the `/turn` handoff,
 * the operator's `/tasks` API (called by the runner's scheduling MCP tools),
 * and the ConfigMap-backed state schema described in the architecture doc
 * (section 4).
 */

// ---------------------------------------------------------------------------
// /turn — operator -> pod
// ---------------------------------------------------------------------------

export interface ChatAttachment {
  kind: 'photo' | 'document';
  fileId: string;
  fileName: string | null;
  mimeType: string | null;
}

/** What a `ChatMessage` was a Telegram-native reply to, if anything — quoted text is truncated (see REPLY_SNIPPET_MAX_LEN in router.ts), not the full original message. */
export interface ChatReplyTo {
  messageId: number;
  snippet: string;
  fromHandle: string | null;
}

export interface ChatMessage {
  messageId: number;
  text: string;
  fromHandle: string | null;
  date: string; // ISO 8601
  attachments?: ChatAttachment[];
  replyTo?: ChatReplyTo;
}

export interface ChatTurn {
  kind: 'chat';
  updateId: number;
  chatId: number;
  messages: ChatMessage[];
}

export interface TaskTurn {
  kind: 'task';
  taskId: string;
  scheduledFor: string; // ISO 8601 — the nextRunAt this firing corresponds to
  chatId: number;
  prompt: string;
}

/**
 * `/compact` and `/clear` are real SDK-recognized commands (confirmed live:
 * pushing the bare text produces a genuine `compact_boundary`/
 * `conversation_reset` protocol message, not a model reply) — but ONLY as
 * the literal command text with nothing else in the message. A normal
 * ChatTurn always gets `${fromHandle}: ${text}` prefixed by `buildPrompt`
 * (confirmed live this is exactly what broke it in production — the model
 * saw "Andrii Pavlenko: /compact" and answered it as a real question
 * instead of the SDK ever recognizing the command). This turn kind exists
 * so `buildPrompt`/`buildUserMessage` can push the bare command with no
 * prefix, while still going through the same single-flight queue, journal
 * dedup, and busy/retry delivery as any other turn.
 */
export interface ControlTurn {
  kind: 'control';
  updateId: number;
  chatId: number;
  command: '/compact' | '/clear';
}

export type TurnRequest = ChatTurn | TaskTurn | ControlTurn;

/** Turn journal key: dedup identity for a turn. */
export function turnKey(turn: TurnRequest): string {
  if (turn.kind === 'chat') return `tg:${turn.updateId}`;
  if (turn.kind === 'control') return `ctl:${turn.updateId}`;
  return `task:${turn.taskId}:${turn.scheduledFor}`;
}

// ---------------------------------------------------------------------------
// /control — operator -> pod, live session introspection/config (not a turn:
// no journal entry, no single-flight queue — a direct control-plane call
// against the person's already-running SDK session)
// ---------------------------------------------------------------------------

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh';

// Confirmed live 2026-08-23: the SDK's own autoCompactThreshold scales with
// the model's context window (~96.6% of it observed in production — 934,000
// of 967,000), not a small conservative default. This is this app's own
// choice of a much tighter ceiling (session-controller.ts's
// `maybeTriggerAutoCompact`), enforced independently rather than relying on
// any SDK setting (`settings.autoCompactWindow` was tried and confirmed to
// have zero effect on the SDK's own threshold). Shared so person-commands.ts
// can say what a limit reset reverts to, without duplicating the number.
export const DEFAULT_CONTEXT_LIMIT = 250_000;

export interface ContextUsageSummary {
  model: string;
  totalTokens: number;
  maxTokens: number;
  /**
   * The SDK's own internal ceiling — confirmed live 2026-08-23 this is NOT a
   * fixed conservative default, it scales with `maxTokens` (observed ~96.6%
   * of it in production: 934,000 of 967,000). It's the model's own
   * last-resort safety net, not something this app configures or should be
   * read as "the effective limit" — see `contextLimit` for that.
   */
  sdkAutoCompactCeiling: number | null;
  isAutoCompactEnabled: boolean;
  /** Currently-applied effort level — session-controller's own tracked value (the SDK exposes no getter for this), reset to the `buildQueryOptions` default on pod restart. */
  effortLevel: EffortLevel;
  /** App-enforced soft cap (session-controller.ts) — proactively triggers a real `/compact` once total tokens cross this, independent of the SDK's own much-higher internal ceiling. Set via /context_limit. */
  contextLimit: number;
}

/** One eSputnik MCP server's live connection health, from the SDK's own `mcpServerStatus()`. */
export interface EsputnikServerStatus {
  serverKey: string;
  status: string;
}

export type ControlRequest =
  | { action: 'context' }
  | { action: 'set_effort'; level: EffortLevel }
  | { action: 'set_context_limit'; tokens: number }
  /**
   * One action whether `serverKey` is brand-new to this session or a
   * renewal of one it already has wired up — the runner (session-controller.ts),
   * not the operator, decides `setMcpServers` (add) vs. `reconnectMcpServer`
   * (renew) from its own tracked set of known server keys. See CLAUDE.md's
   * eSputnik OAuth section for why the operator can't reliably make that
   * call itself.
   */
  | { action: 'sync_esputnik_mcp'; serverKey: string }
  | { action: 'esputnik_status' };

export type ControlResponse =
  | { ok: true; action: 'context'; context: ContextUsageSummary }
  | { ok: true; action: 'set_effort' }
  | { ok: true; action: 'set_context_limit' }
  | { ok: true; action: 'sync_esputnik_mcp'; mode: 'added' | 'reconnected' }
  | { ok: true; action: 'esputnik_status'; servers: EsputnikServerStatus[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// People index — pan-agent-people ConfigMap
// ---------------------------------------------------------------------------

export type PersonStatus = 'active' | 'denied';

export interface PersonIndexEntry {
  telegramUserId: number;
  chatId: number;
  status: PersonStatus;
  tz: string;
  createdAt: string;
  lastSeenAt: string;
  /** Bearer token this person's pod presents to the operator's /tasks API (authorizes only its own slug). */
  tasksToken: string;
}

export interface PendingPerson {
  handle: string;
  name: string;
  firstMessage: string;
  firstSeenAt: string;
}

export interface DeniedPerson {
  deniedAt: string;
}

export interface PeopleIndex {
  version: 1;
  people: Record<string, PersonIndexEntry>; // keyed by slug
  pending: Record<string, PendingPerson>; // keyed by telegramUserId (string)
  denied: Record<string, DeniedPerson>; // keyed by telegramUserId (string)
}

export function emptyPeopleIndex(): PeopleIndex {
  return { version: 1, people: {}, pending: {}, denied: {} };
}

// ---------------------------------------------------------------------------
// Per-person state — pan-agent-person-<slug> ConfigMap
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id: string;
  cron: string;
  tz: string;
  prompt: string;
  nextRunAt: string; // ISO 8601
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | 'skipped' | null;
  paused: boolean;
  createdAt: string;
}

export interface PersonProfile {
  displayName: string;
  notes: string;
}

export interface PersonRuntime {
  lastDeliveredUpdateId: number | null;
}

/** A person's own custom env var, set via /set_var. Injected into their pod's env at pod-create time. */
export interface CustomEnvVar {
  value: string;
  description: string;
  setAt: string; // ISO 8601
}

/**
 * One eSputnik account a person has connected via /esputnik_connect.
 * `serverKey` (`esputnik-<account>`) is the literal key used both in the
 * runner's `Options.mcpServers` and as the `mcpOAuth` credential prefix on
 * NFS — derived deterministically from `account` alone, never regenerated,
 * so reconnecting the same account always targets the same entry rather
 * than creating a duplicate (see CLAUDE.md's eSputnik OAuth renewal note).
 */
export interface EsputnikConnection {
  account: string;
  serverKey: string;
  connectedAt: string; // ISO 8601 — bumped on reconnect, not just first connect
}

/** `esputnik-<account>` — shared by operator (esputnik-oauth.ts, nfs.ts) and runner (sdk-session.ts) so both sides always agree on the same key for a given account label. */
export function esputnikServerKey(account: string): string {
  return `esputnik-${account}`;
}

export const ESPUTNIK_SERVER_URL = 'https://mcp.esputnik.com';

export interface PersonState {
  version: 1;
  profile: PersonProfile;
  tasks: TaskRecord[];
  runtime: PersonRuntime;
  customEnv: Record<string, CustomEnvVar>; // keyed by var name
  esputnikConnections: EsputnikConnection[];
}

export function emptyPersonState(displayName: string): PersonState {
  return {
    version: 1,
    profile: { displayName, notes: '' },
    tasks: [],
    runtime: { lastDeliveredUpdateId: null },
    customEnv: {},
    esputnikConnections: [],
  };
}

// ---------------------------------------------------------------------------
// Operator /tasks API — called by the runner's in-process MCP tools
// ---------------------------------------------------------------------------

export interface ScheduleTaskRequest {
  slug: string;
  cron: string;
  tz: string;
  prompt: string;
  id?: string; // caller may propose an id; operator generates one when absent
}

export interface CancelTaskRequest {
  slug: string;
  taskId: string;
}

export interface ListTasksRequest {
  slug: string;
}

export interface TasksApiError {
  error: string;
}
