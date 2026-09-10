// NIP-07 sign-in endpoint behaviour: challenge issuance, rejection of a
// non-owner signature, a usable session token for the real admin, and refusal
// of missing/forged bearer tokens on admin endpoints.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { ADMIN_NPUB, SESSION_SECRET, adminToken, signChallenge } from './auth-helper.mjs';

let root;
let app;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'torii-auth-'));
  await writeFile(join(root, 'registry.json'), JSON.stringify({ apps: [], root_app: null }));
  process.env.TORII_ROOT = root;
  process.env.TORII_ADMIN_NPUB = ADMIN_NPUB;
  process.env.TORII_SESSION_SECRET = SESSION_SECRET;
  process.env.TORII_SKIP_NGINX_RELOAD = '1';
  ({ app } = await import('../index.mjs'));
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test('challenge issues a 48-char hex challenge tagged kind 22242', async () => {
  const res = await app.inject({ method: 'POST', url: '/torii/auth/challenge' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.challenge, /^[a-f0-9]{48}$/);
  assert.equal(body.kind, 22242);
  assert.ok(body.expires_in > 0);
});

test('verify rejects a correctly-signed event from a non-admin pubkey', async () => {
  const chal = await app.inject({ method: 'POST', url: '/torii/auth/challenge' });
  const { challenge } = chal.json();
  const wrongSeckey = generateSecretKey();
  const wrongPub = getPublicKey(wrongSeckey);
  const event = finalizeEvent(
    {
      kind: 22242,
      content: challenge,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['challenge', challenge]],
      pubkey: wrongPub,
    },
    wrongSeckey,
  );
  const res = await app.inject({ method: 'POST', url: '/torii/auth/verify', payload: { event } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'not_owner');
});

test('a valid admin sign-in yields a session token that authorizes admin endpoints', async () => {
  const token = await adminToken(app);
  assert.ok(token);

  const res = await app.inject({
    method: 'POST',
    url: '/torii/homepage',
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'Authed', theme: 'matrix', activate: false },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().activated, false);
});

test('admin endpoints reject missing and forged bearer tokens', async () => {
  const noAuth = await app.inject({ method: 'POST', url: '/torii/set-root', payload: { root_app: null } });
  assert.equal(noAuth.statusCode, 401);

  const forged = await app.inject({
    method: 'POST',
    url: '/torii/set-root',
    headers: { authorization: 'Bearer not-a-real-token' },
    payload: { root_app: null },
  });
  assert.equal(forged.statusCode, 401);
});

test('a challenge is single-use', async () => {
  const chal = await app.inject({ method: 'POST', url: '/torii/auth/challenge' });
  const { challenge } = chal.json();
  const event = signChallenge(challenge);

  const first = await app.inject({ method: 'POST', url: '/torii/auth/verify', payload: { event } });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({ method: 'POST', url: '/torii/auth/verify', payload: { event } });
  assert.equal(second.statusCode, 401);
  assert.equal(second.json().code, 'challenge_expired');
});