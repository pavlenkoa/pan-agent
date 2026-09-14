import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RunnerConfig } from './config.js';

// persona-install.ts reads PERSONA_MOUNT_DIR into a module-level const at
// import time, so it has to be set before the (dynamic) first import — same
// reasoning as operator/nfs.test.ts's NFS_MOUNT_PATH handling.
let mountDir: string;
let workspaceDir: string;
let claudeHomeDir: string;
let installPersonaFiles: typeof import('./persona-install.js').installPersonaFiles;

function baseConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    slug: 'tania',
    chatId: 1,
    tz: 'Europe/Kyiv',
    port: 8080,
    operatorTasksUrl: 'http://operator/tasks',
    tasksToken: 'token',
    telegramBotToken: 'bot-token',
    journalDir: '/unused',
    workspaceCwd: workspaceDir,
    claudeHome: claudeHomeDir,
    sessionIdFile: '/unused/session-id',
    customVarsDoc: [],
    toolPermissions: [],
    contextLimit: 250_000,
    contextLimitFile: '/unused/context-limit',
    ...overrides,
  };
}

beforeAll(async () => {
  mountDir = await mkdtemp(path.join(tmpdir(), 'pan-agent-persona-mount-'));
  process.env['PERSONA_MOUNT_DIR'] = mountDir;
  const mod = await import('./persona-install.js');
  installPersonaFiles = mod.installPersonaFiles;
});

afterAll(async () => {
  delete process.env['PERSONA_MOUNT_DIR'];
  await rm(mountDir, { recursive: true, force: true });
});

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(tmpdir(), 'pan-agent-persona-workspace-'));
  claudeHomeDir = await mkdtemp(path.join(tmpdir(), 'pan-agent-persona-claudehome-'));
  // mountDir's *path* is fixed at import time (PERSONA_MOUNT_DIR is read into
  // a module-level const), but nothing stops clearing its contents between
  // tests so each test starts from a clean mount, same physical directory.
  for (const entry of await readdir(mountDir)) {
    await rm(path.join(mountDir, entry), { recursive: true, force: true });
  }
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(claudeHomeDir, { recursive: true, force: true });
});

