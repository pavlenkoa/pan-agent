# pan-agent — status

## Done

Implemented the approved architecture plan
(`~/.claude/plans/prompt-design-a-frolicking-hennessy.md`) end to end:
operator + runner in TypeScript, plus the homelab deploy manifests.
**`pan-agent` is live and deployed** on the homelab cluster (namespace
`pan-agent`, ArgoCD-managed, `Healthy`) — two people (`andrii`,
`andrii-pavlenko`) auto-approved via @shanovnybot and actively running.

### `~/git/pan-agent` (this repo)

- **`src/shared/`** — `/turn` and `/tasks` API contracts (`types.ts`),
  structured one-JSON-line stdout logger (`log.ts`), tiny JSON HTTP helpers.
- **`src/operator/`**
  - `k8s.ts` — thin `@kubernetes/client-node` wrapper: Pod CRUD, ConfigMap
    JSON read/create/replace with optimistic-concurrency retry.
  - `people-index.ts` / `person-state.ts` — `pan-agent-people` and
    `pan-agent-person-<slug>` ConfigMap schemas + mutators.
  - `pod-template.ts` / `pod-lifecycle.ts` — per-person Pod spec, create/wait-ready/recreate.
  - `nfs.ts` — mkdir per-person NFS homes (operator mounts the NFS root itself).
  - `telegram.ts` — `getUpdates` long-poll (single consumer) + `sendMessage`.
  - `router.ts` / `admin-commands.ts` — known/pending/denied routing, unknown-sender
    bootstrap flow, `/approve /deny /people /restart`.
  - `delivery.ts` — POST `/turn` with retry-on-409/unreachable; chat messages
    that arrive during a retry get merged into the next attempt (real batching,
    not just "don't lose messages").
  - `cron.ts` — cron → next-fire (IANA tz via `cron-parser`), drift-free
    recurrence, catch-up-window skip logic.
  - `sweep.ts` — 60s task sweep wired to `delivery.ts`.
  - `tasks-api.ts` — HTTP API the runner's MCP tools call.
  - `reconcile.ts` / `index.ts` — boot reconcile (index vs. live pods diff) + entrypoint.
- **`src/runner/`**
  - `journal.ts` — NFS-backed idempotency ledger, keyed by `updateId` or
    `(taskId, scheduledFor)`.
  - `sdk-session.ts` — one Claude Agent SDK `query()` per turn, session-id
    persisted to a file for `resume` across restarts, full message stream to
    stdout logger.
  - `scheduling-tools.ts` — `schedule_task`/`list_tasks`/`cancel_task` as
    in-process MCP tools calling the operator's `/tasks` API.
  - `telegram-send.ts` — direct `sendMessage`, chunked at Telegram's 4096-char limit.
  - `index.ts` — `/turn` (409 while busy) + `/healthz`, git identity bootstrap.
- **Tests** (29, all passing): journal dedup incl. crash-mid-turn retry and
  task-tuple dedup; drift-free cron + catch-up window; batching-under-retry;
  slug generation edge cases; `/tasks` API authorization.
- **`Dockerfile`** — multi-stage, extends `node:24-bookworm-slim` with
  `claude` CLI, `gh`, `bun`, media tooling. Verified with an actual
  `podman build` + container smoke test (server boots, `/healthz` OK,
  `claude`/`gh`/`bun` present).
- **`.github/workflows/build.yaml`** — test → typecheck → multi-arch build/push
  to `ghcr.io/pavlenkoa/pan-agent`.
- **`README.md`** — dev commands, config env vars, condensed deploy sequence.

### `~/git/pan-agent/helm/pan-agent` (chart, committed + pushed)

- All the k8s manifests (`rbac.yaml`, `operator-deployment.yaml` + Service,
  `networkpolicy.yaml`, `external-secrets.yaml`, `pv.yaml`,
  `configmap-persona.yaml`) moved here as a proper Helm chart — this repo has
  its own tests/CI/Dockerfile, same shape as `vault-secrets-generator`, so it
  gets its own chart too rather than duplicating manifests into `homelab`
  (`directory: {}`, the pattern for thin wrapper apps like `claude-code`).
  `helm lint` clean; `helm template` diffed byte-for-byte identical against
  the raw manifests it replaced before they were deleted.
