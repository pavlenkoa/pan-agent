import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// nfs.ts reads NFS_MOUNT_PATH into a module-level const at import time, so it
// has to be set before the (dynamic) first import — plain top-level `import`
// would run too early to see this test file's tmpdir.
let dir: string;
let listMemoryFiles: typeof import('./nfs.js').listMemoryFiles;
let deleteMemoryFile: typeof import('./nfs.js').deleteMemoryFile;
let listPersonSkills: typeof import('./nfs.js').listPersonSkills;
let deletePersonSkill: typeof import('./nfs.js').deletePersonSkill;
let listStickerPacks: typeof import('./nfs.js').listStickerPacks;
let addStickerPack: typeof import('./nfs.js').addStickerPack;
let removeStickerPack: typeof import('./nfs.js').removeStickerPack;
let writeEsputnikCredential: typeof import('./nfs.js').writeEsputnikCredential;

const SAMPLE_TOKENS = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 1_800_000_000_000,
  clientId: 'client-1',
  redirectUri: 'https://api.pavlenko.io/oauth/esputnik/callback',
  issuer: 'https://mcp.esputnik.com/',
  scope: 'esputnik.api',
  discoveryState: {
    authorizationServerUrl: 'https://mcp.esputnik.com/',
    resourceMetadataUrl: 'https://mcp.esputnik.com/.well-known/oauth-protected-resource',
    oauthMetadataFound: true,
  },
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pan-agent-nfs-'));
  process.env['NFS_MOUNT_PATH'] = dir;
  const mod = await import('./nfs.js');
  listMemoryFiles = mod.listMemoryFiles;
  deleteMemoryFile = mod.deleteMemoryFile;
  listPersonSkills = mod.listPersonSkills;
  deletePersonSkill = mod.deletePersonSkill;
  listStickerPacks = mod.listStickerPacks;
  addStickerPack = mod.addStickerPack;
  removeStickerPack = mod.removeStickerPack;
  writeEsputnikCredential = mod.writeEsputnikCredential;
});

afterAll(async () => {
  delete process.env['NFS_MOUNT_PATH'];
  await rm(dir, { recursive: true, force: true });
});

