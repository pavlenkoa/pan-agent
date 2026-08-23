/**
 * The operator mounts the NFS root itself and mkdirs per-person homes
 * (architecture doc section 1, step 4b) — inline `nfs:` pod volumes can't
 * mount not-yet-existing subpaths, so this sidesteps needing an
 * openclaw-style root initContainer/chown dance.
 */
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NFS_MOUNT_PATH = process.env['NFS_MOUNT_PATH'] ?? '/mnt/pan-agent-nfs';

// Must match MEMORY_DIR_NAME in runner/sdk-session.ts (the runner's
// autoMemoryDirectory setting) — kept as a separate constant rather than a
// cross-import so the operator doesn't pull in runner/SDK-only code.
const MEMORY_DIR_NAME = 'memory';

export async function ensurePersonHomeDirs(slug: string): Promise<void> {
  await mkdir(path.join(NFS_MOUNT_PATH, 'people', slug, 'claude'), { recursive: true });
  await mkdir(path.join(NFS_MOUNT_PATH, 'people', slug, 'workspace'), { recursive: true });
}

export async function ensureTrackingDir(): Promise<void> {
  await mkdir(path.join(NFS_MOUNT_PATH, 'tracking'), { recursive: true });
}

function personMemoryDir(slug: string): string {
  return path.join(NFS_MOUNT_PATH, 'people', slug, 'claude', MEMORY_DIR_NAME);
}

export interface MemoryFileInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string; // ISO 8601
}

/** Top-level files only (the auto-memory store is documented as a flat directory of .md files, no subfolders). */
export async function listMemoryFiles(slug: string): Promise<MemoryFileInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(personMemoryDir(slug));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files = await Promise.all(
    entries.map(async (name) => {
      const st = await stat(path.join(personMemoryDir(slug), name));
      return st.isFile() ? { name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() } : null;
    }),
  );
  return files.filter((f): f is MemoryFileInfo => f !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Removes any MEMORY.md index line referencing `fileName` (the model's own
 * markdown-link index format: `- [Title](fileName) — hook`) — otherwise a
 * deleted topic file leaves a stale, misleading pointer behind that the
 * model may find before it next touches memory itself.
 */
async function pruneMemoryIndex(slug: string, fileName: string): Promise<void> {
  const indexPath = path.join(personMemoryDir(slug), 'MEMORY.md');
  let content: string;
  try {
    content = await readFile(indexPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const marker = `](${fileName})`;
  const pruned = content
    .split('\n')
    .filter((line) => !line.includes(marker))
    .join('\n');
  if (pruned !== content) await writeFile(indexPath, pruned);
}

/** Deletes one memory file by exact name. Only ever deletes a name that showed up in listMemoryFiles — no path traversal surface. */
export async function deleteMemoryFile(slug: string, name: string): Promise<boolean> {
  const files = await listMemoryFiles(slug);
  if (!files.some((f) => f.name === name)) return false;
  await unlink(path.join(personMemoryDir(slug), name));
  if (name !== 'MEMORY.md') await pruneMemoryIndex(slug, name);
  return true;
}

// ---------------------------------------------------------------------------
// Skills (/skills, /forget_skill) — person-authored .claude/skills/<name>/
// under the person's *workspace* (not claudeHome — same directory the SDK's
// native Skill discovery scans, and where the shared `media` skill already
// lives). `media` is the shared skill (reinstalled on every boot by
// installPersonaFiles) and is deliberately excluded/unremovable here — it
// isn't this person's own state.
// ---------------------------------------------------------------------------

const SHARED_SKILL_NAME = 'media';

function personSkillsDir(slug: string): string {
  return path.join(NFS_MOUNT_PATH, 'people', slug, 'workspace', '.claude', 'skills');
}

export interface SkillInfo {
  name: string;
  description: string;
  modifiedAt: string; // ISO 8601
}

/** Pulls `name`/`description` out of a SKILL.md's `---`-fenced YAML frontmatter — hand-rolled rather than pulling in a YAML dependency for two scalar fields (same convention as parseSetVarArgs). */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv?.[1] && kv[2] !== undefined) result[kv[1] as 'name' | 'description'] = kv[2].trim();
  }
  return result;
}

/** Person-authored skills only — excludes the shared `media` skill, same framing as listMemoryFiles only ever showing this person's own state. */
export async function listPersonSkills(slug: string): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(personSkillsDir(slug));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const skills = await Promise.all(
    entries
      .filter((name) => name !== SHARED_SKILL_NAME)
      .map(async (name) => {
        const skillMdPath = path.join(personSkillsDir(slug), name, 'SKILL.md');
        let content: string;
        let st;
        try {
          content = await readFile(skillMdPath, 'utf8');
          st = await stat(skillMdPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw err;
        }
        const fm = parseSkillFrontmatter(content);
        return { name, description: fm.description ?? '(no description)', modifiedAt: st.mtime.toISOString() };
      }),
  );
  return skills.filter((s): s is SkillInfo => s !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/** Recursively deletes one person-authored skill by directory name. Only ever deletes a name that showed up in listPersonSkills — no path traversal surface, and the shared `media` skill can never be targeted this way. */
export async function deletePersonSkill(slug: string, name: string): Promise<boolean> {
  if (name === SHARED_SKILL_NAME) return false;
  const skills = await listPersonSkills(slug);
  if (!skills.some((s) => s.name === name)) return false;
  await rm(path.join(personSkillsDir(slug), name), { recursive: true, force: true });
  return true;
}