- Values split: chart `values.yaml` has generic defaults, homelab-specific
  bits (node, NFS server, network CIDRs, image tag) live in
  `homelab`'s `kubernetes/apps/pan-agent/values/homelab.yaml`.

### `~/git/homelab` (pushed, ArgoCD-synced)

- `kubernetes/apps/pan-agent/values/homelab.yaml`: node/NFS/network/image
  overrides for the chart above.
- `kubernetes/app-of-apps/values.yaml`: `pan-agent` uses
  `repository:`/`path: helm/pan-agent` (multi-source Application pulling the
  chart from the `pan-agent` repo + values from `homelab`), same shape as
  `vault-secrets-generator`. `pan-agent`'s repo URL added to the
  `applications` parent's `sourceRepos`.

### Post-launch security fix

Found via a code review requested right after the first successful message
round-trip: the operator's `/tasks` API (`schedule_task`/`list_tasks`/
`cancel_task`) trusted a client-supplied `slug` with no check that the caller
was that person's own pod — since every person's Bash tool can reach the
shared API, any onboarded person could inject a recurring prompt into
*another* person's pod (or read/cancel their tasks). Fixed: each person gets
a random `tasksToken` at approval time (`PersonIndexEntry.tasksToken`),
injected into their pod as `PERSON_TASKS_TOKEN`, required as `Authorization:
Bearer` on every `/tasks` call and checked with `timingSafeEqual`
(`tasks-api.ts`). Boot reconcile backfills tokens + recreates pods for
anyone approved before this existed. Verified live: a cross-slug call from
`person-andrii` claiming to be `andrii-pavlenko` got `403 unauthorized`; a
call for its own slug succeeded normally.

## To do

### Done during first deploy
- [x] Both repos committed and pushed; `pan-agent` CI builds/pushes
      `ghcr.io/pavlenkoa/pan-agent:latest` on every push.
- [x] `claude_oauth_token` in `kv/anthropic`; `telegram_bot_pan_agent_token`,
      `telegram_admin_id` (333141234), `telegram_allowed_ids`
      (`["333141234","7760060740","41133035"]`) in `kv/telegram`.
      `TELEGRAM_ALLOWED_IDS` support added: unknown senders in that list skip
      pending/approve and get provisioned immediately
      (`src/operator/provisioning.ts`).
- [x] pan-agent has its own bot, **@shanovnybot** ("Пан Агент") — runs
      independently of `claude-code`'s bot, no scale-down needed.
- [x] NFS dirs created on the Pi; ArgoCD synced `pan-agent`
      (namespace/RBAC/CNPs/ExternalSecrets/Deployment all `Healthy`).
- [x] Fixed a Cilium egress bug found on first boot (operator dialed
      `kubernetes.default.svc`'s ClusterIP, policy only allowed the node's
      `:6443` — switched to the `kube-apiserver` entity).
- [x] First message round-trip end to end confirmed working
      (@shanovnybot → auto-approve → pod → reply).
- [x] Found + fixed the `/tasks` API authorization gap (see above).

### Still to do
- [ ] Pin `PERSON_POD_IMAGE` / the operator's own image to a real digest in
      homelab's `values/homelab.yaml` (still tracking `:latest` — Renovate
      takes over once pinned).
- [ ] Decide whether to migrate `~/.claude`/workspace history from
      `/media/claude-code` and tracking data from `/media/openclaw`, or keep
      pan-agent fresh (claude-code keeps running independently either way).
- [ ] Verify Grafana/Loki picks up the stdout JSON lines with the expected
      fields (`{namespace="pan-agent"} | json`).
- [ ] Run the four validation milestones from the architecture doc: operator
      restart amnesia, duplicate-turn (journal dedup), task double-fire
      (catch-up window), node-reboot recovery.
