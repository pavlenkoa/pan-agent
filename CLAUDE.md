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
via Toloka/qBittorrent/Emby, scheduled reminders, general Q&A, and increasingly
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
    person-commands.ts # /set_var family, /memories, /skills, /context, /effort, /context_limit, /compact, /clear (self-service)
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
    index.ts                                   # /turn + /control + /healthz HTTP server
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

**Context management: app-enforced, not SDK-trusted.** Confirmed live
2026-08-23: the SDK's own `autoCompactThreshold` scales with the model's
context window (~96.6% of it observed in production, e.g. 934,000 of
967,000) — it's the model's own last-resort safety net, not a usable budget.
`session-controller.ts` tracks its own much tighter `contextLimit` (default
250,000, live-configurable via `/context_limit`) and proactively pushes a
real `/compact` once a turn's usage crosses it, independent of the SDK's own
ceiling. `/compact` and `/clear` are genuine SDK-recognized commands
(confirmed live: a real `compact_boundary`/`conversation_reset` protocol
message, not a model reply) but only work as the *bare* command text — see
the gotcha below. Every control turn (manual or auto-triggered) is bounded by
`controlTurnTimeoutMs` (default 180s) since a resumed session's `/compact`
has been observed to hang indefinitely with zero SDK output otherwise (root
cause unconfirmed — leading hypothesis is NFS session-store I/O contention or
pod-restart timing, not a deterministic bug). `/context`/`/effort` are live
control-plane reads/writes against the person's already-running `Query`
handle (`getContextUsage()`/`applyFlagSettings()`), routed through a
dedicated `/control` endpoint since they aren't turns.

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
`/tasks` API, qBittorrent's WebUI API, Emby (CIDR-scoped), NFS, and general internet
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
- **The SDK's `PermissionMode: 'auto'` is a model classifier, not a
  human-in-the-loop gate — checked and deliberately not used for the
  Telegram permission prompt (`runner/permission-gate.ts`).** Per the
  installed SDK's own `sdk.d.ts`: `'auto'` "use[s] a model classifier to
  approve/deny permission prompts" — an LLM decides, which is exactly the
  "no real gate, just automated discretion" problem this prompt exists to
  close, just moved to a different automated layer. `setMcpPermissionModeOverride(serverName,
  'auto'|'default'|null)` is also a dead end here: its own doc comment says
  the override only takes effect "when the session mode would already
  auto-allow (bypassPermissions/auto)" — this runner's session-wide
  `permissionMode` is `'acceptEdits'`, so the override wouldn't engage
  without first flipping the whole session to a more permissive mode, the
  opposite direction from what's wanted. Also checked and not reused: the
  official `claude-plugins-official` Telegram channel plugin already
  implements an Allow/Deny Telegram prompt, but against
  `notifications/claude/channel/permission_request`/`.../permission`, a
  protocol tied to the `claude` CLI's `--channels` flag (`Options.settings.channelsEnabled`
  plus `--channels plugin:...` server selection) — there's no equivalent
  field reachable from the SDK's own `query()`/`Options` surface this
  runner actually uses, so the protocol itself isn't adoptable here (its
  `InlineKeyboard`/`callback_query`/answer-every-branch/edit-to-lock-in-outcome
  UI pattern was still worth copying directly). The actual mechanism: a
  `canUseTool` branch (`isEsputnikWriteTool` in `sdk-session.ts`) pauses on
  `PermissionGate.request()`, which sends a real Telegram inline-keyboard
  message and awaits a promise the operator resolves later via `/control`'s
  `permission_decision` action — routed through the operator specifically
  because only it ever calls `getUpdates` (every pod shares the same bot
  token but only the operator polls for updates), so a button tap always
  lands there first regardless of which pod asked.
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
- **`/compact`/`/clear` must be the *bare* command text, nothing else in the
  message.** Confirmed live 2026-08-23: pushing exactly `/compact` or
  `/clear` onto the SDK stream produces a real `compact_boundary`/
  `conversation_reset` protocol message — but a normal `ChatTurn` always gets
  `${fromHandle}: ${text}` prefixed by `buildPrompt` (`sdk-session.ts`), and
  that prefix is exactly what breaks it: the model sees "Andrii Pavlenko:
  /compact" and answers it as a question instead of the SDK ever recognizing
  the command (this shipped once, broke in production, and was only caught
  because the person tried it live). Fixed via a dedicated `ControlTurn` kind
  (`shared/types.ts`) that carries the bare text through the same `/turn`
  delivery path (journal dedup, busy/retry) without the prefix — don't route
  either command through `enqueueChatMessage`.
