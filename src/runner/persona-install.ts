/**
 * Copies the shared persona ConfigMap (mounted read-only at PERSONA_MOUNT_DIR)
 * into place inside this pod on every boot. Split out of index.ts so it's a
 * plain-filesystem module — no entrypoint side effects on import — and can be
 * unit-tested against a real temp directory the same way journal.ts and
 * nfs.ts's memory-file functions are (see CLAUDE.md's testing convention).
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { log } from '../shared/log.js';
import type { RunnerConfig } from './config.js';

// Overridable so a test can point this at a temp dir instead of the real
// mounted ConfigMap volume — same pattern as nfs.ts's NFS_MOUNT_PATH.
const PERSONA_MOUNT_DIR = process.env['PERSONA_MOUNT_DIR'] ?? '/config';

/** Every `SKILL-<name>.md` key in the persona ConfigMap becomes a shared skill `<name>`, installed for every person. Matches `SHARED_SKILL_NAMES` in `operator/nfs.ts` — a name added here must be added there too, or `/skills` will misreport it as person-authored and `/forget_skill` will delete it (it'll just come back on next boot, but the listing will lie in the meantime). */
const SHARED_SKILL_FILE_PATTERN = /^SKILL-(.+)\.md$/;

/**
 * An auxiliary file for a shared skill (a script, not the SKILL.md itself),
 * e.g. `SKILL-esputnik-trigger-monitor-ASSET-analyze.py` installed as
 * `.claude/skills/esputnik-trigger-monitor/analyze.py` alongside its
 * `SKILL.md`. A dedicated `-ASSET-` delimiter is needed (rather than
 * splitting on the first remaining `-`) because skill names themselves
 * contain hyphens — `esputnik-trigger-monitor-ASSET-analyze.py` would
 * otherwise be ambiguous about where the name ends and the filename starts.
 * Deliberately doesn't feed into `getSharedSkillNames` (operator/nfs.ts) —
 * that only cares about `.md` keys to derive the shared *skill name* set,
 * which an asset file doesn't add to.
 */
const SHARED_SKILL_ASSET_FILE_PATTERN = /^SKILL-(.+)-ASSET-(.+)$/;

/** Renders the person's own /set_var'd variables (names + descriptions only, never values) as a CLAUDE.md section. */
function renderCustomVarsSection(cfg: RunnerConfig): string {
  if (cfg.customVarsDoc.length === 0) return '';
  const lines = cfg.customVarsDoc.map((v) => `- \`${v.name}\` — ${v.description || '(no description given)'}`);
  return `

## Your custom environment variables

Set via /set_var by the person you're assisting — already present in your Bash environment, not something you need to load or ask for:

${lines.join('\n')}`;
}

/**
 * The pan-agent-persona ConfigMap is mounted read-only at /config — that's
 * not a path the Claude Agent SDK's CLAUDE.md/skill auto-discovery ever
 * looks at (~/.claude/CLAUDE.md for identity/user-level memory,
 * <cwd>/.claude/skills/<name>/SKILL.md for project skills — matches what
 * CLAUDE.md itself already tells the model: "read .claude/skills/media/
 * SKILL.md in the workspace"). Copy it into place on every boot so a
 * ConfigMap update takes effect on the next pod restart, appending the
 * person's own custom-var doc (the runner has no k8s API access itself —
 * see the NetworkPolicy's comment on this — so this comes in via the
 * operator-set PERSON_CUSTOM_VARS_DOC env var instead of a direct read).
 *
 * Returns the shared skill names actually installed this call, so a caller
 * (index.ts's `main()`) can re-read each one's freshly-written SKILL.md and
 * hash-check it via `skillChangedSinceLastAck` (sdk-session.ts) — this
 * function itself does no hash-checking, same separation of concerns as the
 * CLAUDE.md install/re-read/hash-check split already has.
 */
export async function installPersonaFiles(cfg: RunnerConfig): Promise<{ skillNames: string[] }> {
  try {
    const sharedPersona = await readFile(path.join(PERSONA_MOUNT_DIR, 'CLAUDE.md'), 'utf8');
    await writeFile(path.join(cfg.claudeHome, 'CLAUDE.md'), sharedPersona + renderCustomVarsSection(cfg));

    const entries = await readdir(PERSONA_MOUNT_DIR);
    const skillNames: string[] = [];
    for (const entry of entries) {
      const skillMatch = entry.match(SHARED_SKILL_FILE_PATTERN);
      const skillName = skillMatch?.[1];
      if (skillName) {
        const skillDir = path.join(cfg.workspaceCwd, '.claude', 'skills', skillName);
        await mkdir(skillDir, { recursive: true });
        await copyFile(path.join(PERSONA_MOUNT_DIR, entry), path.join(skillDir, 'SKILL.md'));
        skillNames.push(skillName);
        continue;
      }
      const assetMatch = entry.match(SHARED_SKILL_ASSET_FILE_PATTERN);
      if (assetMatch) {
        const [, assetSkillName, fileName] = assetMatch as [string, string, string];
        const skillDir = path.join(cfg.workspaceCwd, '.claude', 'skills', assetSkillName);
        await mkdir(skillDir, { recursive: true });
        await copyFile(path.join(PERSONA_MOUNT_DIR, entry), path.join(skillDir, fileName));
      }
    }

    log.line('persona_installed', { person: cfg.slug, customVars: cfg.customVarsDoc.length, sharedSkills: skillNames });
    return { skillNames };
  } catch (err) {
    log.error('persona_install_failed', err, { person: cfg.slug });
    return { skillNames: [] };
  }
}
