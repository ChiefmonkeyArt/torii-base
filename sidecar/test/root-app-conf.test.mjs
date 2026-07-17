// Regression guard for the "duplicate location /" bug. torii.conf no longer
// declares a `location = /` of its own, so root_app.conf must be the SINGLE
// owner of that block: every state (unset, app-set, homepage) has to emit
// exactly one `location = /`, never zero (root would 404) and never two (a
// fatal nginx "duplicate location /"). These tests drive the real set-root
// handler + boot reconcile against a temp TORII_ROOT and assert the invariant
// across states and across re-runs (idempotency).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-admin-token';
let root;
let app;
let reconcileRoot;

const auth = { authorization: `Bearer ${TOKEN}` };
const readConf = () => readFile(join(root, 'root_app.conf'), 'utf8');
const countRootLocations = (conf) => (conf.match(/location = \//g) || []).length;

const setRoot = (root_app) =>
  app.inject({ method: 'POST', url: '/torii/set-root', headers: auth, payload: { root_app } });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'torii-rootconf-'));
  await writeFile(
    join(root, 'registry.json'),
    JSON.stringify({ apps: [{ name: 'quest' }], root_app: null }),
    'utf8',
  );
  process.env.TORII_ROOT = root;
  process.env.TORII_ADMIN_TOKEN = TOKEN;
  process.env.TORII_SKIP_NGINX_RELOAD = '1';
  ({ app, reconcileRoot } = await import('../index.mjs'));
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test('set-root none writes exactly one launcher location block (never empty)', async () => {
  const res = await setRoot(null);
  assert.equal(res.statusCode, 200);
  const conf = await readConf();
  assert.notEqual(conf.trim(), '', 'root_app.conf must never be empty');
  assert.equal(countRootLocations(conf), 1, 'exactly one location = /');
  assert.match(conf, /root .*\/launcher;/);
  assert.match(conf, /try_files \/index\.html =404;/);
});

test('set-root <app> writes exactly one 302 redirect block', async () => {
  const res = await setRoot('quest');
  assert.equal(res.statusCode, 200);
  const conf = await readConf();
  assert.equal(countRootLocations(conf), 1, 'exactly one location = /');
  assert.match(conf, /return 302 \/quest\/;/);
});

test('set-root homepage writes exactly one static homepage block', async () => {
  await mkdir(join(root, 'homepage'), { recursive: true });
  await writeFile(join(root, 'homepage', 'index.html'), '<!doctype html><title>hp</title>', 'utf8');
  const res = await setRoot('homepage');
  assert.equal(res.statusCode, 200);
  const conf = await readConf();
  assert.equal(countRootLocations(conf), 1, 'exactly one location = /');
  assert.match(conf, /root .*\/homepage;/);
});

test('re-running set-root none is idempotent — still exactly one block', async () => {
  await setRoot(null);
  const first = await readConf();
  await setRoot(null);
  const second = await readConf();
  assert.equal(second, first, 'repeated set-root none is byte-stable');
  assert.equal(countRootLocations(second), 1);
});

test('boot reconcile keeps exactly one block for every registry state', async () => {
  for (const state of [null, 'quest']) {
    await writeFile(
      join(root, 'registry.json'),
      JSON.stringify({ apps: [{ name: 'quest' }], root_app: state }),
      'utf8',
    );
    await reconcileRoot();
    assert.equal(countRootLocations(await readConf()), 1, `state=${state}`);
  }
});
