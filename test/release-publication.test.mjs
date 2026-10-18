import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJws, verifyJws } from '../tools/release-catalog.mjs';
import { publishTarget } from '../tools/release-publication.mjs';
import { fixture, artifact, identity, git } from './publication-fixture.mjs';

for (const order of [['linux-x64', 'macos-arm64'], ['macos-arm64', 'linux-x64']]) {
  test(`independent ${order.join(' then ')} preserves the other platform byte-for-byte`, async t => {
    const f = await fixture(t);
    assert.equal((await f.publish(order[0])).status, 'published');
    const firstBytes = f.catalog(order[0]);
    const first = verifyJws(firstBytes, f.publicKey).release;
    assert.equal(f.catalog(order[1]), f.initial);
    assert.equal(f.stable(), order[0] === 'linux-x64' ? firstBytes : f.initial);
    assert.equal(first.build, 22);
    assert.deepEqual(first.artifacts, { [order[0]]: artifact(order[0]) });
    assert.equal((await f.publish(order[0])).status, 'already-published');
    assert.equal(f.builds.length, 1);
    assert.equal((await f.publish(order[0], {
      ...identity,
      sourceCommit: 'c'.repeat(40),
      notes: 'new checkout notes',
    })).status, 'already-published');
    const last = await f.publish(order[1], { ...identity, sourceCommit: 'b'.repeat(40), notes: 'later platform notes' });
    assert.equal(last.status, 'published');
    const published = verifyJws(f.catalog(order[1]), f.publicKey);
    assert.equal(published.release.build, 22);
    assert.equal(f.catalog(order[0]), firstBytes);
    assert.equal(
      published.catalogSequence,
      order[1] === 'linux-x64' ? 7 : 5,
    );
    assert.equal(
      verifyJws(firstBytes, f.publicKey).catalogSequence,
      order[0] === 'linux-x64' ? 7 : 5,
    );
    assert.deepEqual(published.release.artifacts, { [order[1]]: artifact(order[1]) });
    assert.equal(f.stable(), f.catalog('linux-x64'));
    assert.equal(f.builds.length, 2);
  });
}

test('higher release publishes without waiting for an incomplete lower target matrix', async t => {
  const f = await fixture(t);
  await f.publish('linux-x64');
  const next = { ...identity, version: '1.3.6', build: 23 };
  assert.equal((await f.publish('linux-x64', next)).status, 'published');
  assert.deepEqual(verifyJws(f.stable(), f.publicKey).release.artifacts, { 'linux-x64': artifact('linux-x64') });
  assert.equal(verifyJws(f.stable(), f.publicKey).release.build, 23);
  assert.equal((await f.publish('linux-x64')).status, 'superseded');
  assert.equal((await f.publish('macos-arm64')).status, 'published');
  assert.equal(verifyJws(f.catalog('macos-arm64'), f.publicKey).release.build, 22);
  assert.equal(verifyJws(f.catalog('linux-x64'), f.publicKey).release.build, 23);
  assert.equal((await f.publish('macos-arm64', next)).status, 'published');
});

test('bad stored artifact prevents promotion and resumes without rebuilding', async t => {
  const f = await fixture(t);
  await f.publish('linux-x64');
  const before = f.stable();
  let checks = 0;
  await assert.rejects(publishTarget({ ...f.options, identity, target: 'macos-arm64', verifyArtifact: async () => { if (++checks > 1) throw new Error('Stored bytes differ'); } }), /Stored bytes/);
  assert.equal(f.stable(), before);
  await f.publish('macos-arm64');
  assert.equal(f.builds.length, 2);
  assert.equal(verifyJws(f.stable(), f.publicKey).release.build, 22);
});

test('first publication of an unseeded target creates its own catalog', async t => {
  const f = await fixture(t);
  await f.publish('macos-x64', { ...identity, version: '1.3.4', build: 21 });
  const after = verifyJws(f.catalog('macos-x64'), f.publicKey);
  assert.equal(after.catalogSequence, 1);
  assert.deepEqual(after.release.artifacts, { 'macos-x64': artifact('macos-x64') });
  assert.equal(f.stable(), f.initial);
  assert.equal(f.catalog('macos-arm64'), f.initial);
});

test('stable push race recomputes catalog sequence', async t => {
  const f = await fixture(t);
  await f.publish('linux-x64');
  const rival = join(f.root, 'rival');
  git(['clone', '--branch', 'main', f.remote, rival], f.root);
  const before = verifyJws(f.catalog('macos-arm64'), f.publicKey);
  await writeFile(join(rival, 'stable-macos-arm64.jws'), createJws({ ...before, catalogSequence: 6 }, f.signingKey));
  git(['add', '.'], rival); git(['commit', '-m', 'concurrent catalog update'], rival);
  let raced = false;
  const result = await publishTarget({ ...f.options, identity, target: 'macos-arm64', git: args => {
    if (!raced && args[0] === 'push' && args.at(-1) === 'HEAD:main') {
      raced = true;
      git(['push', 'origin', 'HEAD:main'], rival);
    }
    return git(args, f.repo);
  } });
  assert.equal(result.status, 'published');
  assert.equal(verifyJws(f.catalog('macos-arm64'), f.publicKey).catalogSequence, 7);
});

test('parentless receipt refs reject a conflicting second root', async t => {
  const f = await fixture(t);
  await f.publish('linux-x64');
  const ref = 'refs/heads/ready/1.3.5-22/linux-x64';
  const first = git(['rev-parse', ref], f.remote);
  assert.equal(git(['rev-list', '--parents', '-n', '1', ref], f.remote), first);
  const conflicting = await fixture(t);
  await conflicting.publish('linux-x64', { ...identity, notes: 'different' });
  assert.throws(() => git(['push', f.remote, `${ref}:${ref}`], conflicting.remote));
  assert.equal(git(['rev-parse', ref], f.remote), first);
});

