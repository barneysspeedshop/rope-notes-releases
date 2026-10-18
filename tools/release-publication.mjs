import { sign, verify } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createJws, verifyJws, validateCatalog, DEFAULT_KEY_ID, TARGETS } from './release-catalog.mjs';

const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'rope-notes-target+jws', kid: DEFAULT_KEY_ID })).toString('base64url');
const refFor = r => `refs/heads/ready/${r.version}-${r.build}/${r.target}`;
const sameRelease = (a, b) => a && b && a.version === b.version && a.build === b.build;
const sequenceFloorFor = target => target === 'linux-x64' ? 6 : 0;
const versionCompare = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return Math.sign(x[0] - y[0]) || Math.sign(x[1] - y[1]) || Math.sign(x[2] - y[2]);
};

function validateReceipt(r) {
  if (!r || Object.keys(r).sort().join() !== 'artifact,build,notes,sourceCommit,target,version' ||
      !/^[0-9a-f]{40,64}$/.test(r.sourceCommit) || !TARGETS.includes(r.target)) throw new Error('Invalid target receipt');
  validateCatalog({ schemaVersion: 1, channel: 'stable', catalogSequence: 1, release: {
    id: `rope-notes-${r.version}-${r.build}`, version: r.version, build: r.build,
    publishedAt: '2026-01-01T00:00:00Z', notes: r.notes, artifacts: { [r.target]: r.artifact },
  } });
  return r;
}

function signReceipt(r, key) {
  validateReceipt(r);
  const input = `${header}.${Buffer.from(JSON.stringify(r)).toString('base64url')}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}

function readReceipt(text, key) {
  const parts = text.trim().split('.');
  if (parts.length !== 3 || parts[0] !== header || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p) || Buffer.from(p, 'base64url').toString('base64url') !== p) ||
      !verify(null, Buffer.from(parts.slice(0, 2).join('.')), key, Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid receipt signature');
  return validateReceipt(JSON.parse(Buffer.from(parts[1], 'base64url')));
}

export function catalogFileFor(target) {
  if (!TARGETS.includes(target)) throw new Error(`Unsupported release target: ${target}`);
  return { target, primaryPath: `stable-${target}.jws`, legacyAliases: target === 'linux-x64' ? ['stable.jws'] : [] };
}

export async function publishTarget({ repo, git, identity, target, catalogFile = catalogFileFor(target), signingKey, publicKey, buildTarget, verifyArtifact }) {
  if (!isDeepStrictEqual(catalogFile, catalogFileFor(target))) throw new Error('Catalog paths must belong to the publishing target');
  const read = () => {
    git(['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main', 'refs/heads/ready/*:refs/remotes/origin/ready/*']);
    const exists = git(['ls-tree', '--name-only', 'origin/main', '--', catalogFile.primaryPath]);
    const catalog = exists ? verifyJws(git(['show', `origin/main:${catalogFile.primaryPath}`]), publicKey, { keyId: DEFAULT_KEY_ID })
      : { schemaVersion: 1, channel: 'stable', catalogSequence: 0, release: null };
    const refs = git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/ready/']).split('\n').filter(ref => ref.endsWith(`/${target}`));
    const receipts = refs.map(ref => {
      const receipt = readReceipt(git(['show', `${ref}:receipt.jws`]), publicKey);
      if (ref.replace('refs/remotes/origin/', 'refs/heads/') !== refFor(receipt)) throw new Error('Receipt ref identity mismatch');
      if (git(['rev-list', '--parents', '-n', '1', ref]).split(' ').length !== 1) throw new Error('Receipt must be parentless');
      return receipt;
    });
    return { catalog, receipts };
  };
  let state = read();
  if (state.receipts.some(r => r.build === identity.build && r.version !== identity.version)) throw new Error('Conflicting staged versions share a build');
  const own = () => state.receipts.find(r => sameRelease(r, identity) && r.target === target);
  let receipt = own();
  const resumedReceipt = Boolean(receipt &&
    (receipt.sourceCommit !== identity.sourceCommit || receipt.notes !== identity.notes));
  if (receipt) await verifyArtifact(receipt.artifact);
  const stable = state.catalog.release;
  if (!receipt && stable && (identity.build < stable.build || versionCompare(identity.version, stable.version) < 0 || (identity.build === stable.build && !sameRelease(identity, stable)))) throw new Error('Release must advance stable version/build');
  if (!receipt && sameRelease(identity, stable) && stable.artifacts[target]) throw new Error('Target already published without a receipt; increase version/build');
  if (!receipt) {
    receipt = validateReceipt({ ...identity, target, artifact: await buildTarget(target) });
    await verifyArtifact(receipt.artifact);
    await writeFile(join(repo, 'receipt.jws'), signReceipt(receipt, signingKey));
    git(['read-tree', '--empty']);
    git(['add', '--', 'receipt.jws']);
    const tree = git(['write-tree']);
    const commit = git(['commit-tree', tree, '-m', `Ready ${target} ${identity.version}+${identity.build}`]);
    git(['reset', '--mixed', 'HEAD']);
    await unlink(join(repo, 'receipt.jws'));
    let pushError;
    try { git(['push', 'origin', `${commit}:${refFor(receipt)}`]); } catch (error) { pushError = error; }
    state = read();
    if (!own()) throw pushError ?? new Error('Receipt was not recorded');
    if (!isDeepStrictEqual(own(), receipt)) throw new Error('Conflicting target receipt; immutable ref was not changed');
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    state = read();
    const current = state.catalog.release;
    const sequenceFloor = sequenceFloorFor(target);
    if (current && current.build > identity.build) {
      return { status: 'superseded', stable: current, resumedReceipt };
    }
    if (sameRelease(current, receipt)) {
      if (!isDeepStrictEqual(current.artifacts[target], receipt.artifact)) throw new Error('Receipt conflicts with published artifact');
      if (state.catalog.catalogSequence > sequenceFloor) {
        return { status: 'already-published', stable: current, resumedReceipt };
      }
    }
    if (current && !sameRelease(current, receipt) &&
        (identity.build <= current.build || versionCompare(identity.version, current.version) < 0)) {
      throw new Error('Release must advance stable version/build');
    }
    const candidate = { id: `rope-notes-${receipt.version}-${receipt.build}`, version: receipt.version, build: receipt.build,
      publishedAt: new Date().toISOString(), notes: receipt.notes, artifacts: { [target]: receipt.artifact } };
    await verifyArtifact(receipt.artifact);
    const catalog = {
      ...state.catalog,
      catalogSequence: Math.max(state.catalog.catalogSequence, sequenceFloor) + 1,
      release: candidate,
    };
    git(['checkout', '-B', 'publication', 'origin/main']);
    const paths = [catalogFile.primaryPath, ...catalogFile.legacyAliases];
    const signed = `${createJws(catalog, signingKey)}\n`;
    for (const path of paths) await writeFile(join(repo, path), signed);
    git(['add', '--', ...paths]);
    git(['commit', '-m', `Publish ${target} ${candidate.version}+${candidate.build}`]);
    try {
      git(['push', 'origin', 'HEAD:main']);
      if (sameRelease(candidate, identity)) {
        state = read();
        return {
          status: 'published', catalogSequence: catalog.catalogSequence,
          stable: state.catalog.release, resumedReceipt,
        };
      }
    } catch (error) {
      if (attempt === 7) throw new Error(`Catalog contention did not converge: ${error.message}`);
    }
  }
  throw new Error('Catalog reconciliation exceeded eight attempts; retry to resume');
}
