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

### Loose ends worth a look
- [ ] `operator-deployment.yaml` `strategy: Recreate` means a brief window on
      every operator rollout where nobody is polling Telegram — acceptable
      (Telegram buffers 24h) but worth confirming in practice.
- [ ] No deprovision/offboarding admin command exists yet (only
      approve/deny/people/restart) — fine per v1 scope, but if someone needs
      removing, it's a manual `kubectl delete pod` + ConfigMap edit today.
- [ ] Sweep's per-person `catchUpWindowMs` and pod-ready timeouts are global
      config, not per-person — fine at "handful of people" scale.
