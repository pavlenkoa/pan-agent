# pan-agent

> Built with [Claude Code](https://github.com/anthropics/claude-code)

A multi-tenant Telegram host for the Claude Agent SDK: one always-on **operator**
manages one long-lived, isolated **pod per approved person**, each running a
persistent Claude Code session with its own workspace, memory, and Telegram replies.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and everything a
contributor (human or Claude) needs to work on this repo.

## Requirements

- Node.js 24+
- A Kubernetes cluster with NFS-backed storage (`ReadWriteMany`)
- A Telegram bot token (one bot per deployment — see [BotFather](https://t.me/BotFather))
- An Anthropic OAuth token (`claude setup-token`)
- HashiCorp Vault + [External Secrets Operator](https://external-secrets.io/), or any way to land the secrets below into the cluster

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build   # -> dist/operator/index.js, dist/runner/index.js
```

## Layout

```
src/
  shared/     types + helpers shared between operator and runner
  operator/   Deployment (1 replica): Telegram ingress, people index,
              pod lifecycle, task sweep, /tasks API, admin + person commands
  runner/     runs inside every person pod: persistent SDK session, /turn +
              /control HTTP server, journal-based dedup, MCP tools (scheduling,
              attachments), direct Telegram replies
helm/
  pan-agent/  the Helm chart a deploying cluster's GitOps repo pulls
```

## Configuration

**Operator** (env):

| Variable | Required | Description |
|---|---|---|
| `PERSON_POD_IMAGE` | yes | Image tag/digest for person pods |
| `TELEGRAM_BOT_TOKEN` | yes | Shared bot token (operator polls, pods reply directly) |
| `TELEGRAM_ADMIN_ID` | yes | Telegram user id with admin commands |
| `TELEGRAM_ALLOWED_IDS` | no | JSON array of ids that skip pending/approve and get provisioned on first message |
| `NAMESPACE`, `NFS_SERVER`, `NFS_ROOT_PATH`, `NFS_MOUNT_PATH` | no | See `src/operator/config.ts` for defaults |
| `SWEEP_INTERVAL_MS`, `CATCH_UP_WINDOW_MS` | no | Scheduled-task sweep cadence / missed-fire tolerance |
| `PERSONA_CONFIGMAP_NAME`, `MEDIA_PVC_NAME`, `PERSON_POD_NODE`, `DEFAULT_TZ`, `TASKS_API_PORT`, `POD_READY_TIMEOUT_MS` | no | See `src/operator/config.ts` |

**Runner** (env, all set by the operator's pod template — nothing to configure by hand): `PERSON_SLUG`, `PERSON_CHAT_ID`, `PERSON_TASKS_TOKEN`, `OPERATOR_TASKS_URL`, `TELEGRAM_BOT_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`. See `src/runner/config.ts` for optional overrides.

## Telegram commands

**Admin** (DM from `TELEGRAM_ADMIN_ID` only):

| Command | Description |
|---|---|
| `/approve <slug> <telegramUserId>` | Approve a pending sender, or pre-provision one |
| `/deny <telegramUserId>` | Deny a sender — pod removed, future messages dropped |
| `/people` | List active / pending / denied people |
| `/restart <slug>` | Delete + recreate a person's pod |

**Every approved person**, for their own pod only:

| Command | Description |
|---|---|
| `/set_var KEY=VALUE [description]` | Add a persistent env var to your own pod (restarts to apply) |
| `/list_vars` | List your custom env vars (names/descriptions, never values) |
| `/unset_var KEY` | Remove a custom env var (restarts to apply) |
| `/memories` | List what the assistant remembers about you |
| `/forget_memory <filename>` | Delete one memory file |
| `/skills` | List custom skills the assistant has built for you |
| `/forget_skill <name>` | Delete one custom skill |
| `/context` | Show current model, effort, token usage, and auto-compact limit |
| `/effort [low\|medium\|high\|xhigh]` | Show or set model effort for this session (resets on pod restart) |
| `/context_limit [tokens]` | Show or set your auto-compact token ceiling (default 250,000; resets on pod restart) |
| `/compact` | Manually compact your conversation history now |
| `/clear` | Start a fresh conversation (memory/tasks unaffected) |

All of the above are intercepted before the message ever reaches the model — the
Telegram `/` menu is registered per-chat, so an unapproved sender never even sees
these commands exist.

## Deploy

CI builds and pushes `ghcr.io/pavlenkoa/pan-agent` on every push to `main`. The
chart in `helm/pan-agent/` is what a deploying cluster's ArgoCD (or similar)
pulls; environment-specific values (node selector, NFS server/paths, network
CIDRs, image tag) live in that cluster's own GitOps repo, not here.

Person pods are plain `Pod`s created directly by the operator, not managed by a
`Deployment` — a new image requires deleting the running person pods and
restarting the operator (whose boot reconcile recreates anything missing):

```bash
kubectl delete pod person-<slug> -n <namespace>
kubectl rollout restart deployment/pan-agent-operator -n <namespace>
```
