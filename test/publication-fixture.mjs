import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJws } from '../tools/release-catalog.mjs';
import { publishTarget } from '../tools/release-publication.mjs';

export function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
export const artifact = target => ({ filename: target === 'linux-x64' ? 'Rope.AppImage' : 'Rope.dmg', size: 1, sha256: (target === 'linux-x64' ? 'a' : 'b').repeat(64) });
export const identity = { version: '1.3.5', build: 22, sourceCommit: 'a'.repeat(40), notes: 'release' };

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rope-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  git(['init', '--bare', remote], root);
  const repo = join(root, 'publisher');
  git(['clone', remote, repo], root);
  git(['checkout', '-b', 'main'], repo);
  const pair = generateKeyPairSync('ed25519');
  const signingKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const initial = createJws({ schemaVersion: 1, channel: 'stable', catalogSequence: 4, release: { id: 'old', version: '1.3.4', build: 21, publishedAt: '2026-01-01T00:00:00Z', notes: 'old', artifacts: Object.fromEntries(['linux-x64', 'macos-arm64'].map(t => [t, artifact(t)])) } }, signingKey);
  await writeFile(join(repo, 'stable.jws'), initial);
  for (const target of ['linux-x64', 'macos-arm64']) await writeFile(join(repo, `stable-${target}.jws`), initial);
  git(['add', '.'], repo); git(['commit', '-m', 'seed'], repo); git(['push', 'origin', 'HEAD:main'], repo);
  const builds = [];
  const options = { repo, git: args => git(args, repo), signingKey, publicKey, verifyArtifact: async () => {}, buildTarget: async target => { builds.push(target); return artifact(target); } };
  return { root, remote, repo, initial, publicKey, signingKey, options, builds,
    publish: (target, release = identity) => publishTarget({ ...options, identity: release, target }),
    stable: () => git(['show', 'refs/heads/main:stable.jws'], remote),
    catalog: target => git(['show', `refs/heads/main:stable-${target}.jws`], remote),
  };
}