- **The `claude` CLI forces visible output on every turn — true silence
  isn't achievable, so "say nothing" has to be app-enforced.** Confirmed
  live 2026-08-24 (found by grepping the compiled `claude` binary, not
  anything in this repo or the SDK): whenever a turn ends with no visible
  text, the CLI itself hardcodes an injected nudge — "Your previous response
  had no visible output. Please continue and produce a user-visible
  response." — forcing the model to say *something*. This bit a scheduled
  cron check-in (a task-kind turn with nothing new to report): the model's
  attempt at silence got overridden into a message that announced it was
  staying silent while, contradictorily, sending exactly that as the
  message. Since the model can never truly produce zero output, `buildPrompt`
  (`sdk-session.ts`) instead gives task-kind turns a real, satisfiable
  escape hatch — reply with exactly `NO_UPDATE_MARKER` ("NO_UPDATE") and
  nothing else when there's nothing worth reporting — and `index.ts`'s
  `handleTurn` recognizes that exact reply and swallows it before
  `sendTelegramReply`, never delivering it. Still logged via the normal
  per-message SDK log either way (`task_no_update`/`chat_no_update` line), so
  nothing about a "silent" turn is actually invisible — only the Telegram
  delivery is suppressed. Same "app-enforced, not SDK-trusted" shape as the
  context limit above. Generalized 2026-08-26 to chat turns too (a
  `react_to_message`/`send_sticker` call can be a turn's whole response, and
  without this the model duplicated itself — sticker *and* a text echo of
  the same emoji — just to satisfy the CLI's constraint), and `resolveReplyText`
  is now also what `session-controller.ts`'s `reactToTaskNotification`
  routes through (via a synthesized `TaskTurn`) instead of delivering its
  reply unconditionally — that path originally had no `NO_UPDATE` support at
  all, and leaked raw "no update needed" reasoning straight to Telegram in
  English mid-Ukrainian-conversation before the fix (incident:
  `~/task-notification-no-update-bug.md`).
- **A resumed session does NOT pick up a persona/CLAUDE.md edit on its
  own.** Confirmed against the installed SDK's own `sdk.d.ts`: the only
  CLAUDE.md-reload primitive found (`SDKControlRegisterRepoRootRequest`'s
  `reload_claude_md`) is scoped to a directory registered under `cwd`, which
  the persona file (`claudeHome`, i.e. `~/.claude/CLAUDE.md`) isn't — there's
  no general "reload my system-level CLAUDE.md" call. Confirmed live
  2026-08-26: a person's session, resumed across a routine pod restart
  (`resume: sessionId`), kept describing pre-update behavior as current well
  after a persona edit had landed on disk — the model's context was
  established once, at the session's true first-ever turn, and a plain
  restart for a new image doesn't re-inject a fresh read the way a genuinely
  new session naturally gets one. Fixed via `sdk-session.ts`'s
  `personaChangedSinceLastAck` (hashes the freshly-installed CLAUDE.md
  against a hash persisted on the same NFS mount, so it only fires on a real
  change, once) plus `session-controller.ts`'s `nudgePersonaRefresh` (a
  one-shot, internal-only push telling the model to `Read` its own
  `~/.claude/CLAUDE.md` — `Read` is always a fresh disk read regardless of
  whatever the SDK's own resume/system-prompt behavior is, so this doesn't
  depend on an unconfirmed SDK guarantee). `index.ts`'s `main()` calls this
  once at boot, only when both the hash changed *and* this boot is resuming
  a real prior session (checked via `readSavedSessionId` before
  `installPersonaFiles` overwrites the file) — a brand new session needs no
  nudge, it reads CLAUDE.md naturally at its first turn.
- **Shared skills: one `SKILL-<name>.md` ConfigMap key per skill, not
  hardcoded to `media`.** `runner/index.ts`'s `installPersonaFiles` installs
  every `SKILL-<name>.md` key in the persona ConfigMap as
  `.claude/skills/<name>/SKILL.md` for every person (`media`, `esputnik-query`,
  and `esputnik-trigger-monitor`, as of 2026-08-29). `/skills`/`/forget_skill`
  need to know which names are shared (unremovable) vs. person-authored —
  `operator/nfs.ts`'s `getSharedSkillNames` derives that set **live from the
  ConfigMap's own keys** (`api.readNamespacedConfigMap` + a `SKILL-(.+)\.md`
  regex over `data`), not a hardcoded list. This was a hardcoded `Set`
  originally; changed 2026-08-29 specifically because a hardcoded list means
  every new shared skill needs an operator *code change and image rebuild*
  just to be recognized as shared, on top of the actual content change (a
  ConfigMap/Helm edit alone is already enough for `installPersonaFiles` to
  install it everywhere) — pure overhead for zero benefit. `listPersonSkills`/
  `deletePersonSkill` still take the resulting `Set` as a plain argument
  rather than fetching it themselves, so those two stay pure-filesystem and
  directly unit-tested (per the testing convention above) with no k8s
  mocking; only `getSharedSkillNames` itself touches the k8s API. Adding a
  new shared skill is now a ConfigMap/Helm-only change — no code, no
  rebuild — though per the eSputnik gotcha above it's only actually usable
  per-person once that person runs `/esputnik_connect` themselves; installing
  the file everywhere doesn't imply everyone has a working connection to use
  it with.
