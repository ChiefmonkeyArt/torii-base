// Sidecar homepage endpoints: save persists + renders atomically, activation
// promotes the homepage to / with the static-serve include, the reserved
// target is guarded until configured, and boot reconciliation recovers a
// dangling homepage root. Regression: set-root for real apps is untouched.
// Admin auth goes through the NIP-07 sign-in flow (auth-helper), not a static token.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_NPUB, SESSION_SECRET, authHeaders } from './auth-helper.mjs';

let root;
let app;
let reconcileRoot;

const readReg = async () => JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));
const readConf = async () => readFile(join(root, 'root_app.conf'), 'utf8');

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'torii-hp-'));
  await writeFile(
    join(root, 'registry.json'),
    JSON.stringify({ apps: [{ name: 'quest' }], root_app: null }),
    'utf8',
  );
  process.env.TORII_ROOT = root;
  process.env.TORII_ADMIN_NPUB = ADMIN_NPUB;
  process.env.TORII_SESSION_SECRET = SESSION_SECRET;
  process.env.TORII_SKIP_NGINX_RELOAD = '1';
  ({ app, reconcileRoot } = await import('../index.mjs'));
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test('homepage.json reports unconfigured before any save', async () => {
  const res = await app.inject({ method: 'GET', url: '/torii/homepage.json' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { configured: false });
});

test('save requires admin auth', async () => {
  const res = await app.inject({
    method: 'POST', url: '/torii/homepage', payload: { title: 'x' },
  });
  assert.equal(res.statusCode, 401);
});

test('invalid homepage is rejected with field errors and writes nothing', async () => {
  const res = await app.inject({
    method: 'POST', url: '/torii/homepage', headers: await authHeaders(app),
    payload: { title: '', links: [{ label: 'bad', url: 'javascript:1' }] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_homepage');
  assert.ok(Array.isArray(res.json().errors));
  assert.equal(existsSync(join(root, 'homepage.json')), false);
});

test('activating before a homepage exists is refused (409)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/torii/set-root', headers: await authHeaders(app),
    payload: { root_app: 'homepage' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'homepage_not_configured');
  assert.equal((await readReg()).root_app, null);
});

test('save persists config + renders static HTML atomically', async () => {
  const res = await app.inject({
    method: 'POST', url: '/torii/homepage', headers: await authHeaders(app),
    payload: { title: 'My Home', tagline: 'hi', theme: 'matrix', links: [{ label: 'Quest', url: '/quest/' }] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().activated, false);

  const saved = JSON.parse(await readFile(join(root, 'homepage.json'), 'utf8'));
  assert.equal(saved.title, 'My Home');
  assert.ok(saved.updated_at);

  const html = await readFile(join(root, 'homepage', 'index.html'), 'utf8');
  assert.ok(html.includes('My Home'));
  assert.equal(/<script/i.test(html), false);

  // No stray temp files left by the atomic write.
  const stray = (await import('node:fs')).readdirSync(root).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(stray, []);

  // Root untouched by a plain save.
  assert.equal((await readReg()).root_app, null);
});

test('save with activate=true promotes homepage to / via static serve', async () => {
  const res = await app.inject({
    method: 'POST', url: '/torii/homepage', headers: await authHeaders(app),
    payload: { title: 'Live Home', theme: 'sunset', activate: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().activated, true);
  assert.equal((await readReg()).root_app, 'homepage');
  const conf = await readConf();
  assert.match(conf, /location = \/ \{/);
  assert.match(conf, /root .*homepage;/);
  assert.match(conf, /try_files \/index\.html =404;/);
});

test('GET homepage.json returns the saved config', async () => {
  const res = await app.inject({ method: 'GET', url: '/torii/homepage.json' });
  const body = res.json();
  assert.equal(body.configured, true);
  assert.equal(body.title, 'Live Home');
  assert.equal(body.theme, 'sunset');
});

test('set-root homepage works once configured', async () => {
  // reset to launcher first
  await app.inject({ method: 'POST', url: '/torii/set-root', headers: await authHeaders(app), payload: { root_app: null } });
  assert.equal((await readReg()).root_app, null);
  const res = await app.inject({
    method: 'POST', url: '/torii/set-root', headers: await authHeaders(app), payload: { root_app: 'homepage' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal((await readReg()).root_app, 'homepage');
});

test('regression: set-root still promotes a real app and blocks continuum', async () => {
  const ok = await app.inject({
    method: 'POST', url: '/torii/set-root', headers: await authHeaders(app), payload: { root_app: 'quest' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((await readReg()).root_app, 'quest');

  const blocked = await app.inject({
    method: 'POST', url: '/torii/set-root', headers: await authHeaders(app), payload: { root_app: 'continuum' },
  });
  assert.equal(blocked.statusCode, 403);
});

test('reconcile resets a dangling homepage root back to the launcher', async () => {
  // Point root at homepage, then delete the rendered file to simulate loss.
  await app.inject({ method: 'POST', url: '/torii/set-root', headers: await authHeaders(app), payload: { root_app: 'homepage' } });
  assert.equal((await readReg()).root_app, 'homepage');
  await unlink(join(root, 'homepage', 'index.html'));

  await reconcileRoot();

  assert.equal((await readReg()).root_app, null);
  const conf = await readConf();
  assert.match(conf, /launcher owns \//);
});

test('reconcile is a no-op when homepage html is present', async () => {
  await mkdir(join(root, 'homepage'), { recursive: true });
  await writeFile(join(root, 'homepage', 'index.html'), '<!doctype html>ok', 'utf8');
  await app.inject({ method: 'POST', url: '/torii/set-root', headers: await authHeaders(app), payload: { root_app: 'homepage' } });
  await reconcileRoot();
  assert.equal((await readReg()).root_app, 'homepage');
});

// Upgrade regression: a pre-0.1.3 install has a comment-only root_app.conf stub
// and registry root_app=null. torii.conf no longer carries a `location = /`
// fallback, so after upgrade `/` has no owner until reconcileRoot() rewrites the
// stub into the launcher block. bootstrap.sh restarts the sidecar to trigger
// this; here we prove reconcileRoot() alone recovers a launcher-owned /.
test('reconcile upgrades a legacy comment-only root_app.conf to the launcher block', async () => {
  await app.inject({ method: 'POST', url: '/torii/set-root', headers: await authHeaders(app), payload: { root_app: null } });
  // Simulate the legacy stub: comments only, no location block at all.
  await writeFile(
    join(root, 'root_app.conf'),
    '# Written by torii-base bootstrap. root_app is unset; the launcher owns /.\n',
    'utf8',
  );

  await reconcileRoot();

  const conf = await readConf();
  assert.match(conf, /location = \/ \{/);
  assert.match(conf, /root .*launcher;/);
  assert.match(conf, /try_files \/index\.html =404;/);
});