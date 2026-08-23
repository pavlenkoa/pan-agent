import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// nfs.ts reads NFS_MOUNT_PATH into a module-level const at import time, so it
// has to be set before the (dynamic) first import — plain top-level `import`
// would run too early to see this test file's tmpdir.
let dir: string;
let listMemoryFiles: typeof import('./nfs.js').listMemoryFiles;
let deleteMemoryFile: typeof import('./nfs.js').deleteMemoryFile;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pan-agent-nfs-'));
  process.env['NFS_MOUNT_PATH'] = dir;
  const mod = await import('./nfs.js');
  listMemoryFiles = mod.listMemoryFiles;
  deleteMemoryFile = mod.deleteMemoryFile;
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
});
