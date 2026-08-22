# pan-agent

Per-person Claude Code agent host for the homelab: one always-on **operator**
process that directly creates and manages one long-lived **pod per person**,
each pod running a **runner** that embeds the Claude Agent SDK. Replaces the
single-tenant `claude-code` StatefulSet.

Full design: see the architecture doc (`docs/architecture.md` in the
conversation this was built from, or ask for a copy) — this README is just
the "how to run it" complement.

## Layout

```
src/
  shared/     types + helpers shared between operator and runner (the /turn
              and /tasks API contracts, the structured stdout logger)
  operator/   Deployment (1 replica): Telegram ingress, people index,
              pod lifecycle, task sweep, /tasks API, admin commands
  runner/     runs inside every person pod: /turn HTTP server, journal-based
              dedup, one Claude Agent SDK query() per turn, direct Telegram
              replies, schedule_task/list_tasks/cancel_task MCP tools
```

This repo builds the image (`ghcr.io/pavlenkoa/pan-agent`) and owns the
deploy manifests: `helm/pan-agent/` is the Helm chart ArgoCD pulls directly
(multi-source Application — environment-specific values, e.g. node/NFS/network
CIDRs, come from the deploying cluster's GitOps repo; see homelab's
`kubernetes/apps/pan-agent/values/homelab.yaml`).

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build   # -> dist/operator/index.js, dist/runner/index.js
```

## Configuration

Operator (required env): `PERSON_POD_IMAGE`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ADMIN_ID`. Optional: `TELEGRAM_ALLOWED_IDS` — a JSON array of
Telegram user ids (e.g. `["333141234","7760060740"]`) that skip the
pending/approve bootstrap and get provisioned immediately on first message.
See `src/operator/config.ts` for every override (`NAMESPACE`, `NFS_SERVER`,
`NFS_ROOT_PATH`, `NFS_MOUNT_PATH`, `SWEEP_INTERVAL_MS`, `CATCH_UP_WINDOW_MS`,
`PERSONA_CONFIGMAP_NAME`, `MEDIA_PVC_NAME`, `PERSON_POD_NODE`, `DEFAULT_TZ`,
`TASKS_API_PORT`, `POD_READY_TIMEOUT_MS`).

Runner (required env, all set by the operator's pod template): `PERSON_SLUG`,
`PERSON_CHAT_ID`, `OPERATOR_TASKS_URL`, `TELEGRAM_BOT_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`. See `src/runner/config.ts` for overrides.

## First deploy (summary — see the architecture doc's migration path for the full sequence)

pan-agent runs its own Telegram bot (**@shanovnybot**, display name "Пан
Агент"), independent of `claude-code`'s bot — both can run at once, no
scale-down needed.

1. Build & push the image (CI does this on push to `main`).
2. On the Pi: `mkdir -p /media/pan-agent/{people,tracking}`, migrate existing
   `~/.claude`/workspace/tracking data from `/media/claude-code` and
   `/media/openclaw` if applicable.
3. `claude setup-token` once, interactively; `vault kv put kv/anthropic
   claude_oauth_token=...`. `telegram_bot_pan_agent_token`,
   `telegram_admin_id`, and `telegram_allowed_ids` already live in
   `kv/telegram`.
4. Pin `PERSON_POD_IMAGE` / the operator container's image to a real digest in
   homelab's `kubernetes/apps/pan-agent/values/homelab.yaml` (placeholder
   `:latest` is there until the first CI build exists).
5. Push `pan-agent` to app-of-apps (already done, not yet pushed to `homelab`)
   and let ArgoCD sync.
6. Message @shanovnybot from one of the `telegram_allowed_ids` — you're
   auto-approved and get a pod immediately, no `/approve` needed.

## Admin commands (DM from `TELEGRAM_ADMIN_ID`)

- `/approve <slug> <telegramUserId>` — approve a pending or pre-provision a person
- `/deny <telegramUserId>` — deny a sender (silently dropped from then on)
- `/people` — list active/pending/denied people
- `/restart <slug>` — delete + recreate a person's pod
