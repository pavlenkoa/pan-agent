# pan-agent — status

## Done

Implemented the approved architecture plan
(`~/.claude/plans/prompt-design-a-frolicking-hennessy.md`) end to end:
operator + runner in TypeScript, plus the homelab deploy manifests. Nothing
is committed in either repo yet.

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

### `~/git/homelab` (uncommitted)

- `kubernetes/apps/pan-agent/`: `rbac.yaml`, `operator-deployment.yaml` (+ Service
  for the tasks API), `networkpolicy.yaml` (person-pod CNP + operator CNP),
  `external-secrets.yaml` (anthropic/telegram/toloka/emby/tmdb/seedpool/github),
  `pv.yaml` (media), `configmap-persona.yaml` (CLAUDE.md + SKILL.md, updated to
  drop the old Telegram-plugin-reply mandate and CRON.md restore hack).
- Registered `pan-agent` in `kubernetes/app-of-apps/values.yaml` under
  `applications` (sync-wave 4, same as `claude-code`).
- All YAML validated (`yaml.safe_load`), not helm-lint'd (plain manifests,
  same pattern as `claude-code`/`transmission`).

## To do

### Before first deploy (blocking)
- [ ] `git init`/commit both repos' changes once reviewed (nothing committed yet).
- [ ] Push `pan-agent` to GitHub so CI actually builds and pushes an image —
      `operator-deployment.yaml`'s image refs are still the `:latest`
      placeholder, not a pinned digest.
- [ ] Pin `PERSON_POD_IMAGE` and the operator container's own image to the
      real digest from that first build (Renovate takes over after).
- [ ] `claude setup-token` (interactive, one-time) → `vault kv put kv/anthropic
      claude_oauth_token=...`.
- [ ] Add `telegram_admin_id` to `kv/telegram` in Vault.
- [ ] On the Pi: `mkdir -p /media/pan-agent/{people,tracking}`; migrate
      `~/.claude`/workspace from `/media/claude-code` and tracking data from
      `/media/openclaw` if carrying over history.
- [ ] Scale `claude-code` StatefulSet to 0 before the operator starts polling
      (only one `getUpdates` consumer allowed per bot token).

### Deploy + validate
- [ ] Let ArgoCD sync `pan-agent`; confirm namespace/RBAC/CNPs/ExternalSecrets
      land clean.
- [ ] `/approve andrii <telegram-id>` (or self-approve as admin); verify pod
      creation, readiness, and first-turn round-trip end to end against a real
      cluster — this whole flow is unit-tested in isolation but never run
      against a live k3s + real Telegram + real Anthropic token.
- [ ] Verify Grafana/Loki actually picks up the stdout JSON lines with the
      expected fields (`{namespace="pan-agent"} | json`).
- [ ] Run the four validation milestones from the architecture doc: operator
      restart amnesia, duplicate-turn (journal dedup), task double-fire
      (catch-up window), node-reboot recovery.
- [ ] Second person end to end (`/approve marta ...`) to confirm isolation
      (separate memory/session, shared persona/tracking).
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
