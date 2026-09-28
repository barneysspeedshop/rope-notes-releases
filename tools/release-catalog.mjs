#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_KEY_ID = 'release-2026-09';
export const CATALOG_HEADER = Object.freeze(catalogHeader(DEFAULT_KEY_ID));
export const TARGETS = Object.freeze(['linux-x64', 'macos-arm64', 'macos-x64']);
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PUBLIC_KEY = resolve(REPOSITORY_ROOT, 'release-signing-public.pem');

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function catalogHeader(keyId) {
  if (typeof keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(keyId)) {
    fail('invalid key ID');
  }
  return { alg: 'EdDSA', typ: 'rope-notes-release+jws', kid: keyId };
}

export function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    fail('noncanonical base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (encodeBase64Url(bytes) !== value) fail('noncanonical base64url');
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail(`invalid ${label} JSON`);
  }
}

function validateHeader(value) {
  if (!isRecord(value) || !exactKeys(value, Object.keys(CATALOG_HEADER)) ||
      value.alg !== CATALOG_HEADER.alg || value.typ !== CATALOG_HEADER.typ ||
      typeof value.kid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.kid)) {
    fail('invalid protected header');
  }
  return value;
}

function validateVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    fail('invalid release version');
  }
}

function validatePublishedAt(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) {
    fail('invalid publishedAt');
  }
}

function validateFilename(target, value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    fail(`invalid filename for ${target}`);
  }
  if (target === 'linux-x64' && !value.endsWith('.AppImage')) {
    fail('linux-x64 artifacts must be AppImages');
  }
  if (target.startsWith('macos-') && !value.endsWith('.zip') && !value.endsWith('.dmg')) {
    fail(`${target} artifacts must be ZIP or DMG files`);
  }
}

export function validateCatalog(value) {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'channel', 'catalogSequence', 'release']) ||
      value.schemaVersion !== 1 || value.channel !== 'stable' ||
      !Number.isSafeInteger(value.catalogSequence) || value.catalogSequence < 1) {
    fail('invalid catalog');
  }
  if (value.release === null) return value;
  const release = value.release;
  if (!isRecord(release) || !exactKeys(release, ['id', 'version', 'build', 'publishedAt', 'notes', 'artifacts']) ||
      typeof release.id !== 'string' || release.id.length < 1 || release.id.length > 80 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release.id) ||
      !Number.isSafeInteger(release.build) || release.build < 0 ||
      typeof release.notes !== 'string' || release.notes.length > 4000 ||
      !isRecord(release.artifacts)) {
    fail('invalid release');
  }
  validateVersion(release.version);
  validatePublishedAt(release.publishedAt);
  const artifactTargets = Object.keys(release.artifacts);
  if (artifactTargets.length < 1 || artifactTargets.length > TARGETS.length ||
      artifactTargets.some((target) => !TARGETS.includes(target))) {
    fail('invalid artifact targets');
  }
  for (const target of TARGETS) {
    if (!(target in release.artifacts)) continue;
    const artifact = release.artifacts[target];
    if (!isRecord(artifact) || !exactKeys(artifact, ['filename', 'size', 'sha256'])) {
      fail(`invalid ${target} artifact`);
    }
    validateFilename(target, artifact.filename);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_ARTIFACT_BYTES) {
      fail(`invalid ${target} size`);
    }
    if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      fail(`invalid ${target} sha256`);
    }
  }
  return value;
}

export function parseJws(jws) {
  if (typeof jws !== 'string' || jws.length > 256 * 1024) fail('invalid JWS');
  const parts = jws.trim().split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0 || part.length > 128 * 1024)) {
    fail('invalid JWS segments');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJson(decodeBase64Url(encodedHeader), 'header');
  const payload = parseJson(decodeBase64Url(encodedPayload), 'payload');
  const signature = decodeBase64Url(encodedSignature);
  if (signature.length !== 64) fail('invalid signature');
  validateHeader(header);
  validateCatalog(payload);
  return { encodedHeader, encodedPayload, encodedSignature, header, payload, signature };
}

