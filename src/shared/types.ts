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

export interface ChatMessage {
  messageId: number;
  text: string;
  fromHandle: string | null;
  date: string; // ISO 8601
  attachments?: ChatAttachment[];
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

export type TurnRequest = ChatTurn | TaskTurn;

/** Turn journal key: dedup identity for a turn. */
export function turnKey(turn: TurnRequest): string {
  return turn.kind === 'chat' ? `tg:${turn.updateId}` : `task:${turn.taskId}:${turn.scheduledFor}`;
}

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

export interface PersonState {
  version: 1;
  profile: PersonProfile;
  tasks: TaskRecord[];
  runtime: PersonRuntime;
}

export function emptyPersonState(displayName: string): PersonState {
  return {
    version: 1,
    profile: { displayName, notes: '' },
    tasks: [],
    runtime: { lastDeliveredUpdateId: null },
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
