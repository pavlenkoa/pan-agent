# pan-agent

## Project Overview

A multi-tenant Telegram host for the Claude Agent SDK, replacing a hand-rolled
single-tenant deployment. One always-on **operator** process talks directly to
the Kubernetes API to create and manage one long-lived, isolated **pod per
approved person** — each pod running a persistent Claude Agent SDK session
(`claude` subprocess) that spans the pod's whole lifetime, not one process per
message. No CRD/controller — direct pod management from a single process, the
simplest thing that works at "handful of people, one admin" scale.

**Primary use cases:** a personal-assistant bot per person (media search/download
via Toloka/Transmission/Emby, scheduled reminders, general Q&A, and increasingly
self-service extension — custom env vars, native persistent memory), all sharing
one Telegram bot identity but with hard isolation between people's pods, workspaces,
and conversations.

## Tech Stack

- **Language:** TypeScript (Node 24+, ESM)
- **Runtime:** `@anthropic-ai/claude-agent-sdk` (spawns the real `claude` CLI)
- **K8s client:** `@kubernetes/client-node`
- **Test runner:** Vitest
- **Storage:** NFS-backed `ConfigMap`s for state (no SQLite, no message queue) +
  NFS-mounted per-person home/workspace directories

## Project Structure

```
src/
  shared/
    types.ts          # /turn + /tasks API contracts, ConfigMap state schemas
    http.ts, log.ts    # tiny JSON HTTP helpers, structured stdout logger
  operator/            # Deployment (1 replica) — never on the reply path
    telegram.ts        # single getUpdates long-poll consumer + sendMessage/setMyCommands
    router.ts          # known/pending/denied routing, unknown-sender bootstrap
    admin-commands.ts  # /approve /deny /people /restart (admin DM only)
    person-commands.ts # /set_var /list_vars /unset_var /memories /forget_memory (self-service)
    bot-commands.ts    # the two command lists + shared register/clear-menu helpers
    provisioning.ts    # telegramUserId + slug -> active person with a running pod
    people-index.ts    # pan-agent-people ConfigMap (routing index)
    person-state.ts    # pan-agent-person-<slug> ConfigMap (profile, tasks, customEnv)
    pod-template.ts    # per-person Pod spec
    pod-lifecycle.ts   # create/wait-ready/recreate/remove a person's pod
    nfs.ts              # operator's own NFS-root mount: home dirs, memory-file mgmt
    delivery.ts         # POST /turn with retry + batching-under-retry
    cron.ts, sweep.ts   # scheduled-task next-fire computation + 60s sweep
    tasks-api.ts        # HTTP API the runner's scheduling MCP tools call
    reconcile.ts        # boot reconcile: diff ConfigMap index vs live pods
    k8s.ts               # thin CRUD wrapper (Pod, ConfigMap) + optimistic-concurrency retry
  runner/               # runs inside every person pod
    session-controller.ts  # the persistent query() loop, single-flight, crash/restart
    sdk-session.ts          # pure helpers: prompt building, query options, tool allowlist
    pushable-queue.ts        # push-based async queue feeding the SDK's streaming input
    journal.ts               # NFS-backed idempotency ledger (dedup by updateId/task tuple)
    scheduling-tools.ts, attachment-tools.ts  # in-process MCP tools
    attachments.ts, telegram-send.ts          # inbound download / outbound send
    index.ts                                   # /turn + /healthz HTTP server
helm/pan-agent/         # the chart a deploying cluster's GitOps repo pulls
```

## Architecture

**Routing.** Telegram → operator (single `getUpdates` consumer, shared bot
token) → `pan-agent-people` ConfigMap resolves sender to a slug → `POST /turn`
to that person's pod IP. An unknown sender is held in a `pending` bucket and
DMs the admin for `/approve`, unless their id is in `TELEGRAM_ALLOWED_IDS`, in
which case they're auto-provisioned immediately. Person pods reply to Telegram
**directly** with their own token — the operator is never on the reply path,
so a wedged operator can't eat an in-flight reply.

**Isolation: one pod per person, always-on.** Created once on first contact,
left running indefinitely (no idle-teardown at this scale). Each pod only ever
sees messages from its one person; no shared session, no shared workspace or
memory — except one deliberately shared NFS directory, `/tracking`, used for
cross-person media-download/subscription bookkeeping (documented in the persona,
not a leak — nothing conversational lives there).

**State: ConfigMaps, not SQLite.** Two ConfigMaps per deployment plus one per
person: `pan-agent-people` (routing index — slug → `{telegramUserId, chatId,
status, tz, tasksToken}`, plus `pending`/`denied` maps) and
`pan-agent-person-<slug>` (profile, scheduled tasks, `customEnv` for
`/set_var`). `ConfigMap`s have no transactions — every write goes through
`updateJsonConfigMap`'s read-modify-write-with-resourceVersion-retry, and
turn delivery is deduped via a separate NFS-backed journal on the runner side
(idempotency key = Telegram `updateId` or `(taskId, scheduledFor)`), not
trusted to the ConfigMap alone.