describe('listMemoryFiles', () => {
  it('returns an empty list when the memory dir does not exist yet', async () => {
    expect(await listMemoryFiles('nobody')).toEqual([]);
  });

  it('lists files present in a person\'s memory dir', async () => {
    const memDir = path.join(dir, 'people', 'andrii', 'claude', 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(path.join(memDir, 'MEMORY.md'), '# index');
    await writeFile(path.join(memDir, 'feedback_x.md'), 'a note');

    const files = await listMemoryFiles('andrii');
    expect(files.map((f) => f.name).sort()).toEqual(['MEMORY.md', 'feedback_x.md'].sort());
    expect(files.every((f) => f.sizeBytes > 0)).toBe(true);
  });

  it('is scoped per person — one person\'s files never show up for another', async () => {
    const memDir = path.join(dir, 'people', 'only-andrii', 'claude', 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(path.join(memDir, 'secret.md'), 'private');

    expect(await listMemoryFiles('someone-else')).toEqual([]);
  });
});

describe('deleteMemoryFile', () => {
  it('deletes a file that exists and reports it removed', async () => {
    const memDir = path.join(dir, 'people', 'marta', 'claude', 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(path.join(memDir, 'note.md'), 'x');

    expect(await deleteMemoryFile('marta', 'note.md')).toBe(true);
    expect(await listMemoryFiles('marta')).toEqual([]);
  });

  it('returns false for a name that is not an actual listed file (no path traversal)', async () => {
    expect(await deleteMemoryFile('marta', '../../../etc/passwd')).toBe(false);
  });

  it('returns false for a nonexistent file in an existing memory dir', async () => {
    const memDir = path.join(dir, 'people', 'marta', 'claude', 'memory');
    await mkdir(memDir, { recursive: true });
    expect(await deleteMemoryFile('marta', 'does-not-exist.md')).toBe(false);
  });

  it('prunes the matching MEMORY.md index line when deleting a topic file', async () => {
    const memDir = path.join(dir, 'people', 'oleh', 'claude', 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(
      path.join(memDir, 'MEMORY.md'),
      [
        '- [Address the user as ЧУВАККК](feedback_address_form.md) — explicit preference',
        '- [Prefers terse replies](feedback_terse.md) — stated directly',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(memDir, 'feedback_address_form.md'), 'content');
    await writeFile(path.join(memDir, 'feedback_terse.md'), 'content');

    expect(await deleteMemoryFile('oleh', 'feedback_address_form.md')).toBe(true);

    const index = await readFile(path.join(memDir, 'MEMORY.md'), 'utf8');
    expect(index).not.toContain('feedback_address_form.md');
    expect(index).toContain('feedback_terse.md');
  });

  it('does not try to prune the index when deleting MEMORY.md itself', async () => {
    const memDir = path.join(dir, 'people', 'petro', 'claude', 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(path.join(memDir, 'MEMORY.md'), '- [Something](note.md) — a note');

    expect(await deleteMemoryFile('petro', 'MEMORY.md')).toBe(true);
    expect(await listMemoryFiles('petro')).toEqual([]);
  });
});

describe('listPersonSkills', () => {
  it('returns an empty list when the skills dir does not exist yet', async () => {
    expect(await listPersonSkills('nobody')).toEqual([]);
  });

  it('lists a skill and parses its frontmatter description', async () => {
    const skillDir = path.join(dir, 'people', 'andrii', 'workspace', '.claude', 'skills', 'esputnik');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: esputnik\ndescription: Recipes for the eSputnik API.\n---\n\nBody here.\n',
    );

    const skills = await listPersonSkills('andrii');
    expect(skills).toEqual([
      { name: 'esputnik', description: 'Recipes for the eSputnik API.', modifiedAt: expect.any(String) },
    ]);
  });

  it('excludes the shared media skill', async () => {
    const mediaDir = path.join(dir, 'people', 'andrii2', 'workspace', '.claude', 'skills', 'media');
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, 'SKILL.md'), '# Media Management Skill\n');

    expect(await listPersonSkills('andrii2')).toEqual([]);
  });

  it('is scoped per person — one person\'s skills never show up for another', async () => {
    const skillDir = path.join(dir, 'people', 'only-oleh', 'workspace', '.claude', 'skills', 'secret-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: secret-skill\ndescription: private\n---\n');

    expect(await listPersonSkills('someone-else')).toEqual([]);
  });

  it('skips a skill directory with no SKILL.md', async () => {
    const emptyDir = path.join(dir, 'people', 'marta2', 'workspace', '.claude', 'skills', 'empty');
    await mkdir(emptyDir, { recursive: true });

    expect(await listPersonSkills('marta2')).toEqual([]);
  });
});

describe('deletePersonSkill', () => {
  it('deletes a skill directory that exists and reports it removed', async () => {
    const skillDir = path.join(dir, 'people', 'marta3', 'workspace', '.claude', 'skills', 'to-delete');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: to-delete\ndescription: x\n---\n');

    expect(await deletePersonSkill('marta3', 'to-delete')).toBe(true);
    expect(await listPersonSkills('marta3')).toEqual([]);
  });

  it('returns false for a name that is not an actual listed skill (no path traversal)', async () => {
    expect(await deletePersonSkill('marta3', '../../../etc')).toBe(false);
  });

  it('refuses to delete the shared media skill even if asked by exact name', async () => {
    const mediaDir = path.join(dir, 'people', 'marta4', 'workspace', '.claude', 'skills', 'media');
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, 'SKILL.md'), '# Media Management Skill\n');

    expect(await deletePersonSkill('marta4', 'media')).toBe(false);
    // still on disk
    const remaining = await readFile(path.join(mediaDir, 'SKILL.md'), 'utf8');
    expect(remaining).toContain('Media Management Skill');
  });

  it('returns false for a nonexistent skill in an existing skills dir', async () => {
    const skillsDir = path.join(dir, 'people', 'marta3', 'workspace', '.claude', 'skills');
    await mkdir(skillsDir, { recursive: true });
    expect(await deletePersonSkill('marta3', 'does-not-exist')).toBe(false);
  });
});

describe('listStickerPacks / addStickerPack / removeStickerPack', () => {
  it('returns an empty list when no pack file exists yet', async () => {
    expect(await listStickerPacks('nobody')).toEqual([]);
  });

  it('adds a pack and reports it back, creating the person dir if needed', async () => {
    expect(await addStickerPack('taras', 'PeachCat')).toEqual({ added: true });

    const packs = await listStickerPacks('taras');
    expect(packs).toEqual([{ name: 'PeachCat', addedAt: expect.any(String) }]);
  });

  it('dedups adding the same pack twice', async () => {
    await addStickerPack('nadia', 'DogePack');
    expect(await addStickerPack('nadia', 'DogePack')).toEqual({ added: false });

    const packs = await listStickerPacks('nadia');
    expect(packs).toHaveLength(1);
  });

  it('is scoped per person', async () => {
    await addStickerPack('only-hanna', 'HannaPack');
    expect(await listStickerPacks('someone-else')).toEqual([]);
  });

  it('removes a pack that exists and reports it removed', async () => {
    await addStickerPack('roman', 'ToRemove');
    expect(await removeStickerPack('roman', 'ToRemove')).toBe(true);
    expect(await listStickerPacks('roman')).toEqual([]);
  });

  it('returns false removing a pack that was never added', async () => {
    expect(await removeStickerPack('roman', 'NeverAdded')).toBe(false);
  });
});

// Confirmed live 2026-08-29: the CLI only recognizes an `mcpOAuth` entry
// keyed `<name>|<hash>` — a bare `<name>` key is silently ignored (see
// writeEsputnikCredential's doc comment in nfs.ts for the full story). This
// exact suffix was observed for `https://mcp.esputnik.com` from two
// completely independent sources (different serverName, different
// clientId, different machine) — a pure function of serverUrl alone.
const ESPUTNIK_KEY = 'esputnik-work|909f472c1d8ca133';

describe('writeEsputnikCredential', () => {
  it('creates .credentials.json (and the person dir) when neither exists yet, keyed `<serverKey>|<hash>`', async () => {
    await writeEsputnikCredential('fresh-person', 'esputnik-work', SAMPLE_TOKENS);

    const raw = JSON.parse(await readFile(path.join(dir, 'people', 'fresh-person', 'claude', '.credentials.json'), 'utf8'));
    expect(raw.mcpOAuth[ESPUTNIK_KEY]).toEqual({
      serverName: 'esputnik-work',
      serverUrl: 'https://mcp.esputnik.com',
      ...SAMPLE_TOKENS,
    });
  });

  it('preserves unrelated existing top-level keys and other mcpOAuth entries', async () => {
    const claudeDir = path.join(dir, 'people', 'multi-account', 'claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'main-token' },
        mcpOAuth: { 'esputnik-personal|909f472c1d8ca133': { serverName: 'esputnik-personal', serverUrl: 'https://mcp.esputnik.com' } },
      }),
    );

    await writeEsputnikCredential('multi-account', 'esputnik-work', SAMPLE_TOKENS);

    const raw = JSON.parse(await readFile(path.join(claudeDir, '.credentials.json'), 'utf8'));
    expect(raw.claudeAiOauth).toEqual({ accessToken: 'main-token' });
    expect(raw.mcpOAuth['esputnik-personal|909f472c1d8ca133']).toEqual({
      serverName: 'esputnik-personal',
      serverUrl: 'https://mcp.esputnik.com',
    });
    expect(raw.mcpOAuth[ESPUTNIK_KEY]).toEqual({
      serverName: 'esputnik-work',
      serverUrl: 'https://mcp.esputnik.com',
      ...SAMPLE_TOKENS,
    });
  });

  it('overwrites in place on reconnect — same key, no duplicate, new tokens win', async () => {
    await writeEsputnikCredential('reconnector', 'esputnik-work', SAMPLE_TOKENS);
    const renewedTokens = { ...SAMPLE_TOKENS, accessToken: 'access-2', refreshToken: 'refresh-2' };
    await writeEsputnikCredential('reconnector', 'esputnik-work', renewedTokens);

    const raw = JSON.parse(await readFile(path.join(dir, 'people', 'reconnector', 'claude', '.credentials.json'), 'utf8'));
    expect(Object.keys(raw.mcpOAuth)).toEqual([ESPUTNIK_KEY]);
    expect(raw.mcpOAuth[ESPUTNIK_KEY].accessToken).toBe('access-2');
  });

  it('prunes a stale/bare or wrong-hash entry for the same account before writing (e.g. an SDK-generated broken stub)', async () => {
    const claudeDir = path.join(dir, 'people', 'legacy-key', 'claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({
        mcpOAuth: {
          'esputnik-work': { serverName: 'esputnik-work', serverUrl: 'https://mcp.esputnik.com' },
          'esputnik-work|deadbeef': { serverName: 'esputnik-work', serverUrl: 'https://mcp.esputnik.com', accessToken: '' },
        },
      }),
    );

    await writeEsputnikCredential('legacy-key', 'esputnik-work', SAMPLE_TOKENS);

    const raw = JSON.parse(await readFile(path.join(claudeDir, '.credentials.json'), 'utf8'));
    expect(Object.keys(raw.mcpOAuth)).toEqual([ESPUTNIK_KEY]);
  });
});
