// Backend defense-in-depth: /torii/set-root must reject blocklisted apps
// (Continuum) while leaving other apps (Quest) promotable.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-admin-token';
let root;
let app;
let isRootAllowed;

const auth = { authorization: `Bearer ${TOKEN}` };
const readReg = async () => JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'torii-test-'));
  await writeFile(
    join(root, 'registry.json'),
    JSON.stringify({
      apps: [{ name: 'continuum' }, { name: 'quest' }],
      root_app: null,
    }),
    'utf8',
  );
  process.env.TORII_ROOT = root;
  process.env.TORII_ADMIN_TOKEN = TOKEN;
  process.env.TORII_SKIP_NGINX_RELOAD = '1';
  ({ app, isRootAllowed } = await import('../index.mjs'));
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test('isRootAllowed blocks continuum but allows quest', () => {
  assert.equal(isRootAllowed('continuum'), false);
  assert.equal(isRootAllowed('quest'), true);
  assert.equal(isRootAllowed('plebeian'), true);
});

test('set-root rejects continuum with 403 and does not mutate registry', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/torii/set-root',
    headers: auth,
    payload: { root_app: 'continuum' },
  });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: 'root_not_allowed', name: 'continuum' });
  assert.equal((await readReg()).root_app, null);
});

test('set-root still promotes quest', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/torii/set-root',
    headers: auth,
    payload: { root_app: 'quest' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, root_app: 'quest' });
  assert.equal((await readReg()).root_app, 'quest');
});

test('unauthenticated set-root for continuum is rejected before any change', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/torii/set-root',
    payload: { root_app: 'continuum' },
  });
  assert.equal(res.statusCode, 401);
  // quest promotion from the previous test remains untouched.
  assert.equal((await readReg()).root_app, 'quest');
});