**Session model.** One SDK `query()` per pod spans the pod's whole lifetime
(`session-controller.ts`), not one per turn — this is what makes backgrounded
Bash and proactive follow-up messages actually work: a `task_notification`
from a backgrounded command lands on the same long-lived stream and can
trigger a message well after the turn that started it already replied.
Single-flight by construction (only one pushed message outstanding at a time),
so "the next `result` is the answer to what was just pushed" needs no
correlation id. Session id is persisted the moment it's first seen (not
batched to end-of-turn) so a crash between those two points can't orphan the
session. A stream crash retries in-process a bounded number of times
(1s/2s/4s backoff) before `process.exit(1)`, letting k8s's `restartPolicy:
Always` bring up a fresh container — simpler than an indefinite in-process
supervisor.

**Scheduling: operator-owned, sweep-driven.** Task definitions live in the
person's state ConfigMap. The operator sweeps every `SWEEP_INTERVAL_MS`
(default 60s); a due task delivers to the owning pod exactly like an incoming
message. Recurrence is drift-free (next occurrence always computed from the
*scheduled* time, never "now"), and a catch-up window bounds how much missed
time gets replayed after an outage. The model schedules through
`schedule_task`/`list_tasks`/`cancel_task` MCP tools — nothing is ever
"remembered" by the model across restarts.

**Credentials.** `claude setup-token` once, stored in Vault, delivered via
`ExternalSecret` → k8s `Secret` → env var, same as every other credential
(Toloka, Emby, TMDB, GitHub, Seedpool). No credential broker — pods talk
directly to Anthropic; every person pod currently gets the same set of shared
service credentials (see Non-Goals).

**Network policy** (Cilium): a person pod's ingress is restricted to the
operator's pod label only (`POST /turn`); egress covers DNS, the operator's
`/tasks` API, Transmission RPC, Emby (CIDR-scoped), NFS, and general internet
(`0.0.0.0/0` minus excludes) for `api.anthropic.com`/`api.telegram.org`/
trackers/TMDB/GitHub — **not** a domain allowlist. The runner never talks to
the k8s API server, only the operator does.

**Observability.** Every SDK message (assistant text, thinking, tool_use,
tool_result, compact boundaries, memory recalls) gets one structured JSON line
on stdout (`src/shared/log.ts`) — no separate log shipper; whatever ships pod
stdout to your log backend picks it up like any other pod.

## Key conventions and gotchas

- **`tools` vs `allowedTools` on the Agent SDK's `Options`.** `allowedTools`
  only skips the permission prompt for the tools it names — it does **not**
  restrict which built-in tools exist. The actual allowlist is `tools`.
  Getting this backwards is how a bare `allowedTools: ['Bash', ...]` entry
  silently made the SDK's entire native toolset (`CronCreate`, `Monitor`,
  etc.) available regardless of what looked like a restrictive allowlist —
  the SDK even prints a `CAN_USE_TOOL_SHADOWED` warning about this at boot.
  `CronCreate` and its relatives are excluded from `tools` permanently: it's
  a session-only, non-durable timer with a hard 7-day expiry, strictly worse
  than `schedule_task` regardless of process lifetime. `Skill` hit the exact
  same gotcha: a `SKILL.md` with YAML frontmatter under
  `.claude/skills/<name>/` is auto-discovered and listed regardless of
  `tools`, but is silently uninvokable unless `'Skill'` is also in `tools` —
  confirmed live against the installed SDK before relying on either
  behavior.
- **`.claude/skills/` (and `hooks/`/`commands/`/`settings*`) is a protected
  surface even under `permissionMode: 'acceptEdits'`.** A `Write`/`Edit`/
  `Bash` call targeting it is denied unconditionally — neither `acceptEdits`
  nor an explicit `settings.permissions.allow` rule for it bypasses this
  (confirmed live: both tried, both still denied). This first showed up as a
  real stuck turn in production: the model tried to create a person's skill,
  got "you haven't granted it yet," and there was no dialog anywhere in this
  headless Telegram bot for a human to grant it. The only bypass is a
  `canUseTool` callback (`buildSkillsCanUseTool` in `runner/sdk-session.ts`)
  that explicitly allows `Write`/`Edit`/`Bash` into that one directory.
  Confirmed live this callback is *only* ever invoked for calls the bare
  `tools`/`allowedTools` entries don't already auto-approve (the SDK's own
  `CAN_USE_TOOL_SHADOWED` warning says as much) — so adding it is additive,
  it can't loosen anything that already worked.
- **Check for a native SDK feature before building one.** Before adding
  bespoke persistent-memory plumbing, checking the *installed*
  `@anthropic-ai/claude-agent-sdk` package's own type definitions
  (`sdk.d.ts`/`sdk-tools.d.ts` in `node_modules`) turned up that auto-memory
  is already a real, on-by-default SDK feature (`Options.settings.autoMemoryEnabled`
  / `autoMemoryDirectory`, using plain `Read`/`Write` — no new tool needed).
  Verify against the actual installed types, not a general impression of
  what the SDK does — and don't take an agent's claims about SDK behavior at
  face value either; cross-check before relying on it.
- **Secret hygiene for self-service commands.** `/set_var`/`/unset_var`/
  `/memories`/`/forget_memory` are intercepted by the operator *before* the
  message becomes a turn — a secret value never enters the model's
  conversation, turn logs, or stdout. But a command mutating state that the
  model *should* know about (a var was set, a memory was deleted) still
  fires a `[System note: ...]` turn afterward with the fact (never the
  value) — otherwise the model has no way to know the command happened and
  can end up flatly contradicting the person about their own just-taken
  action.
- **NFS path shape.** Per-person: `<nfsRootPath>/people/<slug>/{claude,workspace}`
  (mounted at `/home/claude/.claude` and `/home/claude/workspace`
  respectively) — never shared. `<nfsRootPath>/tracking` is the one
  deliberately shared mount. `RESERVED_ENV_NAMES` (`pod-template.ts`) is the
  single source of truth for env var names `/set_var` can never shadow —
  checked at write time and again defensively when the pod spec is built.
- **Telegram's `setMyCommands` registration is chat-scoped and sticky.**
  Always register with `scope: {type: 'chat', chat_id}`, never a
  default/global scope, so an unapproved sender's chat has no `/` menu at
  all — not hidden client-side, genuinely unregistered. It's sticky: nothing
  un-sets it automatically, so `/deny` has to explicitly clear it
  (`bot-commands.ts`'s `clearCommandsFor`), and the operator re-asserts the
  correct list (or clears it) for every known chat on every boot to
  self-heal drift. Command *names* may only contain lowercase
  letters/digits/`_` — no hyphens.
- **Person pods are bare `Pod`s, not a `Deployment`.** A new image requires
  deleting the running person pods and restarting the operator (whose boot
  reconcile recreates anything missing) — see the README's deploy section.
- **Testing convention.** Pure/deterministic logic gets unit tests
  (`isAuthorized`, `slugifyForPerson`, cron math, command-argument parsers,
  `buildPersonPodSpec`). k8s-API-touching glue (ConfigMap mutators, pod
  lifecycle, command handlers) generally doesn't get direct unit tests —
  the value is low relative to the mocking cost. Plain-filesystem code
  (`journal.ts`, `nfs.ts`'s memory-file functions) *is* tested, against a
  real temp directory — no k8s dependency, so no reason not to.
- **Circular imports.** `admin-commands.ts` → `provisioning.ts` already
  exists (for `/approve`). Anything both `provisioning.ts` and
  `admin-commands.ts` need (e.g. the bot-command lists) goes in a
  dependency-free module (`bot-commands.ts`), not inline in either.

## Non-goals (deferred, not forgotten)

- **Credential broker.** Every person pod gets the same shared service
  credentials directly — no per-credential scoping, no proxy. Acceptable at
  current trust/scale; a clean future increment if ever needed.
- **Channels beyond Telegram, group chats, horizontal scale, multi-cluster.**
- **CRD/controller.** Direct pod management from one process is sufficient
  at "handful of people" scale; don't reintroduce that complexity without a
  concrete reason it's insufficient.

## Current status

Live and deployed. Implemented: operator + runner core, per-person pod
lifecycle and boot reconcile, Telegram routing with bootstrap/approve/deny
flow, `/tasks` scheduling API with per-person bearer-token authorization,
inbound/outbound Telegram attachments (including multi-file albums),
persistent per-person SDK sessions (backgrounded Bash + proactive
follow-ups), `/set_var` family for self-service persistent env vars, native
auto-memory + `/memories`/`/forget_memory`, chat-scoped native Telegram
command menus, per-person custom **Skills** (model-authored
`.claude/skills/<name>/SKILL.md` in the person's own workspace via native
SDK `Skill`-tool invocation, plus `/skills`/`/forget_skill` for oversight —
same shape as the memory work, no ConfigMap involved). A full security
review of credential handling, the attachment path allowlist, MCP tool
surface, and NFS isolation has been done once; not a recurring process yet.