describe('installPersonaFiles', () => {
  it('copies CLAUDE.md into the claude home', async () => {
    await writeFile(path.join(mountDir, 'CLAUDE.md'), '# Persona\n');
    await installPersonaFiles(baseConfig());
    const installed = await readFile(path.join(claudeHomeDir, 'CLAUDE.md'), 'utf8');
    expect(installed).toContain('# Persona');
  });

  it('appends the custom-vars section for a person with set vars', async () => {
    await writeFile(path.join(mountDir, 'CLAUDE.md'), '# Persona\n');
    await installPersonaFiles(baseConfig({ customVarsDoc: [{ name: 'FOO', description: 'a var' }] }));
    const installed = await readFile(path.join(claudeHomeDir, 'CLAUDE.md'), 'utf8');
    expect(installed).toContain('`FOO` — a var');
  });

  it('installs a SKILL-<name>.md key as .claude/skills/<name>/SKILL.md', async () => {
    await writeFile(path.join(mountDir, 'CLAUDE.md'), '# Persona\n');
    await writeFile(path.join(mountDir, 'SKILL-media.md'), '# Media skill\n');
    await installPersonaFiles(baseConfig());
    const installed = await readFile(path.join(workspaceDir, '.claude', 'skills', 'media', 'SKILL.md'), 'utf8');
    expect(installed).toBe('# Media skill\n');
  });

  it('installs an -ASSET- file alongside its skill, under the plain filename', async () => {
    await writeFile(path.join(mountDir, 'CLAUDE.md'), '# Persona\n');
    await writeFile(path.join(mountDir, 'SKILL-esputnik-trigger-monitor.md'), '# Monitor skill\n');
    await writeFile(path.join(mountDir, 'SKILL-esputnik-trigger-monitor-ASSET-analyze.py'), 'print("hi")\n');
    await installPersonaFiles(baseConfig());
    const skillDir = path.join(workspaceDir, '.claude', 'skills', 'esputnik-trigger-monitor');
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('# Monitor skill\n');
    expect(await readFile(path.join(skillDir, 'analyze.py'), 'utf8')).toBe('print("hi")\n');
  });

  it('installs multiple asset files for the same skill', async () => {
    await writeFile(path.join(mountDir, 'CLAUDE.md'), '# Persona\n');
    await writeFile(path.join(mountDir, 'SKILL-esputnik-trigger-monitor.md'), '# Monitor skill\n');
    await writeFile(path.join(mountDir, 'SKILL-esputnik-trigger-monitor-ASSET-analyze.py'), 'a\n');
    await writeFile(path.join(mountDir, 'SKILL-esputnik-trigger-monitor-ASSET-helpers.py'), 'b\n');
    await installPersonaFiles(baseConfig());
    const skillDir = path.join(workspaceDir, '.claude', 'skills', 'esputnik-trigger-monitor');
    expect(await readFile(path.join(skillDir, 'analyze.py'), 'utf8')).toBe('a\n');
    expect(await readFile(path.join(skillDir, 'helpers.py'), 'utf8')).toBe('b\n');
  });

  it('an asset file for a skill with no matching SKILL.md still installs into that skill dir', async () => {
    // Order-independence: an asset entry must not depend on its sibling
    // SKILL.md having been processed first (or existing at all).
    await writeFile(path.join(mountDir, 'CLAUDE.md'), '# Persona\n');
    await writeFile(path.join(mountDir, 'SKILL-lonely-ASSET-script.py'), 'x\n');
    await installPersonaFiles(baseConfig());
    const installed = await readFile(path.join(workspaceDir, '.claude', 'skills', 'lonely', 'script.py'), 'utf8');
    expect(installed).toBe('x\n');
  });

  it('does not treat an asset file as a shared skill name', async () => {
    await writeFile(path.join(mountDir, 'CLAUDE.md'), '# Persona\n');
    await writeFile(path.join(mountDir, 'SKILL-esputnik-trigger-monitor.md'), '# Monitor skill\n');
    await writeFile(path.join(mountDir, 'SKILL-esputnik-trigger-monitor-ASSET-analyze.py'), 'a\n');
    await installPersonaFiles(baseConfig());
    // Only one skill directory should exist for this — the asset must not
    // itself register as e.g. a second skill named "esputnik-trigger-monitor-ASSET-analyze.py".
    const skillDirs = await readdir(path.join(workspaceDir, '.claude', 'skills'));
    expect(skillDirs).toEqual(['esputnik-trigger-monitor']);
  });

  it('ignores unrelated files in the mount dir', async () => {
    await writeFile(path.join(mountDir, 'CLAUDE.md'), '# Persona\n');
    await writeFile(path.join(mountDir, 'some-other-file.txt'), 'noise\n');
    await installPersonaFiles(baseConfig());
    const skillsDirExists = await readFile(path.join(workspaceDir, '.claude', 'skills'), 'utf8').catch((err: NodeJS.ErrnoException) => err.code);
    // .claude/skills is never created at all when there are no SKILL-*.md entries.
    expect(skillsDirExists).toBe('ENOENT');
  });

  it('does not throw when CLAUDE.md is missing from the mount dir (best-effort, logs and returns)', async () => {
    // mountDir intentionally has no CLAUDE.md written in this test.
    await expect(installPersonaFiles(baseConfig())).resolves.toBeUndefined();
    const skillsDirMissing = await readFile(path.join(workspaceDir, '.claude', 'skills'), 'utf8').catch(
      (err: NodeJS.ErrnoException) => err.code,
    );
    expect(skillsDirMissing).toBe('ENOENT'); // bailed out before ever reading the skill entries
  });
});
