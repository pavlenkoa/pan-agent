# pan-agent — status

## Done

Implemented the approved architecture plan
(`~/.claude/plans/prompt-design-a-frolicking-hennessy.md`) end to end:
operator + runner in TypeScript, plus the homelab deploy manifests. Both
repos are committed; `pan-agent` is pushed to GitHub (CI building), and its
Helm chart is now the source of truth for k8s manifests (see below).
`homelab`'s `pan-agent` registration is committed locally but **not yet
pushed** — see "Before first deploy" below.

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
- **Tests** (15, all passing): journal dedup incl. crash-mid-turn retry and
  task-tuple dedup; drift-free cron + catch-up window; batching-under-retry.
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

### `~/git/homelab` (committed locally, not pushed)

- `kubernetes/apps/pan-agent/values/homelab.yaml`: node/NFS/network/image
  overrides for the chart above.
- `kubernetes/app-of-apps/values.yaml`: `pan-agent` now uses
  `repository:`/`path: helm/pan-agent` (multi-source Application pulling the
  chart from the `pan-agent` repo + values from `homelab`) instead of
  `directory: {}`. Also added `pan-agent`'s repo URL to the `applications`
  parent's `sourceRepos` (AppProject would otherwise reject the external
  source). Verified by rendering `app-of-apps` with `--set
  renderParent=applications` — the generated Application matches
  `vault-secrets-generator`'s shape exactly.
- **Not pushed yet** — pushing triggers ArgoCD auto-sync
  (`automated.prune: true`) and several blockers below aren't done, notably
  `claude-code` still being up would mean two concurrent Telegram
  `getUpdates` consumers.

## To do

### Before first deploy (blocking)
- [x] `git init`/commit both repos' changes.
- [x] Push `pan-agent` to GitHub so CI actually builds and pushes an image —
      the chart's image refs are still the `:latest` placeholder, not a
      pinned digest.
- [ ] Push `homelab` (currently committed locally only) once the blockers
      below are done — this is what actually triggers ArgoCD to deploy.
- [ ] Pin `PERSON_POD_IMAGE` and the operator container's own image to the
      real digest from that first build (Renovate takes over after).
- [ ] `claude setup-token` (interactive, one-time) → `vault kv put kv/anthropic
      claude_oauth_token=...`.
- [x] Telegram bot separated from `claude-code`'s: pan-agent has its own bot,
      **@shanovnybot** (t.me/shanovnybot, display name "Пан Агент") — token in
      `kv/telegram` as `telegram_bot_pan_agent_token`. `claude-code` and
      `pan-agent` run independently, each polling its own bot's `getUpdates`;
      no need to scale `claude-code` down.
- [x] `telegram_admin_id` (333141234) and `telegram_allowed_ids`
      (`["333141234","7760060740","41133035"]`) added to `kv/telegram`.
      Added `TELEGRAM_ALLOWED_IDS` support: unknown senders in that list skip
      the pending/approve bootstrap and get provisioned immediately
      (`src/operator/provisioning.ts`, wired into `router.ts`'s
      `handleUnknownSender` and reused by `/approve`) — no manual per-person
      approval needed for these three.
- [ ] On the Pi: `mkdir -p /media/pan-agent/{people,tracking}`; migrate
      `~/.claude`/workspace from `/media/claude-code` and tracking data from
      `/media/openclaw` if carrying over history.

### Deploy + validate
- [ ] Let ArgoCD sync `pan-agent`; confirm namespace/RBAC/CNPs/ExternalSecrets
      land clean.
- [ ] Message @shanovnybot as one of the three allowlisted IDs; verify
      auto-approve provisions the pod and delivers the first turn end to end
      against a real cluster — this whole flow is unit-tested in isolation but
      never run against a live k3s + real Telegram + real Anthropic token.
- [ ] Verify Grafana/Loki actually picks up the stdout JSON lines with the
      expected fields (`{namespace="pan-agent"} | json`).
- [ ] Run the four validation milestones from the architecture doc: operator
      restart amnesia, duplicate-turn (journal dedup), task double-fire
      (catch-up window), node-reboot recovery.
- [ ] Second/third person end to end (the other two allowlisted IDs
      auto-approving) to confirm isolation (separate memory/session, shared
      persona/tracking) and that the slug-collision fallback in
      `uniqueSlug`/`slugifyForPerson` never triggers spuriously for real names.
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