function publicKeyFromRaw(raw) {
  if (raw.length !== 32) fail('Ed25519 public keys must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

function publicKeyFromPemOrRaw(value) {
  if (Buffer.isBuffer(value) && value.toString('utf8').includes('BEGIN PUBLIC KEY')) {
    return createPublicKey(value);
  }
  if (Buffer.isBuffer(value)) return publicKeyFromRaw(value);
  const text = String(value);
  return text.includes('BEGIN PUBLIC KEY') ? createPublicKey(text) : publicKeyFromRaw(Buffer.from(text, 'base64'));
}

export function verifyJws(jws, publicKey, { keyId } = {}) {
  const parsed = parseJws(jws);
  if (keyId !== undefined && parsed.header.kid !== keyId) fail('unexpected JWS key ID');
  const key = publicKeyFromPemOrRaw(publicKey);
  const valid = verify(null, Buffer.from(`${parsed.encodedHeader}.${parsed.encodedPayload}`), key, parsed.signature);
  if (!valid) fail('JWS signature mismatch');
  return parsed.payload;
}

export function createJws(payload, privateKeyPem, keyId = DEFAULT_KEY_ID) {
  validateCatalog(payload);
  const encodedHeader = encodeBase64Url(Buffer.from(JSON.stringify(catalogHeader(keyId))));
  const encodedPayload = encodeBase64Url(Buffer.from(JSON.stringify(payload)));
  const input = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const signature = sign(null, input, createPrivateKey(privateKeyPem));
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`;
}

export async function hashArtifact(filePath) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 1 || info.size > MAX_ARTIFACT_BYTES) fail(`invalid artifact file: ${filePath}`);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return { size: info.size, sha256: digest.digest('hex') };
}

export async function buildCatalog({ sequence, release = null }) {
  const payload = { schemaVersion: 1, channel: 'stable', catalogSequence: sequence, release };
  validateCatalog(payload);
  return payload;
}

export async function buildRelease({ sequence, id, version, build, publishedAt, notes = '', artifacts }) {
  const releaseArtifacts = {};
  for (const target of TARGETS) {
    const filePath = artifacts?.[target];
    if (filePath === undefined) continue;
    const file = typeof filePath === 'string' ? filePath : filePath.path;
    const filename = typeof filePath === 'string'
      ? filePath.split(/[\\/]/).pop()
      : filePath.filename;
    validateFilename(target, filename);
    const metadata = await hashArtifact(file);
    releaseArtifacts[target] = {
      filename,
      size: metadata.size,
      sha256: metadata.sha256,
    };
  }
  return buildCatalog({
    sequence,
    release: { id, version, build, publishedAt, notes, artifacts: releaseArtifacts },
  });
}

async function writeAtomic(filePath, contents, mode = 0o644) {
  const output = resolve(filePath);
  const temporary = `${output}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, output);
}

async function writeNew(filePath, contents, mode) {
  await writeFile(resolve(filePath), contents, { mode, flag: 'wx' });
}

function flag(args, name, required = true) {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) {
    const value = inline.slice(name.length + 1);
    if (!value) fail(`missing value for ${name}`);
    return value;
  }
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) fail(`missing ${name}`);
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`missing value for ${name}`);
  return value;
}

async function readReleaseFile(filePath) {
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(value) ||
      !exactKeys(value, ['id', 'version', 'build', 'publishedAt', 'notes', 'artifacts']) ||
      !isRecord(value.artifacts)) {
    fail('release JSON has an invalid shape');
  }
  return value;
}

export async function command(args) {
  const name = args.shift();
  if (name === 'keygen') {
    const privatePath = flag(args, '--private-key');
    const publicPath = flag(args, '--public-key');
    await Promise.all([privatePath, publicPath].map(async (filePath) => {
      try {
        await access(resolve(filePath));
        fail(`refusing to overwrite ${filePath}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }));
    const pair = generateKeyPairSync('ed25519');
    await writeNew(privatePath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), 0o600);
    await writeNew(publicPath, pair.publicKey.export({ format: 'pem', type: 'spki' }), 0o644);
    return;
  }
  if (name === 'public-key') {
    const publicPath = flag(args, '--public-key');
    const der = createPublicKey(await readFile(publicPath)).export({ format: 'der', type: 'spki' });
    process.stdout.write(`${der.subarray(-32).toString('base64')}\n`);
    return;
  }
  if (name === 'verify') {
    const input = flag(args, '--input');
    const publicPath = flag(args, '--public-key', false) ?? DEFAULT_PUBLIC_KEY;
    const keyId = flag(args, '--key-id', false) ?? DEFAULT_KEY_ID;
    const payload = verifyJws(await readFile(input, 'utf8'), await readFile(publicPath), { keyId });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (name !== 'build' && name !== 'build-empty') fail('command must be keygen, public-key, build-empty, build, or verify');
  const privatePath = flag(args, '--private-key');
  const publicPath = flag(args, '--public-key', false) ?? DEFAULT_PUBLIC_KEY;
  const keyId = flag(args, '--key-id', false) ?? DEFAULT_KEY_ID;
  const output = flag(args, '--output');
  const sequence = Number(flag(args, '--sequence'));
  let payload;
  if (name === 'build-empty') {
    payload = await buildCatalog({ sequence });
  } else {
    const releaseFile = flag(args, '--release-json', false);
    if (releaseFile) {
      const release = await readReleaseFile(releaseFile);
      payload = await buildRelease({ ...release, sequence });
    } else {
      const artifacts = {};
      for (let index = 0; index < args.length; index += 1) {
        const value = args[index] === '--artifact'
          ? args[index + 1]
          : args[index].startsWith('--artifact=')
            ? args[index].slice('--artifact='.length)
            : undefined;
        if (value === undefined) continue;
        const separator = value.indexOf('=');
        const target = value.slice(0, separator);
        const filePath = value.slice(separator + 1);
        if (separator < 1 || !filePath || !TARGETS.includes(target)) fail('artifact must be target=path');
        if (artifacts[target] !== undefined) fail(`duplicate artifact target: ${target}`);
        artifacts[target] = filePath;
      }
      payload = await buildRelease({
        sequence,
        id: flag(args, '--id'),
        version: flag(args, '--version'),
        build: Number(flag(args, '--build')),
        publishedAt: flag(args, '--published-at'),
        notes: flag(args, '--notes', false) ?? '',
        artifacts,
      });
    }
  }
  const jws = createJws(payload, await readFile(privatePath, 'utf8'), keyId);
  verifyJws(jws, await readFile(publicPath, 'utf8'), { keyId });
  await writeAtomic(output, `${jws}\n`);
}

if (import.meta.main ||
    (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))) {
  command(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
