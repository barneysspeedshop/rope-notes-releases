import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicKey } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseVersion, publishDesktop } from '../tools/publish-linux.mjs';
import { fixture, git } from './publication-fixture.mjs';

test('release version comes from pubspec and requires an increasing build', () => {
  const previous = { version: '1.3.3', build: 20 };
  assert.deepEqual(releaseVersion('version: 1.3.4+21', previous), { version: '1.3.4', build: 21 });
  for (const value of ['1.3.3+20', '1.3.4+20', '1.3.2+21', '1.3.4', 'garbage']) assert.throws(() => releaseVersion(`version: ${value}`, previous));
});

for (const mode of ['linux', 'macos', 'corrupt upload', 'dirty source', 'check', 'stale macOS version']) {
  test(`native publisher: ${mode}`, async t => {
    const f = await fixture(t);
    const app = join(f.root, 'app');
    await mkdir(join(app, 'build/macos'), { recursive: true });
    await mkdir(join(app, 'lib/services'), { recursive: true });
    const rawKey = createPublicKey(f.publicKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    await writeFile(join(app, 'lib/services/release_catalog_public_key.dart'), `'release-2026-09': '${rawKey}'`);
    await writeFile(join(app, 'pubspec.yaml'), 'version: 1.3.5+22\n');
    const privateKey = join(f.root, 'private.pem'), publicKeyFile = join(f.root, 'public.pem');
    await writeFile(privateKey, f.signingKey);
    await writeFile(publicKeyFile, f.publicKey);
    await writeFile(join(f.root, 'stable.jws'), f.initial);
    await writeFile(join(f.root, 'stable-linux-x64.jws'), f.initial);
    const objects = new Map(), events = [];
    let appCommit = 'a'.repeat(40);
    const execute = (command, args, cwd) => {
      assert.ok(!(command === 'npx' && args.includes('delete')), 'publisher must preserve existing R2 objects');
      if (command === 'git') {
        if (cwd === app) {
          if (args[0] === 'status') return mode === 'dirty source' ? ' M pubspec.yaml' : '';
          if (args[0] === 'submodule') return '';
          if (args[0] === 'rev-parse') return appCommit;
        }
        if (args[0] === 'clone') args = [...args.slice(0, -2), f.remote, args.at(-1)];
        return git(args, cwd);
      }
      if (command === 'bash') {
        events.push('build');
        writeFileSync(join(app, 'Rope_Notes-x86_64.AppImage'), 'linux binary');
        writeFileSync(join(app, 'build/macos/RopeNotes-Direct.dmg'), 'mac binary');
      }
      if (command.endsWith('PlistBuddy')) return args[1].includes('ShortVersion') ? (mode === 'stale macOS version' ? '1.3.4' : '1.3.5') : args[1].includes('BundleVersion') ? '22' : 'Rope Notes';
      if (command === 'npx' && args.includes('put')) {
        events.push('upload');
        objects.set(args[5], readFileSync(args.find(a => a.startsWith('--file=')).slice(7)));
      }
      if (command === 'npx' && args.includes('get')) {
        events.push('verify');
        const bytes = objects.get(args[5]);
        assert.ok(bytes, 'publisher verifies the uploaded object');
        writeFileSync(args.find(a => a.startsWith('--file=')).slice(7), mode === 'corrupt upload' ? 'corrupt' : bytes);
      }
      return '';
    };
    const mac = mode === 'macos' || mode === 'stale macOS version';
    const options = { app, site: f.root, privateKey, publicKeyFile, notes: 'release', platform: mac ? 'macos' : 'linux', check: mode === 'check' };
    const call = () => publishDesktop(options, execute, { platform: mac ? 'darwin' : 'linux', arch: mac ? 'arm64' : 'x64' });
    if (['corrupt upload', 'dirty source', 'stale macOS version'].includes(mode)) {
      await assert.rejects(call(), mode === 'corrupt upload' ? /verification/ : mode === 'dirty source' ? /uncommitted/ : /version does not match/);
      assert.equal(f.stable(), f.initial);
    } else if (mode === 'check') {
      assert.equal((await call()).status, 'checked');
      assert.deepEqual(events, []);
    } else {
      assert.equal((await call()).status, 'published');
      assert.notEqual(f.catalog(mac ? 'macos-arm64' : 'linux-x64'), f.initial);
      assert.equal(f.catalog(mac ? 'linux-x64' : 'macos-arm64'), f.initial);
      assert.equal(f.stable(), mac ? f.initial : f.catalog('linux-x64'));
      appCommit = 'c'.repeat(40);
      options.notes = 'notes from a newer checkout';
      assert.equal((await call()).status, 'already-published');
      assert.deepEqual(events, ['build', 'upload', 'verify', 'verify', 'verify']);
    }
  });
}