- **The Claude Code CLI's `mcpOAuth` credential store only recognizes a
  `<serverName>|<hash>`-keyed entry, never a bare `<serverName>` key.**
  Confirmed live 2026-08-29 building self-service eSputnik MCP OAuth
  (`/esputnik_connect`, `operator/esputnik-oauth.ts`): a hand-written
  `.credentials.json` entry under the bare server name was silently
  ignored — the CLI, finding no matching `|`-suffixed key, bootstrapped its
  *own* fresh OAuth client instead (a real `POST /register` DCR call, plus
  a stub entry with an empty `accessToken` under its own self-chosen key,
  using its default `http://localhost:3118/callback` redirect). That
  redirect can never complete in a headless pod, so the connection just sat
  broken — two unrelated entries coexisting in the file, neither usable.
  The `<hash>` suffix itself doesn't need deriving: it was observed
  identical (`909f472c1d8ca133`) across two totally independent cases (this
  project's own dev-machine session, serverName `esputnik`; the SDK's own
  self-generated stub on a live person pod, serverName `esputnik-fatline`,
  a different self-registered clientId) that shared only one thing —
  `serverUrl: https://mcp.esputnik.com`. It's a pure function of the URL,
  not of name or client, so `operator/nfs.ts`'s `writeEsputnikCredential`
  just hardcodes that one observed value rather than reverse-engineering
  the actual hash algorithm. If eSputnik's MCP URL ever changes, or another
  OAuth-based MCP server gets added, the same value can't be assumed — it'd
  need rediscovering the same way (write a token under the bare name first,
  let the SDK generate its own broken stub, read back the key it chose).
- **eSputnik's analytics MCP tools (`get_messaging_analytics`,
  `get_events_analytics`) return one aggregate row per date range, never a
  time series.** Confirmed live 2026-08-29 building a trigger-email
  flatline monitor: there is no per-day bucketing param on either tool, and
  the returned CSV has no date column — comparing "baseline" vs "recent"
  requires two separate calls with two different `date_from`/`date_to`
  windows (max span 185 days each), not one call with a granularity
  argument. Both tools return a manifest with a signed `artifacts[].downloadUrl`
  (short-lived, ~5 min) rather than inline data — fetch it immediately
  (e.g. via `WebFetch`), don't stash the URL. `message_ids`/`workflow_ids`/
  `event_type_ids` are real server-side filters on these two tools, but the
  generic `query` object accepted by `list_workflows`/`list_broadcasts`/
  `list_email_messages` is **not** — confirmed live it returns identical
  full results regardless of what's passed, so filter those lists
  client-side instead. `get_workflow_export(workflow_id)` returns
  `startConfig` inline (no need to download the full RawJson graph just to
  find what starts a workflow), and `startConfig.trigger` is not always
  `"BY_EVENT"` — a `"REGULAR"` value means a cron/schedule-driven batch
  campaign (a `regularTrigger`), which can legitimately run in bursts (e.g.
  a monthly blast active ~8 days a month, silent the rest) and must be
  excluded from any naive baseline-vs-recent volume-drop check, or it reads
  as a false-positive failure. `get_event_types` carries its own `inactive`
  flag per event type — a stronger, definitive root-cause signal than
  inferring "event stopped" from volume alone.

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
same shape as the memory work, no ConfigMap involved). **Shared** skills are
now a generalized, N-skill mechanism (one `SKILL-<name>.md` ConfigMap key
each) rather than hardcoded to `media` alone — `esputnik-query` (read-only
eSputnik REST queries, added 2026-08-23), `esputnik-trigger-monitor`
(scheduled trigger-campaign flatline detection via the OAuth MCP analytics
tools, added 2026-08-29), and `esputnik-multilang-campaign` (builds
translated per-country email drafts — correct language codes, per-locale
product names/footers/prices resolved from each market's own storefront
rather than translated freehand, always a saved draft, never auto-sent;
added 2026-09-02, the first **write-capable** shared skill) are the second,
third, and fourth. Session
management is now person-facing too: `/context` (live token-usage snapshot),
`/effort` (session-scoped effort level), `/context_limit` (app-enforced
auto-compact ceiling, default 250,000 — the SDK's own internal ceiling scales
with the model's window and isn't a usable budget), `/compact`, `/clear` —
all live control-plane operations against the person's already-running
session, not turns handled by the model. A full security review of
credential handling, the attachment path allowlist, MCP tool surface, and
NFS isolation has been done once; not a recurring process yet.

**Telegram permission gate for eSputnik writes** (added 2026-09-02): a real
Allow-once/Always-allow/Deny prompt, since `esputnikToolPolicy()`'s
per-server `always_allow` never actually gated anything (see "eSputnik
OAuth MCP tools" gotcha below) — until this, the only thing standing
between the model and a real `create_email_message`/`send_broadcast`/etc.
call was prompt-text discipline. `/permissions`/`/forget_permission` give
the person visibility into and control over standing "always allow"
grants, same shape as `/skills`/`/forget_skill`. This existed specifically
to unblock `esputnik-multilang-campaign` (added 2026-09-02, same day —
see "Current status" above), which needed a real gate to sit behind before
shipping; confirmed the gate's existing `ESPUTNIK_WRITE_TOOL_NAMES` set
already covered every write tool that skill needs with no further code
changes required.