- [ ] Third person end to end (the remaining allowlisted ID, 41133035,
      hasn't messaged yet) to further confirm isolation.
- [ ] Migrate legacy crons: ask the assistant to read `/tracking/CRON.md` once
      and recreate them via `schedule_task`, then delete `CRON.md`.

### Not done / explicitly deferred (per the architecture doc's non-goals)
- No credential broker (shared OAuth + bot token, direct pod access) — noted
  as a clean future increment, not started.
- No channels beyond Telegram, no group chats, no idle teardown, no
  horizontal scale — all intentionally out of scope for v1.

### Session 2026-08-23: backgrounded-bash dead end + Telegram attachments

Found via a real conversation transcript: the model backgrounded a `sleep && check`
Bash command intending to follow up once it finished, but the follow-up never
arrived — root cause is architectural, not a bug in that one turn. This runner
does one `query()` per `/turn`; when the model stops calling tools and gives its
final answer, the whole SDK session process tears down, killing any backgrounded
command and losing whatever notification would have reported it done. The SDK's
own async-continuation machinery (background bash, Monitor, CronCreate,
ScheduleWakeup) all assume a long-lived interactive session this architecture
doesn't have — `schedule_task` is the only thing here that actually survives
past a turn boundary.

Fixed two ways:
- `sdk-session.ts` now passes a `canUseTool` that denies any `Bash` call with
  `run_in_background: true`, with a message telling the model to run it in
  the foreground (up to Bash's 10min timeout) or use `schedule_task` instead
  — turns a silent black hole into a live, self-correcting error.
- Persona (`configmap-persona.yaml`) now states this explicitly: no
  backgrounded waiting, no "I'll get back to you in a minute" unless it's
  actually a synchronous foreground wait within the same turn.

Also closed the attachments gap (previously: incoming photos/files were
silently dropped as empty-text turns; the bot had no way to send a file back
at all — both confirmed missing by reading the code, not just reported).
- **Receiving:** `operator/telegram.ts` + `router.ts` now parse `photo`/
  `document`/`caption` off inbound Telegram messages into
  `ChatMessage.attachments` (`shared/types.ts`). The runner downloads these
  itself with its own `TELEGRAM_BOT_TOKEN` (`runner/attachments.ts`) — no
  operator-side file handling needed, only the small `file_id` crosses the
  `/turn` HTTP call. Photos go in as real inline vision content (SDK
  streaming-input form, one `SDKUserMessage` with text + image blocks);
  documents get saved under `workspace/inbox/` and referenced by path for
  Bash/Read to pick up.
- **Sending:** new `send_file` MCP tool (`runner/attachment-tools.ts`,
  `telegram-send.ts`'s `sendTelegramDocument`/`sendTelegramPhoto`) lets the
  model send a local file back — restricted to paths under the workspace,
  `/media`, or `/tracking`; enforces Telegram's 50MB bot-upload cap with a
  clear error instead of a silent failure.

Typecheck clean, all 29 existing tests still pass (no test coverage added for
`sdk-session.ts`/`attachments.ts` — consistent with the existing pattern of
not unit-testing the SDK-wrapping/glue modules).

Committed, pushed, CI built + pushed the image, and both live person pods
(`andrii`, `andrii-pavlenko`) were recreated via an operator restart
(`kubectl rollout restart deployment/pan-agent-operator` → boot reconcile
recreates any active person missing a pod) to pick it up. Confirmed
`Running 1/1` on the new image with clean boot logs.

**Not yet done:**
- [x] Attachment round-trip live-verified: sent a photo, asked the bot to
      describe it — described correctly. Sent files back (`send_file`)
      including a multi-file album (see the 2026-08-23 "multi-file sends"
      session below) — confirmed working live.
- [ ] Documents/images arriving via `document` (not `photo`) never get vision
      treatment even if they're actually images — only Telegram's `photo`
      field does. Fine for now; `Read` can still open an image file from
      disk if the model thinks to.

### Session 2026-08-23 (cont.): poll-loop hardening

Prompted by noticing upstream's official telegram plugin had a bug (fixed in
their commit 7e401ed) where `bot.start()`'s catch block only retried on 409
Conflict — any other transient error (ETIMEDOUT/ECONNRESET/DNS) rejected it
once and polling died permanently while the process stayed alive (deaf to
inbound, but outbound tools kept working since the MCP process itself didn't
exit) — indistinguishable from an unrelated harness bug.

Checked `operator/telegram.ts`'s `pollUpdates`: its own `getUpdates` retry
already covers *every* error, not just 409 (flat 5s backoff, loops until
aborted) — so the exact upstream bug doesn't apply here. But tracing further
found a related gap one layer in: `onUpdate` (i.e. `routeUpdate` and
everything it calls — k8s ConfigMap writes like `markUpdateDelivered`,
`touchLastSeen`, `recordPending`) was never guaranteed not to throw, despite
`pollUpdates`' own doc comment claiming it must resolve. `updateJsonConfigMap`
(`operator/k8s.ts`) only retries on a 409 resourceVersion conflict — any other
k8s API error (network blip, API server hiccup) propagates immediately,
uncaught, out through `routeUpdate` → `pollUpdates`' for-loop → `main()`'s
top-level `.catch` → `process.exit(1)`.

Unlike upstream's failure mode (silently deaf forever), ours would crash the
whole operator process — k8s `restartPolicy: Always` brings it back, so this
is self-healing rather than permanently dead, but with a worse edge case: no
offset is ever persisted (by design — Telegram is the durable buffer), so a
restart re-polls the exact same update that just crashed it. A single
"poison" update (one that reliably fails some downstream write) would
crash-loop forever on itself, never advancing.

Fix: `pollUpdates` now wraps `await onUpdate(update)` in its own try/catch,
logging (`update_handling_failed`) and moving on — offset still advances past
a throwing update, restoring the doc comment's stated invariant by construction
instead of just assuming callers uphold it. `lastDeliveredUpdateId` (the field
`markUpdateDelivered` writes) is bookkeeping only — grepped, nothing reads it,
so skipping a failed write there on error is safe. Added
`operator/telegram.test.ts` covering that a throwing `onUpdate` doesn't stop
the loop and the offset still advances past it. Typecheck clean, 30/30 tests
pass (29 previous + 1 new).

### Loose ends worth a look
- [ ] `operator-deployment.yaml` `strategy: Recreate` means a brief window on
      every operator rollout where nobody is polling Telegram — acceptable
      (Telegram buffers 24h) but worth confirming in practice.
- [ ] No deprovision/offboarding admin command exists yet (only
      approve/deny/people/restart) — fine per v1 scope, but if someone needs
      removing, it's a manual `kubectl delete pod` + ConfigMap edit today.
- [ ] Sweep's per-person `catchUpWindowMs` and pod-ready timeouts are global
      config, not per-person — fine at "handful of people" scale.

### Session 2026-08-23 (cont.): the actual CronCreate root cause

Live-tested the earlier canUseTool-based background-bash fix by asking the
bot to schedule a native-CronCreate test message — third time in a row it
"fired" (disappeared from CronList) with no message ever arriving. Pulled
runner pod logs from the exact turn and found the real bug, and it's bigger
than the Bash-backgrounding case alone:

`allowedTools` was never a restriction on which tools exist — its own doc
comment says so ("to restrict which tools are available, use the `tools`
option instead"), and the SDK prints this outright at boot:
`[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked for:
Bash, ... Bare allowedTools entries auto-approve the whole tool before the
callback is consulted.` Two consequences, both live-confirmed from pod logs:
1. The model had the SDK's entire native built-in toolset available the
   whole time — CronCreate, CronList, CronDelete, ScheduleWakeup, Monitor,
   TaskCreate/Output/Stop, Artifact, etc. — regardless of the restrictive-
   looking `allowedTools` array, because that array only skips the
   permission prompt for the tools it names; it doesn't hide anything else.
   The model called `CronCreate` directly (`{"cron":"4 14 23 8 *",
   "recurring":false,...}`), completely bypassing `schedule_task` despite
   the persona explicitly forbidding it — CronCreate isn't wired to this
   runner's Telegram delivery at all, so the "fire" was real but nothing
   ever sent the message.
2. Because `Bash` was itself a bare `allowedTools` entry, my earlier
   `canUseTool` denial of `run_in_background:true` never actually fired
   either — same shadowing bug, different tool.

Fix (`runner/sdk-session.ts`): added `tools: BUILTIN_TOOLS` (`Bash`, `Read`,
`Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`) — this is the real
allowlist; everything else built-in is now genuinely unavailable, not just
persona-discouraged. Also removed `Bash` from the bare `allowedTools` list
(kept in `tools` so it's still available) so it actually falls through to
`canUseTool` — the backgrounded-bash denial should now really take effect.
Typecheck clean, 30/30 tests pass, build clean.

**Not yet verified live:** this fix isn't deployed yet. Once it is, re-run
the same test (ask for a native "cron" / background reminder) and confirm
the model can no longer reach CronCreate at all, and that backgrounded Bash
now gets denied with the explanatory message instead of silently succeeding.

### Session 2026-08-23 (cont.): persistent per-person sessions — background Bash for real

Pushback on the previous entry's fix: denying `run_in_background` outright
kills a real feature instead of making it work. Investigated whether it
*can* work — read the actual `CronCreate` tool spec (confirmed it's an
in-memory, session-only timer inside the `claude` CLI subprocess itself,
non-durable, 7-day hard expiry — genuinely unfixable here regardless of
architecture, stays excluded permanently) and the official
`anthropics/claude-plugins-official` Telegram plugin's source (it works
because it bridges Telegram into one continuously-running interactive
`claude` session on someone's own machine — a fundamentally different,
single-tenant deployment model we can't copy directly, but confirms the
underlying requirement: the subprocess has to actually stay alive for any
of this to work) — then fetched and read `nanocoai/nanoclaw`'s real,
production `container/agent-runner` source (`providers/claude.ts` +
`poll-loop.ts`) as prior art for doing this at the Agent SDK level
specifically. Full design written up and approved as a plan
(`~/.claude/plans/piped-churning-charm.md`) before implementing — this was a
genuine architecture change to a live bot with two active users, not a
config tweak.

**What changed:** the runner now keeps **one persistent `query()` session
per person pod** for the pod's whole lifetime, instead of spinning up a
fresh one per `/turn`. Backgrounded Bash (`run_in_background`) is no longer
denied — its `task_notification` now lands on this same long-lived stream
and can trigger a genuine proactive Telegram message, even well after the
turn that started it already replied.

- **`src/runner/pushable-queue.ts`** (new) — minimal push-based async queue,
  feeds the SDK's streaming-input `prompt` and the task-notification
  reaction FIFO. Functionally the same shape as nanoclaw's own
  `MessageStream` class — good independent confirmation this is the right
  primitive, not over-engineering.
- **`src/runner/session-controller.ts`** (new) — the core of the change.
  Owns the persistent `Query`, a background read loop that never stops for
  the controller's lifetime, and a single-flight `currentJob` slot: only one
  pushed message is ever outstanding waiting for its `result` at a time, so
  "the next `result` is the answer to what was just pushed" needs no
  correlation id. Deliberately does *not* use the SDK's `priority`/
  `shouldQuery` fields or `Query.streamInput()` — both are present in the
  types with zero documentation of their exact ordering semantics, not
  something to gamble a live system on. A `task_notification` arriving
  while a turn is in flight queues in a small FIFO and runs right after
  that turn resolves, through the exact same path — sends proactively via
  `sendTelegramReply` since there's no HTTP request waiting on it.
  Crash handling adopts nanoclaw's own validated pattern instead of a
  hand-rolled indefinite supervisor: the session id is now persisted the
  moment it's first seen (on the `init` message), not batched to end-of-turn
  — a crash between those two would otherwise orphan the session, a real bug
  nanoclaw's own code comments describe hitting. A stream crash rejects any
  in-flight job (never hangs it), drops queued reactions with a log line,
  and retries in-process a small bounded number of times (1s/2s/4s backoff)
  before calling `process.exit(1)` and letting k8s's `restartPolicy: Always`
  bring up a fresh container — simpler and more robust than an indefinite
  in-process retry loop, and matches nanoclaw's own
  `MAILBOX_FAILURE_STREAK_EXIT` → `process.exit` choice.
- **`src/runner/sdk-session.ts`** — reduced to pure helpers
  (`buildPrompt`/`buildUserMessage`/`buildQueryOptions`/`logSdkMessage`/
  `summarizeUsage`/session-id read-write) that `session-controller.ts`
  calls; `runTurn()` and `denyBackgroundedBash` are gone, superseded by the
  controller. `tools: BUILTIN_TOOLS` (still excluding `CronCreate` and
  friends) is unchanged and still correct under the new architecture — that
  part of the previous fix was right, it's just that denying backgrounded
  Bash specifically was the wrong call once persistent sessions make it
  actually work.
- **`src/runner/index.ts`** — deviated from the approved plan on one point,
  for a correctness reason found during implementation: the plan said to
  replace the local `busy` flag with `controller.isBusy()` for the
  `/turn` gate, but `isBusy()` only flips true once `submitTurn` actually
  reaches the point of pushing a message — which is *after* async body-
  parsing and journal-lookup work. Two `/turn` requests racing in before
  either finishes that async work could both pass an `isBusy()` check and
  both call `submitTurn`, breaking the single-flight invariant. Kept the
  local `busy` boolean (set synchronously, before any `await`, exactly like
  today) as the actual HTTP-level gate; `controller.isBusy()` remains useful
  for introspection/tests but isn't what index.ts relies on for
  correctness. Documented inline in the file's header comment.
- **`helm/pan-agent/templates/configmap-persona.yaml`** — rewrote the
  "no backgrounded waiting" section to say the opposite of what it said an
  hour earlier: background Bash now genuinely works for the pod's uptime,
  with the same "stay silent unless actionable" convention already used for
  scheduled tasks. Tightened the CronCreate-forbidden language to say it's
  not just discouraged but literally absent from the toolset.

Typecheck clean, build clean, all previous tests + 11 new ones pass (`npm
test` run 5x in a row with no flakes after fixing one real flaky-test bug
during development — a fake test harness's async generator wasn't
`.close()`-able, unrelated to production code; see `pushable-queue.test.ts`
and `session-controller.test.ts`, the latter injects a fake `queryFn` since
this is genuinely new concurrency-control logic with no prior coverage,
unlike the old `runTurn` which was a thin pass-through to the live SDK).

**Not yet done:**
- [x] Deployed and live-verified: asked for a background check ("check
      torrent peers in a minute and tell me") and a proactive Telegram
      message arrived on its own, without another message from the user —
      confirmed working as designed.
- [ ] Haven't exercised the crash-and-restart path against the real SDK,
      only against fake `queryFn`s in tests — worth watching
      `session_crashed`/`session_restart_attempt`/`session_restart_exhausted`
      in Loki for the first while after deploy.
- [ ] Memory/resource cost of a continuously-alive `claude` subprocess per
      pod (vs. the old per-turn-ephemeral one) hasn't been measured — pod
      limits are currently 512Mi request / 2Gi limit; worth a look at actual
      usage after this has been live a while, at only 2 active people this
      is very unlikely to matter yet.
- [ ] Haven't specifically re-confirmed `CronCreate` is unreachable since the
      persistent-session redeploy (it was confirmed excluded by the `tools`
      allowlist before this change, and that allowlist is unchanged, so this
      is a low-risk gap — just hasn't been re-tested live after the rewrite).

### Session 2026-08-23 (cont.): multi-file sends

Live-reported: asked the bot to send two already-downloaded .torrent files
in one message — `send_file` only took one path at a time, so the model
zipped both into an archive as a workaround and sent that instead of an
actual two-file message. Telegram supports this natively (`sendMediaGroup`,
2-10 items grouped into one album-style message) and we'd just never wired
it up.

- `runner/telegram-send.ts`: new `sendTelegramMediaGroup` — multipart
  `media` JSON array of `attach://fileN` refs, one Blob per file, caption
  only on the first item (Telegram's own restriction).
- `runner/attachment-tools.ts`: `send_file`'s schema changed from a single
  `path` to `paths: string[]` (1-10). One path keeps the exact old
  single-file behavior (`sendDocument`/`sendPhoto`); 2+ paths validates and
  reads every file up front (so an album never goes out half-sent on a
  mid-batch failure) and sends them as one `sendMediaGroup` call.
- Persona: added a line telling the model to pass multiple paths in one
  call instead of zipping as a workaround.

Typecheck, build, and all 41 existing tests still pass — no new tests added
for the multipart-construction logic, matching this file's existing
pattern of not unit-testing the thin Telegram-API-wrapper functions
(`sendTelegramDocument`/`sendTelegramPhoto` were never tested either).

Deployed and live-verified: asked for two files again, both arrived
grouped in one Telegram album message instead of a zip.

### Session 2026-08-23 (cont.): full-system security audit

Manual pass (not the diff-based `/security-review` — branch was clean) over
the whole repo, covering exactly the four areas the backlog item below asked
for. Findings written up and handed to the user as a report; nothing fixed
in-repo as a result of this pass alone (see the follow-up feature session
right below, which touches some of the same files for an unrelated reason).

- **Confirmed solid, no issues:** `/tasks` API cross-slug auth
  (`timingSafeEqual`-checked per-slug bearer token), `send_file`'s path
  allowlist (proper prefix-with-separator check, no traversal bypass),
  inbound-attachment filename sanitization, slug generation (no injection
  path from a crafted Telegram display name into ConfigMap/pod names or NFS
  paths), admin-command gating, CI (pinned action SHAs, scoped
  `GITHUB_TOKEN`). `/tracking` is one NFS mount shared across every person's
  pod — confirmed intentional (persona docs it as shared household
  torrent/subscription tracking), not an isolation bug.
- **Medium-High, credential exposure:** every person pod holds *all* shared
  service credentials as plaintext env vars, with zero `canUseTool` gating
  (confirmed none exists anywhere in current runner source) and unrestricted
  `0.0.0.0/0` internet egress. This is the known "no credential broker"
  non-goal, but the concrete mechanism — a successful prompt injection via
  `WebFetch`/tracker content could `curl` any of the seven credentials to an
  attacker host with nothing in the stack to catch it — hadn't been spelled
  out this precisely before. Still an open, accepted tradeoff.
- **Medium, contingent on `GH_TOKEN` scope (can't see it from this repo):**
  CI auto-builds+pushes `:latest` on every push to `main` with no required
  review, and that one image runs for every tenant. If `GH_TOKEN` (handed to
  every pod) has write access to this repo, one compromised/malicious
  approved person could push a backdoored commit that gets built and
  deployed to everyone. Worth confirming the token's actual scope.
- **Low, defense-in-depth only:** the runner's `POST /turn` has no
  application-layer auth at all — it's protected entirely by the
  CiliumNetworkPolicy restricting ingress to the operator's pod label. No
  path was found for a person's pod to forge that identity (no
  `automountServiceAccountToken` override, no RBAC binding on the `default`
  ServiceAccount found anywhere in homelab), so not concretely exploitable
  today, but it's a single-layer control with no app-level backup (unlike
  `/tasks`, which correctly has both).

### Session 2026-08-23 (cont.): per-person persistent custom env vars (`/set-var`)

Feature request straight out of the audit above: a way for an individual
person to add their own credential (e.g. a personal API token) that survives
pod restarts, is a real env var visible to their own Bash/tool calls, and is
scoped to only their own pod — without needing a Vault/chart change per
variable. Planned and approved before implementing (multi-file, touches the
pod-spec/lifecycle/persona pipeline).

Design (all self-service — every approved person manages only their own
pod, no admin gating):
- `/set-var KEY=VALUE [description]`, `/list-vars`, `/unset-var KEY` are
  intercepted by the operator's router (`router.ts`, new
  `operator/person-commands.ts`) **before** the message becomes a turn — the
  value never enters the model's conversation, turn logs, or Loki's
  assistant-turn logging. Key format + a `RESERVED_ENV_NAMES` check
  (`pod-template.ts`, single source of truth for the names the operator
  already injects) reject anything that would shadow a system credential.
- Storage: `PersonState.customEnv` (new field on the existing
  `pan-agent-person-<slug>` ConfigMap, same mechanism `tasksToken` already
  uses) — `setCustomEnvVar`/`removeCustomEnvVar` in `person-state.ts`, built
  on the existing `mutatePersonState`. Added `normalizePersonState()` so the
  two already-live ConfigMaps (created before this field existed) backfill
  `customEnv: {}` on read instead of crashing.
- Apply mechanism: `/set-var`/`/unset-var` call the existing `recreatePod`
  (same one admin's `/restart` already uses) — `pod-lifecycle.ts`'s
  `ensurePersonPod`/`recreatePod` now internally read the person's state and
  pass `customEnv` into `buildPersonPodSpec`, which appends each var as a
  real `env:` entry (filtered again against `RESERVED_ENV_NAMES` as a
  defensive belt-and-suspenders check). Session continuity survives the
  restart as-is (`sessionIdFile` is NFS-persisted, SDK `resume` reattaches).
- Auto-loaded instructions: the runner has no k8s API access by design (see
  the NetworkPolicy's own comment on this), so it can't read `PersonState`
  directly. Instead `buildPersonPodSpec` also injects
  `PERSON_CUSTOM_VARS_DOC` — a JSON array of `{name, description}` only,
  never values — which `runner/index.ts`'s `installPersonaFiles()` appends
  as a "Your custom environment variables" section onto the per-person
  `CLAUDE.md` on every boot (that function switched from `copyFile` to
  read-then-write to allow the append).

Typecheck, build, and all 55 tests pass (14 new: `person-commands.test.ts`
covers the `/set-var` argument parser as a pure function — same pattern
`isAuthorized`/`slugifyForPerson` already use for unit-testable logic split
out from k8s-touching handlers; `pod-template.test.ts` covers custom vars
landing in `env:` and the reserved-name collision being dropped in favor of
the real secret). No test added for `person-state.ts`'s new mutators or
`tryHandlePersonCommand` itself — consistent with the existing convention of
not unit-testing ConfigMap-mutation glue (`people-index.ts`,
`admin-commands.ts` have no test files either).

**Not yet done:**
- [ ] Not deployed or live-verified yet.
- [ ] Confirm `GH_TOKEN`'s actual scope (flagged in the audit above) —
      unrelated to this feature but worth doing while in this area.

### Session 2026-08-23 (cont.): native auto-memory + `/memories`/`/forget-memory`

Follow-up ask right after `/set-var`: richer info about how a token/var is
actually used (beyond the one-line `/set-var` description), auto-loaded
per pod on boot, that "would always remember." Before building a bespoke
system, checked whether the Agent SDK already has this — it does, and it's
exactly what was being asked for.

Verified directly against the installed `@anthropic-ai/claude-agent-sdk`
package's own `sdk.d.ts` (not just a subagent's claim, which the harness
itself flagged as possibly instruction-shaped and which we independently
confirmed rather than trusting): auto-memory is a real, first-class
`Settings` field (`autoMemoryEnabled`/`autoMemoryDirectory`, settable inline
via `Options.settings` — no file needed), on by default, using plain
`Read`/`Write` (already in `BUILTIN_TOOLS`, no allowlist change needed), and
part of Claude Code's default (`preset: 'claude_code'`) system prompt — the
same "auto memory" behavior/instructions described in Claude Code's own
system prompt. It's model-driven by design (the model decides on its own,
mid-task, what's worth persisting — same behavior as this very assistant's
own memory habit), which is the natural fit for "how ESPUTNIK_TOKEN's API
works" getting captured the first time the model actually calls it, without
any pan-agent-specific plumbing for that case.

- `runner/sdk-session.ts`'s `buildQueryOptions`: added `systemPrompt: {
  type: 'preset', preset: 'claude_code' }` (previously omitted — pins the
  behavior explicitly rather than relying on the SDK's unconfirmed
  omitted-default) and `settings: { autoMemoryEnabled: true,
  autoMemoryDirectory: '<claudeHome>/memory' }`. The directory is pinned to
  a known, simple path (rather than left to the SDK's own
  `~/.claude/projects/<sanitized-cwd>/memory/` default) specifically so the
  operator-side commands below know exactly where to look without
  reproducing the SDK's cwd-sanitization scheme — it still lands inside the
  same per-person NFS mount either way, since `claudeHome` *is* that mount.
  Also added a `memory_recall` case to `logSdkMessage` (mirrors the existing
  `compact_boundary` handling) so Loki shows which memory files got surfaced
  into a turn.
- Per your choice, added human-oversight commands that never touch the
  model, mirroring `/list-vars`/`/unset-var`: `/memories` (list files with
  size/mtime) and `/forget-memory <name>` (delete one). Unlike `/set-var`,
  neither needs a pod restart — the runner reads memory files fresh each
  turn rather than baking them into the pod spec. Implemented via direct
  filesystem access on the operator's own NFS mount (`operator/nfs.ts`,
  same pattern `ensurePersonHomeDirs` already uses) rather than routing
  through the runner — `deleteMemoryFile` only ever deletes a name that
  showed up in that same person's `listMemoryFiles` listing, so there's no
  path-traversal surface from a crafted filename argument.

Typecheck, build, and all 61 tests pass (7 new: `nfs.test.ts` covers
`listMemoryFiles`/`deleteMemoryFile` against a real tmpdir — per-person
scoping, missing-dir handling, and the no-path-traversal guarantee).

**Not yet done:**
- [ ] Not deployed or live-verified yet — in particular, worth confirming
      live that the model actually does write memory files unprompted
      during a normal task (expected per the SDK's documented behavior, but
      hasn't been watched happen in this deployment specifically), and that
      `/memories`/`/forget-memory` see the same files the runner writes
      (confirms the pinned path assumption is correct end to end).

## Backlog

- [x] **Security review of the whole system** — done 2026-08-23, see above.
