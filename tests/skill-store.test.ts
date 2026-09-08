import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillStore } from '../src/skill-store.js';

interface ZipEntryInput {
  readonly name: string;
  readonly data?: string | Buffer;
  readonly flags?: number;
  readonly externalFileAttributes?: number;
  readonly declaredSize?: number;
  readonly versionMadeBy?: number;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries: readonly ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const declaredSize = entry.declaredSize ?? data.length;
    const flags = entry.flags ?? 0;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(declaredSize, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, name, data]);
    localParts.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(declaredSize, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.externalFileAttributes ?? 0) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(Buffer.concat([central, name]));
    localOffset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function createSkillPackage(
  parent: string,
  name: string,
  version: string,
  referenceText = 'safe reference'
): Promise<string> {
  const root = path.join(parent, name);
  await mkdir(path.join(root, 'references'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(
    path.join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Safely review a DeskMCP change.\nlicense: Apache-2.0\ncompatibility: DeskMCP\nallowed-tools: desktop_read_file desktop_search\nmetadata:\n  version: "${version}"\n  owner: "test"\n---\n\n# ${name}\n\nRead references/checklist.md before acting.\n`,
    'utf8'
  );
  await writeFile(path.join(root, 'references', 'checklist.md'), `${referenceText}\n`, 'utf8');
  await writeFile(path.join(root, 'scripts', 'not-auto-run.ps1'), 'throw "must never auto-run"\n', 'utf8');
  return root;
}

async function withStore(run: (store: SkillStore, root: string, scratch: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'deskmcp-skill-store-'));
  const root = path.join(scratch, 'state');
  const store = new SkillStore(root);
  await store.init();
  try {
    await run(store, root, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('SkillStore validates, installs, reads, versions, activates, and rolls back immutable local Skills', async () => {
  await withStore(async (store, _root, scratch) => {
    const v1 = await createSkillPackage(path.join(scratch, 'v1'), 'review-safe', '1.0.0', 'v1 checklist');
    const validation = await store.validate({ kind: 'local', path: v1 });
    assert.equal(validation.metadata.name, 'review-safe');
    assert.equal(validation.declared_version, '1.0.0');
    assert.equal(validation.files.includes('scripts/not-auto-run.ps1'), true);

    const first = await store.install({ kind: 'local', path: v1 });
    assert.equal(first.already_installed, false);
    assert.equal(first.activated, true);
    assert.equal(first.skill.active_version_id, first.installed_version.version_id);

    const resource = await store.read('review-safe', 'references/checklist.md');
    assert.equal(resource.content, 'v1 checklist\n');

    const duplicate = await store.install({ kind: 'local', path: v1 });
    assert.equal(duplicate.already_installed, true);
    assert.equal(duplicate.installed_version.version_id, first.installed_version.version_id);

    const mutable = await createSkillPackage(path.join(scratch, 'mutable'), 'review-safe', '1.0.0', 'changed under same version');
    await assert.rejects(
      store.install({ kind: 'local', path: mutable }),
      /already installed with a different digest/i
    );

    const v2 = await createSkillPackage(path.join(scratch, 'v2'), 'review-safe', '2.0.0', 'v2 checklist');
    const second = await store.install({ kind: 'local', path: v2 });
    assert.equal(second.skill.active_version_id, second.installed_version.version_id);
    assert.equal(second.skill.previous_active_version_id, first.installed_version.version_id);

    const rolledBack = await store.rollback('review-safe');
    assert.equal(rolledBack.active_version_id, first.installed_version.version_id);
    const activated = await store.activate('review-safe', '2.0.0');
    assert.equal(activated.active_version_id, second.installed_version.version_id);
  });
});

test('SkillStore accepts a bounded ZIP with exactly one top-level Skill directory', async () => {
  await withStore(async (store, _root, scratch) => {
    const skillMd = '---\nname: zip-skill\ndescription: ZIP packaged Skill.\nmetadata:\n  version: "1.0.0"\n---\n\n# ZIP Skill\n';
    const zipPath = path.join(scratch, 'skill.zip');
    await writeFile(zipPath, buildStoredZip([
      { name: 'zip-skill/' },
      { name: 'zip-skill/SKILL.md', data: skillMd },
      { name: 'zip-skill/references/' },
      { name: 'zip-skill/references/note.md', data: 'zip reference\n' }
    ]));

    const validation = await store.validate({ kind: 'local', path: zipPath });
    assert.equal(validation.metadata.name, 'zip-skill');
    const installed = await store.install({ kind: 'local', path: zipPath });
    assert.equal(installed.skill.name, 'zip-skill');
    const note = await store.read('zip-skill', 'references/note.md');
    assert.equal(note.content, 'zip reference\n');
  });
});

test('SkillStore accepts a ZIP whose SKILL.md is directly at archive root without treating the staging directory as the Skill name', async () => {
  await withStore(async (store, _root, scratch) => {
    const skillMd = '---\nname: root-zip-skill\ndescription: Root ZIP packaged Skill.\nmetadata:\n  version: "1.0.0"\n---\n\n# Root ZIP Skill\n';
    const zipPath = path.join(scratch, 'root-skill.zip');
    await writeFile(zipPath, buildStoredZip([
      { name: 'SKILL.md', data: skillMd },
      { name: 'references/' },
      { name: 'references/note.md', data: 'root zip reference\n' }
    ]));

    const validation = await store.validate({ kind: 'local', path: zipPath });
    assert.equal(validation.metadata.name, 'root-zip-skill');
    const installed = await store.install({ kind: 'local', path: zipPath });
    assert.equal(installed.skill.name, 'root-zip-skill');
    const note = await store.read('root-zip-skill', 'references/note.md');
    assert.equal(note.content, 'root zip reference\n');
  });
});

test('SkillStore rejects ZIP traversal, symlink, encrypted, Windows-unsafe, and oversized entries', async () => {
  await withStore(async (store, _root, scratch) => {
    const cases: Array<{ name: string; entries: ZipEntryInput[]; pattern: RegExp }> = [
      {
        name: 'traversal',
        entries: [{ name: '../escape.txt', data: 'escape' }],
        pattern: /unsafe path segment|safe relative package path/i
      },
      {
        name: 'symlink',
        entries: [{ name: 'link', data: 'target', externalFileAttributes: (0o120777 << 16) >>> 0 }],
        pattern: /symbolic link/i
      },
      {
        name: 'encrypted',
        entries: [{ name: 'secret.txt', data: 'secret', flags: 0x1 }],
        pattern: /encrypted entry/i
      },
      {
        name: 'ads',
        entries: [{ name: 'refs/note.md:evil', data: 'ads' }],
        pattern: /unsafe on Windows/i
      },
      {
        name: 'device',
        entries: [{ name: 'CON.txt', data: 'device' }],
        pattern: /reserved Windows device/i
      },
      {
        name: 'oversized',
        entries: [{ name: 'huge.bin', data: '', declaredSize: 8 * 1024 * 1024 + 1 }],
        pattern: /exceeds .* bytes/i
      }
    ];

    for (const item of cases) {
      const zipPath = path.join(scratch, `${item.name}.zip`);
      await writeFile(zipPath, buildStoredZip(item.entries));
      await assert.rejects(store.validate({ kind: 'local', path: zipPath }), item.pattern, item.name);
    }
  });
});

test('SkillStore rejects a local ZIP checksum mismatch before extraction', async () => {
  await withStore(async (store, _root, scratch) => {
    const zipPath = path.join(scratch, 'checksum.zip');
    await writeFile(zipPath, buildStoredZip([{ name: 'file.txt', data: 'hello' }]));
    await assert.rejects(
      store.validate({ kind: 'local', path: zipPath, expected_sha256: '0'.repeat(64) }),
      /SHA-256 mismatch/i
    );
  });
});

test('SkillStore rejects tampered registry version ids that do not match persisted digests', async () => {
  await withStore(async (store, root, scratch) => {
    const skillRoot = await createSkillPackage(path.join(scratch, 'pkg'), 'registry-safe', '1.0.0');
    await store.install({ kind: 'local', path: skillRoot });
    const registryPath = path.join(root, 'registry.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
      skills: Array<{ active_version_id?: string; versions: Array<{ version_id: string }> }>;
    };
    registry.skills[0]!.versions[0]!.version_id = 'sha256-0000000000000000';
    registry.skills[0]!.active_version_id = 'sha256-0000000000000000';
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

    const reopened = new SkillStore(root);
    await assert.rejects(reopened.init(), /invalid version entry/i);
  });
});
