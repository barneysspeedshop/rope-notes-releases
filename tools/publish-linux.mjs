#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicKey } from 'node:crypto';
import { catalogFileFor, publishTarget } from './release-publication.mjs';
import {
  buildRelease, hashArtifact, verifyJws, DEFAULT_KEY_ID,
} from './release-catalog.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = '/home/patrick/IdeaProjects/rope';
const remote = 'https://github.com/barneysspeedshop/rope-notes-releases.git';

export function releaseVersion(pubspec, previous) {
  const match = pubspec.match(/^version:\s*(\d+\.\d+\.\d+)\+(\d+)\s*$/m);
  if (!match) throw new Error('pubspec.yaml must contain version: major.minor.patch+build');
  const version = match[1];
  const build = Number(match[2]);
  if (!Number.isSafeInteger(build)) throw new Error('Invalid build number');
  if (previous) {
    const next = version.split('.').map(Number);
    const old = previous.version.split('.').map(Number);
    let comparison = 0;
    for (let i = 0; i < 3 && comparison === 0; i++) comparison = Math.sign(next[i] - old[i]);
    if (comparison < 0 || build <= previous.build) {
      throw new Error(`Bump pubspec.yaml above published ${previous.version}+${previous.build}; build must increase`);
    }
  }
  return { version, build };
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ROPE_REDUCED_TOOL_ROSTER: 'false' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed${capture ? `: ${result.stderr || ''}` : ''}`);
  }
  return (result.stdout || '').trim();
}

export async function publishLinux(options, execute = run) {
  return publishDesktop(options, execute);
}

export async function publishDesktop({ app, site, privateKey, notes, platform = 'linux', check = false, publicKeyFile = join(repository, 'release-signing-public.pem') }, execute = run, host = process) {
  const mac = platform === 'macos';
  if (host.platform !== (mac ? 'darwin' : 'linux') || !(mac ? ['arm64', 'x64'] : ['x64']).includes(host.arch)) {
    throw new Error(mac ? 'This publisher requires macOS arm64 or x64' : 'This publisher requires Linux x86_64');
  }
  const target = mac ? `macos-${host.arch}` : 'linux-x64';
  const catalogFile = catalogFileFor(target);
  const label = mac ? 'macOS' : 'Linux';
  const filename = mac ? 'RopeNotes-Direct.dmg' : 'Rope_Notes.AppImage';
  const git = (args, cwd = app, capture = true) => execute('git', args, cwd, capture);
  const clean = () => {
    if (git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'])) {
      throw new Error('App checkout has uncommitted changes. Commit or stash them before publishing.');
    }
    if (git(['submodule', 'status', '--recursive']).split('\n').some(line => /^[+U-]/.test(line))) {
      throw new Error('Initialize submodules at their committed revisions before publishing');
    }
  };
  clean();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const pubspec = await readFile(join(app, 'pubspec.yaml'), 'utf8');
  const publicKey = await readFile(publicKeyFile);
  const signingKey = await readFile(privateKey);
  if (!createPublicKey(signingKey).export({ type: 'spki', format: 'der' }).equals(
    createPublicKey(publicKey).export({ type: 'spki', format: 'der' }),
  )) throw new Error('Private signing key does not match the published public key');
  const embeddedKeys = await readFile(join(app, 'lib/services/release_catalog_public_key.dart'), 'utf8');
  const rawKey = createPublicKey(publicKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  if (!embeddedKeys.includes(`'${DEFAULT_KEY_ID}': '${rawKey}'`)) throw new Error('Release public key does not match the app');

  execute('gh', ['auth', 'status'], repository);
  execute('npx', ['--yes', 'wrangler@4.142.0', 'whoami'], site);
  execute('npm', ['test'], repository);
  if (check) {
    for (const path of [catalogFile.primaryPath, ...catalogFile.legacyAliases]) {
      verifyJws(await readFile(join(dirname(publicKeyFile), path), 'utf8'), publicKey, { keyId: DEFAULT_KEY_ID });
    }
    console.log('Publisher prerequisites checked.');
    return { status: 'checked' };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'rope-linux-release-'));
  try {
    const catalogRepo = join(temporary, 'catalog');
    git(['clone', '--single-branch', '--branch', 'main', remote, catalogRepo], repository, false);
    const { version, build } = releaseVersion(pubspec);
    const verifyArtifact = async metadata => {
      const object = `rope-notes-releases/artifacts/sha256/${metadata.sha256}`;
      const uploaded = join(temporary, `verified-${metadata.sha256}`);
      await rm(uploaded, { force: true });
      execute('npx', ['--yes', 'wrangler@4.142.0', 'r2', 'object', 'get', object, `--file=${uploaded}`, '--remote'], site);
      const checked = await hashArtifact(uploaded);
      if (checked.size !== metadata.size || checked.sha256 !== metadata.sha256) throw new Error('Uploaded artifact failed verification; catalog has not been published');
    };
    const result = await publishTarget({
      repo: catalogRepo, git: args => git(args, catalogRepo), signingKey, publicKey,
      identity: { version, build, sourceCommit, notes }, target, catalogFile, verifyArtifact,
      buildTarget: async () => {
        console.log(`Building production ${version}+${build} from ${sourceCommit}`);
        execute('bash', [mac ? './macos/scripts/build_direct_notarized.sh' : './scripts/build_release_appimage.sh'], app);
        if (mac) {
          const bundle = join(app, 'build/macos_direct_dd/Build/Products/DirectRelease/Rope Notes.app');
          const executable = execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(bundle, 'Contents/Info.plist')], app, true);
          execute('lipo', ['-verify_arch', host.arch === 'arm64' ? 'arm64' : 'x86_64', join(bundle, 'Contents/MacOS', executable)], app);
          const bundleVersion = execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(bundle, 'Contents/Info.plist')], app, true);
          const bundleBuild = execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', join(bundle, 'Contents/Info.plist')], app, true);
          if (bundleVersion !== version || bundleBuild !== String(build)) throw new Error('Built macOS bundle version does not match pubspec.yaml');
          execute('xcrun', ['stapler', 'validate', join(app, 'build/macos/RopeNotes-Direct.dmg')], app);
        }
        clean();
        if (git(['rev-parse', 'HEAD']) !== sourceCommit || await readFile(join(app, 'pubspec.yaml'), 'utf8') !== pubspec) {
          throw new Error('Source changed during the build. Start again from a stable checkout.');
        }
        const artifact = join(temporary, filename);
        await copyFile(join(app, mac ? 'build/macos/RopeNotes-Direct.dmg' : 'Rope_Notes-x86_64.AppImage'), artifact);
        const catalog = await buildRelease({
          sequence: 1,
          id: `rope-notes-${version}-${build}`, version, build,
          publishedAt: new Date().toISOString(), notes,
          artifacts: { [target]: artifact },
        });
        const metadata = catalog.release.artifacts[target];
        const object = `rope-notes-releases/artifacts/sha256/${metadata.sha256}`;
        execute('npx', ['--yes', 'wrangler@4.142.0', 'r2', 'object', 'put', object, `--file=${artifact}`, '--remote'], site);
        return metadata;
      },
    });
    if (result.resumedReceipt) {
      console.log(`Reused the existing signed ${target} receipt; no rebuild or metadata replacement was needed.`);
    }
    console.log(result.status === 'superseded' ? `${version}+${build} is superseded by stable ${result.stable.version}+${result.stable.build}.`
      : `${result.status === 'published' ? 'Published' : 'Already published'} ${version}+${build}. Update checks will see it when GitHub raw-content caches refresh.`);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = { app: join(workspace, 'rope_notes'), site: join(workspace, 'ropenotes-site') };
  try {
    if (args.includes('--help')) {
      console.log('Usage: node tools/publish-linux.mjs --private-key PATH --notes TEXT [--app PATH] [--site PATH] [--check]\nPublishes the committed app version to the Linux catalog and legacy stable alias.');
    } else {
      for (let i = 0; i < args.length; i += 2) {
        if (args[i] === '--check') { options.check = true; i--; continue; }
        const key = { '--app': 'app', '--site': 'site', '--private-key': 'privateKey', '--notes': 'notes' }[args[i]];
        if (!key || !args[i + 1]) throw new Error(`Unknown option or missing value: ${args[i]}`);
        options[key] = args[i + 1];
      }
      if (!options.privateKey || !options.notes) throw new Error('--private-key and --notes are required; use --help');
      await publishLinux(options);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
