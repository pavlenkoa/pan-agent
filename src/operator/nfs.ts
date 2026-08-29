/**
 * The operator mounts the NFS root itself and mkdirs per-person homes
 * (architecture doc section 1, step 4b) — inline `nfs:` pod volumes can't
 * mount not-yet-existing subpaths, so this sidesteps needing an
 * openclaw-style root initContainer/chown dance.
 */
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ESPUTNIK_SERVER_URL } from '../shared/types.js';

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
// native Skill discovery scans, and where the shared skills already live).
// Shared skills (one per `SKILL-<name>.md` key in the persona ConfigMap,
// reinstalled on every boot by runner/index.ts's installPersonaFiles) are
// deliberately excluded/unremovable here — they aren't this person's own
// state. Keep this set in sync with the ConfigMap's `SKILL-*.md` keys.
// ---------------------------------------------------------------------------

const SHARED_SKILL_NAMES = new Set(['media', 'esputnik-query']);

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

/** Person-authored skills only — excludes shared skills, same framing as listMemoryFiles only ever showing this person's own state. */
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
      .filter((name) => !SHARED_SKILL_NAMES.has(name))
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

/** Recursively deletes one person-authored skill by directory name. Only ever deletes a name that showed up in listPersonSkills — no path traversal surface, and a shared skill can never be targeted this way. */
export async function deletePersonSkill(slug: string, name: string): Promise<boolean> {
  if (SHARED_SKILL_NAMES.has(name)) return false;
  const skills = await listPersonSkills(slug);
  if (!skills.some((s) => s.name === name)) return false;
  await rm(path.join(personSkillsDir(slug), name), { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Sticker packs (/sticker_packs, /forget_sticker_pack, and auto-add when a
// person forwards a sticker) — a small JSON file directly on the person's
// claude-home NFS mount, same "runner reads it fresh, no pod restart needed"
// shape as memories above. Must match STICKER_PACKS_FILE_NAME in
// runner/sticker-store.ts (kept as a separate constant, not a cross-import,
// same reasoning as MEMORY_DIR_NAME above).
// ---------------------------------------------------------------------------

const STICKER_PACKS_FILE_NAME = 'sticker-packs.json';

export interface StickerPackInfo {
  name: string;
  addedAt: string; // ISO 8601
}

function stickerPacksFile(slug: string): string {
  return path.join(NFS_MOUNT_PATH, 'people', slug, 'claude', STICKER_PACKS_FILE_NAME);
}

/** Top-level array only — the file is small and hand-written, no reason for a richer shape yet. */
export async function listStickerPacks(slug: string): Promise<StickerPackInfo[]> {
  let raw: string;
  try {
    raw = await readFile(stickerPacksFile(slug), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (v): v is StickerPackInfo => typeof v === 'object' && v !== null && typeof v.name === 'string' && typeof v.addedAt === 'string',
  );
}

/** Dedups by name (case-sensitive — Telegram set names are, too). Returns `added: false` when the pack was already present. */
export async function addStickerPack(slug: string, setName: string): Promise<{ added: boolean }> {
  const packs = await listStickerPacks(slug);
  if (packs.some((p) => p.name === setName)) return { added: false };
  packs.push({ name: setName, addedAt: new Date().toISOString() });
  await mkdir(path.dirname(stickerPacksFile(slug)), { recursive: true });
  await writeFile(stickerPacksFile(slug), JSON.stringify(packs, null, 2));
  return { added: true };
}

/** Removes one pack by exact name. Only ever removes a name that showed up in listStickerPacks — no path traversal surface (the name is never used as a path segment). */
export async function removeStickerPack(slug: string, name: string): Promise<boolean> {
  const packs = await listStickerPacks(slug);
  const remaining = packs.filter((p) => p.name !== name);
  if (remaining.length === packs.length) return false;
  await writeFile(stickerPacksFile(slug), JSON.stringify(remaining, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
// eSputnik MCP OAuth credentials (/esputnik_connect) — written directly into
// the person's own `.claude/.credentials.json`, the exact file/shape the
// Claude Code CLI's own MCP OAuth client already reads and auto-refreshes
// from (confirmed live against this machine's real esputnik connection
// before this design was built) — a plain file write to an already-mounted
// NFS volume, no pod restart involved.
// ---------------------------------------------------------------------------

function credentialsFile(slug: string): string {
  return path.join(NFS_MOUNT_PATH, 'people', slug, 'claude', '.credentials.json');
}

/** Everything a stored `mcpOAuth` entry needs besides `serverName`/`serverUrl` (which writeEsputnikCredential fills in itself). */
export interface EsputnikTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  clientId: string;
  redirectUri: string;
  issuer: string;
  scope: string;
  discoveryState: {
    authorizationServerUrl: string;
    resourceMetadataUrl: string;
    oauthMetadataFound: boolean;
  };
}

/**
 * Read-modify-write `.credentials.json`'s `mcpOAuth` map, writing under the
 * plain key `serverKey` (not a `serverKey|<hash>` suffix) and pruning any
 * existing `serverKey`-or-`serverKey|*` entry first — a reconnect (renewing
 * a dead token, see CLAUDE.md's eSputnik OAuth renewal note) always
 * overwrites in place rather than risking a stale duplicate, regardless of
 * whatever key format the SDK's own writes might use once it touches this
 * file itself (unconfirmed locally, verified live in Phase 5 against a real
 * pod instead — see CLAUDE.md's "Phase 0 status" note). Preserves every
 * other top-level key (`claudeAiOauth`, other services' `mcpOAuth` entries)
 * untouched. Read-then-write with no lock — the window is small and this
 * project accepts that class of low-probability race at its current scale
 * (same reasoning as the design's OAuth security notes).
 */
export async function writeEsputnikCredential(slug: string, serverKey: string, tokens: EsputnikTokenSet): Promise<void> {
  const filePath = credentialsFile(slug);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const mcpOAuth = { ...((raw['mcpOAuth'] as Record<string, unknown> | undefined) ?? {}) };
  for (const key of Object.keys(mcpOAuth)) {
    if (key === serverKey || key.startsWith(`${serverKey}|`)) delete mcpOAuth[key];
  }
  mcpOAuth[serverKey] = { serverName: serverKey, serverUrl: ESPUTNIK_SERVER_URL, ...tokens };
  const next = { ...raw, mcpOAuth };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
}