test('different-platform push race converges without changing the rival catalog', async t => {
  const f = await fixture(t);
  const rival = join(f.root, 'rival-platform');
  git(['clone', '--branch', 'main', f.remote, rival], f.root);
  let raced = false;
  let checks = 0;
  let macBytes;
  const linux = await publishTarget({ ...f.options, identity, target: 'linux-x64', verifyArtifact: async () => {
    if (++checks === 2 && !raced) {
      raced = true;
      await publishTarget({ ...f.options, repo: rival, git: args => git(args, rival), identity, target: 'macos-arm64' });
      macBytes = f.catalog('macos-arm64');
    }
  } });
  assert.equal(linux.status, 'published');
  assert.equal(f.catalog('macos-arm64'), macBytes);
  assert.equal(f.stable(), f.catalog('linux-x64'));
  for (const target of ['linux-x64', 'macos-arm64']) {
    const catalog = verifyJws(f.catalog(target), f.publicKey);
    assert.equal(catalog.catalogSequence, target === 'linux-x64' ? 7 : 5);
    assert.deepEqual(catalog.release.artifacts, { [target]: artifact(target) });
  }
});

test('uncertain stable push resolves from remote without another build', async t => {
  const f = await fixture(t);
  await f.publish('linux-x64');
  let interrupted = false;
  const result = await publishTarget({ ...f.options, identity, target: 'macos-arm64', git: args => {
    const output = git(args, f.repo);
    if (!interrupted && args[0] === 'push' && args.at(-1) === 'HEAD:main') {
      interrupted = true;
      throw new Error('Connection lost after server accepted push');
    }
    return output;
  } });
  assert.equal(result.status, 'already-published');
  assert.equal(f.builds.length, 2);
  assert.equal(verifyJws(f.stable(), f.publicKey).release.build, 22);
});

test('permanent stable push failure stops after eight attempts with receipt retained', async t => {
  const f = await fixture(t);
  await f.publish('linux-x64');
  const before = f.stable();
  let attempts = 0;
  await assert.rejects(publishTarget({ ...f.options, identity, target: 'macos-arm64', git: args => {
    if (args[0] === 'push' && args.at(-1) === 'HEAD:main') { attempts++; throw new Error('push rejected'); }
    return git(args, f.repo);
  } }), /did not converge/);
  assert.equal(attempts, 8);
  assert.equal(f.stable(), before);
  await f.publish('macos-arm64');
  assert.equal(f.builds.length, 2);
});

test('existing Linux receipt resumes from a newer checkout without rebuilding or changing its metadata', async t => {
  const f = await fixture(t);
  await assert.rejects(publishTarget({ ...f.options, identity, target: 'linux-x64', git: args => {
    if (args[0] === 'push' && args.at(-1) === 'HEAD:main') throw new Error('push rejected');
    return git(args, f.repo);
  } }), /did not converge/);
  assert.equal(f.stable(), f.initial);
  assert.equal((await f.publish('linux-x64', {
    ...identity,
    sourceCommit: 'c'.repeat(40),
    notes: 'notes from the newer checkout',
  })).status, 'published');
  assert.equal(f.builds.length, 1);
  const release = verifyJws(f.stable(), f.publicKey).release;
  assert.equal(release.build, 22);
  assert.equal(release.notes, identity.notes);
  assert.deepEqual(release.artifacts, { 'linux-x64': artifact('linux-x64') });
});

test('Linux repairs a prematurely reset migration sequence using its existing receipt', async t => {
  const f = await fixture(t);
  await f.publish('linux-x64');
  const published = verifyJws(f.catalog('linux-x64'), f.publicKey);
  const reset = createJws({ ...published, catalogSequence: 1 }, f.signingKey);
  git(['checkout', '-B', 'sequence-regression', 'origin/main'], f.repo);
  await writeFile(join(f.repo, 'stable-linux-x64.jws'), reset);
  await writeFile(join(f.repo, 'stable.jws'), reset);
  git(['add', 'stable-linux-x64.jws', 'stable.jws'], f.repo);
  git(['commit', '-m', 'simulate bad migration publication'], f.repo);
  git(['push', 'origin', 'HEAD:main'], f.repo);

  assert.equal((await f.publish('linux-x64')).status, 'published');
  assert.equal(verifyJws(f.stable(), f.publicKey).catalogSequence, 7);
  assert.equal(f.stable(), f.catalog('linux-x64'));
  assert.equal(f.builds.length, 1);
});

for (const conflicting of [false, true]) {
  test(`same-target concurrent receipt ${conflicting ? 'rejects different bytes' : 'accepts identical bytes'}`, async t => {
    const f = await fixture(t);
    const rival = join(f.root, 'rival');
    git(['clone', '--branch', 'main', f.remote, rival], f.root);
    const publish = publishTarget({ ...f.options, identity, target: 'linux-x64', buildTarget: async () => {
      await publishTarget({ ...f.options, repo: rival, git: args => git(args, rival), identity, target: 'linux-x64' });
      return { ...artifact('linux-x64'), ...(conflicting ? { sha256: 'c'.repeat(64) } : {}) };
    } });
    if (conflicting) await assert.rejects(publish, /Conflicting target receipt/);
    else assert.equal((await publish).status, 'already-published');
    assert.deepEqual(verifyJws(f.stable(), f.publicKey).release.artifacts, { 'linux-x64': artifact('linux-x64') });
    await f.publish('linux-x64');
    assert.equal(f.builds.length, 1);
  });
}
