# Prompt: Design a per-person Claude Code agent host for the homelab

You are a systems architect. Design (do not implement yet) a replacement for a hand-rolled,
single-tenant Claude Code deployment: **one always-on operator process that directly spawns and
manages one long-lived, isolated pod per person it talks to**, each pod carrying everything
needed for an ongoing, private conversation with that one person — a "nanoclaw"-style pattern,
but deliberately **not** a Kubernetes CRD/controller-operator. Direct pod management from a
single host process, not a reconciled custom resource, per the reasoning below.

Produce a written architecture document covering the sections under "What I want back" at the
end. Ask clarifying questions first only if something below is genuinely ambiguous — otherwise
make and justify reasonable calls; several major decisions are already made (see "Resolved
architecture direction") and should not be re-litigated without a clearly stated reason.

## Current system (what exists today, to replace)

A single Claude Code instance ("Пан Claude") runs as a hand-authored `StatefulSet` in a homelab
k3s cluster (2-node: Raspberry Pi arm64 + Mac Mini via OrbStack VM, Cilium CNI, GitOps via
ArgoCD app-of-apps, `kubernetes/apps/claude-code/`). It works for one person; everything below
would need hand-duplicating for a second.

**Image** (`images/claude-code/Dockerfile`): `node:24-bookworm-slim` + `@anthropic-ai/claude-code`
+ `gh` CLI + `bun` + media tooling (`ffmpeg`, `mediainfo`, `ripgrep`, `screen`). Runs as a fixed
non-root user (uid 1000). `ENTRYPOINT ["claude"]` — the image is generic; identity/behavior is
injected at runtime.

**Deployment shape**: one `StatefulSet`, one replica. Startup script does, every boot: self-update
the CLI; bootstrap `.claude.json` to skip the trust dialog; overwrite `CLAUDE.md`/skill/`.mcp.json`
into the workspace from a `ConfigMap` (persona is declarative, reset every restart; conversation
data lives on persistent NFS); configure `git`/`gh` bot identity; write the Telegram bot token and
enable the Telegram channel plugin; write a `SessionStart` hook that just echoes a string asking
the model to re-read `/tracking/CRON.md` and recreate crons via `CronCreate` — a prompt-injection
workaround, fragile, not a real mechanism; **block** in a loop until `~/.claude/.credentials.json`
exists (OAuth login is manual: `kubectl exec -it <pod> -- claude`, then complete the device-auth
flow by hand); launch `claude --channels plugin:telegram@... --permission-mode acceptEdits
--allowedTools "<fixed list>"` inside a detached `screen` session; `tail -f /dev/null` to keep the
pod alive.

**State & storage**: `~/.claude`, workspace, and a shared `/tracking` dir are NFS mounts from the
Raspberry Pi. `/tracking` is explicitly shared with a sibling identity ("Pan Tolik" — not present
in this repo; Vault/NFS paths reference `openclaw`), meaning multi-tenant is already an implicit
need, currently handled by hand-copying manifests. A media library PV (NFS, 1Ti, RWX) is mounted
for Emby/Transmission.

**Secrets**: per-app `ExternalSecret`s (Vault KV v2 → `ClusterSecretStore` → `Secret`), one per
credential (Telegram bot token + allowlist, Toloka, Emby, TMDB, GitHub, Seedpool). Telegram
`access.json` is currently a single global allowlist — "single-user mode."

**Network**: `CiliumNetworkPolicy` locks egress to DNS, Transmission RPC, the k8s API server, Emby
on the macOS host, NFS to the Pi, and general internet minus home LAN/router/WireGuard ranges.

**Persona**: one `CLAUDE.md` in a `ConfigMap` — fixed name/personality, mandatory cron-restore
startup sequence, mandatory Telegram-only reply rule, media capabilities (Toloka/Nyaa/Seedpool
search, Transmission, Emby, TMDB, cron scheduling), subscription/download tracking file formats
under `/tracking/`, security rules (never reveal secrets). A `SKILL.md` holds detailed API recipes.

## What's broken about this

- **No reconciliation/multi-tenancy.** A new person means hand-copying the whole manifest tree.
- **OAuth bootstrap is fully manual** per instance (`kubectl exec -it ... -- claude`).
- **Cron persistence is a prompt-injection hack**, not a controlled mechanism.
- **No isolation model.** One global Telegram allowlist, one shared workspace — no boundary
  between "this pod belongs to this person" beyond convention.
- **Persona is static YAML**, not a first-class object with lifecycle.

## Resolved architecture direction

These decisions came out of a design discussion grounded in two real reference systems — read
both before proposing anything that contradicts them:

1. **[nanoclaw](https://github.com/nanocoai/nanoclaw)** (also checked out locally at
   `~/git/nanoclaw` on this machine, if available in your environment) — an existing, working
   multi-tenant personal-assistant host. Its `docs/architecture.md`, `docs/isolation-model.md`,
   and `docs/scheduled-tasks.md` are the primary precedent for the session/isolation/scheduling
   model below.
2. An internal production system (not included here, summarized from its design doc) that runs
   Claude Code as ephemeral per-turn Kubernetes `Job`s for a read-only Jira incident-diagnosis
   bot, with an operator (Go) that mints scoped tokens, tracks per-ticket state in a `ConfigMap`,
   and mounts a single shared PVC co-scheduled onto the operator's own node so `--resume` finds
   the transcript instantly. That system's turn cadence (rare, externally triggered) doesn't fit
   a chat bot — its state-storage choices do, and are adopted below.

**Not a CRD/controller operator.** nanoclaw itself isn't a Kubernetes operator — it's one
long-running host process that talks directly to the container runtime's API to create and tear
down per-tenant containers, with a small routing/session database as the source of truth instead
of custom resources. Translate that directly: **one Deployment (1 replica), the "operator," that
talks to the k8s API directly** (client library, not a generated CRD/controller/reconcile loop) to
create and delete per-person `Pod`s. A full CRD only pays for itself if tenant definitions need to
be `kubectl`/ArgoCD-native declarative objects — at "handful of people, one admin" scale that's
solving a problem that doesn't exist yet. Do not propose a CRD/controller-runtime design unless
you can argue concretely why direct pod management is insufficient.

**Isolation: one pod per person, always-on, not per-turn.** Unlike the Jira bot (rare, external
triggers — ephemeral per-turn `Job`s make sense there), a chat chatbot's cadence and the desire
for zero wake latency favor nanoclaw's "separate agent groups" isolation level: one long-lived pod
per person, created once on first contact and left running indefinitely (no idle-timeout/teardown
machinery needed at this scale — that complexity exists in nanoclaw only because *its* containers
are ephemeral). Each pod only ever sees messages from its one person; no shared session, no
global allowlist.

**State: ConfigMap for low-frequency state, no SQLite, no message queue.** Two different
concerns, two different fits:
- *Routing/session index* (person → session id, pod name, last-seen) and *cron/task definitions*
  (name, cron expression, prompt, next-run time) change rarely — one write per event, not per
  message. A `ConfigMap` per person (or one central `ConfigMap`, if it stays comfortably under
  the ~1MiB object limit) is a legitimate fit here, validated by the Jira-bot precedent above,
  which uses exactly this pattern for its ticket-index state.
- *The actual conversation* doesn't need a custom message-queue/polling protocol at all (unlike
  nanoclaw's `inbound.db`/`outbound.db`), because pods aren't ephemeral and don't need to
  discover queued work on wake — a long-lived pod can hold its channel connection directly and
  process turns as they arrive. Don't build a SQLite-backed message bus unless you can justify
  why direct handling doesn't work.
- Known correctness gap to design around, not ignore: `ConfigMap`s have no transactions. The
  Jira-bot precedent hit exactly this (a crash between posting and recording state could
  double-post) and mitigated it by verifying against the real source of truth after the fact
  rather than trusting the `ConfigMap` alone. Apply the same principle wherever a `ConfigMap`
  write could race a side effect (e.g., don't let a crash mid-write cause a duplicate Telegram
  reply or a duplicate torrent download).

**Crons: operator-owned, sweep-driven, never something the model has to remember.** Task
definitions live in the `ConfigMap` state above. The operator sweeps on a timer (nanoclaw does
this at ~60s), and when a task is due, it delivers it to the owning person's pod the same way an
incoming message would. This fully replaces the `/tracking/CRON.md` + `SessionStart` hack — the
model never needs to read a file and recreate anything on restart.

**Auth: `claude setup-token`, shared static secret, no broker required for correctness.** Claude
Code has a first-class mechanism for exactly this multi-container case: `claude setup-token` runs
the OAuth flow once (interactively — this remains a one-time manual step, same as today) and
prints a long-lived, static bearer token (`sk-ant-oat...`), settable as `CLAUDE_CODE_OAUTH_TOKEN`.
This is operationally identical to injecting an API key — no refresh logic needed per pod, no
concurrent-refresh race, because nothing is refreshing. Mint it once, store it in Vault the same
way every other credential in this system is stored, deliver it via `ExternalSecret` into every
per-person pod. A credential broker/proxy (nanoclaw's OneCLI pattern: agents never hold the raw
token, all requests route through a vault-backed gateway) is a legitimate *optional* hardening
step for later — it protects against a compromised/prompt-injected pod exfiltrating the token —
but it is not required for v1 and should not be designed as a hot-path dependency: pods talk
**directly** to Anthropic. An in-cluster proxy hop is low-single-digit milliseconds against a
multi-second LLM completion, so this is not a latency decision — only a defense-in-depth one, and
should be presented as a clearly separable follow-up, not entangled with the base design.

**Observability: dialogue and tool-calls onto pod stdout, no new infrastructure.** The Claude
Agent SDK already writes a full transcript (messages, tool calls, tool results, thinking blocks
if enabled) to disk per session. The requirement is to also emit this to the pod's **stdout** in
a reasonably structured form (one line per message/tool-call/thinking-block), so the existing
`fluent-bit` DaemonSet → Loki pipeline picks it up automatically, exactly like every other pod in
this cluster — browsable in Grafana per person/session, filterable by pod label. Do not design a
separate log shipper, viewer, or storage path for this.

## Constraints the design must respect

- Cluster is a 2-node k3s (arm64 Raspberry Pi + Mac Mini via OrbStack VM), Cilium CNI, kgateway
  ingress. Design for a handful of concurrent always-on person-pods, not hundreds.
- Everything is deployed via ArgoCD app-of-apps GitOps. The operator itself is GitOps-managed;
  the per-person pods it creates at runtime are not manifests in git (they're created dynamically
  by the operator, the way nanoclaw's host creates containers) — make this split explicit.
- Secrets flow through Vault → External Secrets Operator → k8s `Secret`; nothing hardcoded.
- Network policy is Cilium-based, namespace/label-selector driven; per-person pods need a sane
  way to inherit or generate the right `CiliumNetworkPolicy`.
- NFS (Raspberry Pi) is the only shared storage available — no cloud storage, no dynamic block
  storage provisioner beyond what's already there.
- Should stay debuggable by one person (homelab, not a platform team) — avoid incidental
  complexity that doesn't pay for itself at this scale. This is the main reason the CRD/controller
  route was rejected above; don't reintroduce equivalent complexity elsewhere.

## What I want back

1. **Entity/routing model** — how a Telegram (and later, possibly other channel) message maps to
   a person and a pod. Include the bootstrap case explicitly: a message arrives from someone with
   no pod yet — who receives that first message (the operator itself, presumably, since the
   person's pod doesn't exist to receive it), and what's the exact sequence from "unknown sender"
   to "pod running and able to answer"? This wasn't fully resolved in the design discussion and
   needs a concrete answer.
2. **Operator design** — implementation approach (language/library for talking to the k8s API
   directly — Go with client-go is a reasonable default given precedent, but justify it), what it
   owns and creates per person (Pod, ConfigMap, Secret refs, NetworkPolicy), and its own
   lifecycle/restart behavior (it must recover its view of "which people/pods exist" from the
   ConfigMap state on its own restart, not from memory).
3. **Per-person pod template** — mounts, env, image, resource requests/limits sized for an
   always-on process at this cluster's scale, and how many concurrent people are actually
   feasible on this hardware.
4. **State schema** — concrete `ConfigMap` shape(s) for the session index and for cron/task
   definitions, and where the correctness-gap mitigation (verify against real state, don't trust
   the ConfigMap alone) applies concretely in this system.
5. **Isolation level choice** — nanoclaw draws a distinction between "separate agent groups"
   (nothing shared: different persona, memory, workspace per person) and "same agent, separate
   sessions" (shared persona/skills/memory, independent conversations). Recommend one for this
   use case and justify it — does every person get the same "Пан Claude" persona and shared media
   knowledge, or does each get fully separate everything?
6. **Credential delivery** — concrete Vault path / `ExternalSecret` wiring for the
   `CLAUDE_CODE_OAUTH_TOKEN`, consistent with how every other credential in this system already
   flows.
7. **Observability wiring** — what the pod actually writes to stdout (format/verbosity) so it's
   useful in Grafana without being noisy, and whether any labels/fields need adding for
   per-person/per-session filtering.
8. **Migration path** — concrete steps from today's single StatefulSet to the first
   operator-managed person-pod, and a worked example of a second person appearing.
9. **Non-goals** — what to explicitly defer: CRD/controller (explicitly rejected above, don't
   redesign it in), horizontal scaling beyond a handful of people, channels other than Telegram,
   multi-cluster, the credential-broker hardening step (name it as a clean future increment).

Keep the answer concrete and opinionated — this is a homelab project for one operator (human),
not a platform for a team. Prefer the simplest design that actually solves the problems above,
not the most general one.
