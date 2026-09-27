import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CATALOG_HEADER,
  buildCatalog,
  buildRelease,
  command,
  createJws,
  decodeBase64Url,
  hashArtifact,
  parseJws,
  validateCatalog,
  verifyJws,
} from '../tools/release-catalog.mjs';

const publicPem = await readFile(new URL('../release-signing-public.pem', import.meta.url));
const stableJws = (await readFile(new URL('../stable.jws', import.meta.url), 'utf8')).trim();

test('the committed empty catalog is a valid cross-runtime vector', () => {
  const payload = verifyJws(stableJws, publicPem);
  assert.deepEqual(payload, {
    schemaVersion: 1,
    channel: 'stable',
    catalogSequence: 1,
    release: null,
  });
  assert.equal(parseJws(stableJws).header.kid, 'release-2026-09');
});

test('JWS serialization is deterministic for a generated key', () => {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' });
  const payload = {
    schemaVersion: 1,
    channel: 'stable',
    catalogSequence: 7,
    release: null,
  };
  const first = createJws(payload, privatePem);
  const second = createJws(payload, privatePem);
  assert.equal(first, second);
  assert.deepEqual(verifyJws(first, publicKey), payload);
});

test('header mutations, unknown keys, and noncanonical segments fail', async () => {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' });
  const payload = await buildCatalog({ sequence: 2 });
  const valid = createJws(payload, privatePem);
  const [header, body, signature] = valid.split('.');
  const mutatedHeader = Buffer.from(JSON.stringify({ ...CATALOG_HEADER, extra: true })).toString('base64url');
  const unknownKid = Buffer.from(JSON.stringify({ ...CATALOG_HEADER, kid: 'other' })).toString('base64url');
  assert.throws(() => verifyJws(`${mutatedHeader}.${body}.${signature}`, publicKey), /header/);
  assert.throws(
    () => verifyJws(`${unknownKid}.${body}.${signature}`, publicKey, { keyId: CATALOG_HEADER.kid }),
    /key ID/,
  );
  assert.throws(() => verifyJws(`${header}=.${body}.${signature}`, publicKey), /base64url/);
  assert.throws(() => verifyJws(`${header}.${body}.${signature}=`, publicKey), /base64url/);
});

test('payload and signature mutations fail verification', async () => {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' });
  const valid = createJws(await buildCatalog({ sequence: 2 }), privatePem);
  const [header, body, signature] = valid.split('.');
  const payload = JSON.parse(decodeBase64Url(body).toString('utf8'));
  payload.catalogSequence = 3;
  const mutatedBody = Buffer.from(JSON.stringify(payload)).toString('base64url');
  assert.throws(() => verifyJws(`${header}.${mutatedBody}.${signature}`, publicKey), /signature mismatch/);

  const mutatedSignature = decodeBase64Url(signature);
  mutatedSignature[0] ^= 1;
  assert.throws(
    () => verifyJws(`${header}.${body}.${mutatedSignature.toString('base64url')}`, publicKey),
    /signature mismatch/,
  );
});

test('key IDs support rotation but must match the selected verification key', async () => {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' });
  const payload = await buildCatalog({ sequence: 2 });
  const rotated = createJws(payload, privatePem, 'release-2027-01');
  assert.deepEqual(
    verifyJws(rotated, publicKey, { keyId: 'release-2027-01' }),
    payload,
  );
  assert.throws(
    () => verifyJws(rotated, publicKey, { keyId: 'release-2026-09' }),
    /unexpected JWS key ID/,
  );
});

test('artifact metadata is computed and target extensions are enforced', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rope-catalog-'));
  const file = join(directory, 'RopeNotes.AppImage');
  await writeFile(file, Buffer.from('artifact bytes'));
  const metadata = await hashArtifact(file);
  assert.equal(metadata.size, 14);
  assert.equal(metadata.sha256, '4659fc0570122b0e0aa14f4ff7c261b1fe51795a01ba79963f462ebf40d7520d');
  const catalog = await buildRelease({
    sequence: 3,
    id: '2026.09.27',
    version: '1.4.0',
    build: 42,
    publishedAt: '2026-09-27T12:00:00Z',
    artifacts: { 'linux-x64': file },
  });
  assert.equal(catalog.release.artifacts['linux-x64'].filename, 'RopeNotes.AppImage');
  await assert.rejects(
    buildRelease({
      sequence: 4,
      id: '2026.09.28',
      version: '1.4.1',
      build: 43,
      publishedAt: '2026-09-28T12:00:00Z',
      artifacts: { 'linux-x64': { path: file, filename: 'RopeNotes.zip' } },
    }),
    /AppImages/,
  );
});

test('empty catalog and payload shape are validated', async () => {
  assert.deepEqual(await buildCatalog({ sequence: 1 }), {
    schemaVersion: 1,
    channel: 'stable',
    catalogSequence: 1,
    release: null,
  });
  assert.throws(() => validateCatalog({ schemaVersion: 1, channel: 'stable', catalogSequence: 0, release: null }));
  assert.throws(() => decodeBase64Url('abc='));
});

test('key generation refuses to overwrite either key file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rope-catalog-cli-'));
  const privatePath = join(directory, 'private.pem');
  const publicPath = join(directory, 'public.pem');
  await writeFile(privatePath, 'keep-private');
  await writeFile(publicPath, 'keep-public');
  await assert.rejects(
    command([
      'keygen',
      '--private-key', privatePath,
      '--public-key', publicPath,
    ]),
    /refusing to overwrite/,
  );
  assert.equal(await readFile(privatePath, 'utf8'), 'keep-private');
  assert.equal(await readFile(publicPath, 'utf8'), 'keep-public');
});
