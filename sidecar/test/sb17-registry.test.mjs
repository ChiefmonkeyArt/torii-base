// SB-17 regression: transactional registry mutations. When the nginx reload
// after a mutation fails, the registry must roll back to its prior state and
// the endpoint must signal failure (not `{ok:true}`).
//
// These tests deliberately do NOT set TORII_SKIP_NGINX_RELOAD, so the sidecar's
// `sudo -n nginx -t` fails (no nginx in the test sandbox) and the reload path
// rejects — exactly the failure these guards must handle.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_NPUB, SESSION_SECRET } from './auth-helper.mjs';

let root;
let app;

const readReg = async () => JSON.parse(await readFile(join(root, 'state', 'registry.json'), 'utf8'));

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'torii-sb17-'));
  await mkdir(join(root, 'state'), { recursive: true });
  await mkdir(join(root, 'nginx-fragments'), { recursive: true });
  // Seed one registered app + the fragments register/unregister require.
  await writeFile(
    join(root, 'state', 'registry.json'),
    JSON.stringify({ apps: [{ name: 'quest' }], root_app: null }),
    'utf8',
  );
  await writeFile(join(root, 'nginx-fragments', 'quest.conf'), 'location /quest/ {}\n', 'utf8');
  await writeFile(join(root, 'nginx-fragments', 'newapp.conf'), 'location /newapp/ {}\n', 'utf8');
  process.env.TORII_ROOT = root;
  process.env.TORII_ADMIN_NPUB = ADMIN_NPUB;
  process.env.TORII_SESSION_SECRET = SESSION_SECRET;
  delete process.env.TORII_SKIP_NGINX_RELOAD; // force the (failing) real reload path
  ({ app } = await import('../index.mjs'));
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test('register rolls back the registry when nginx reload fails', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/torii/apps',
    payload: { name: 'newapp', display_name: 'New App', version: '1.0.0' },
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'nginx_reload_failed');
  const reg = await readReg();
  assert.deepEqual(reg.apps.map((a) => a.name), ['quest'], 'registry must be unchanged after failed register');
});

test('unregister signals failure (not ok:true) and rolls back when reload fails', async () => {
  const res = await app.inject({ method: 'DELETE', url: '/torii/apps/quest' });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'nginx_reload_failed');
  const reg = await readReg();
  assert.deepEqual(reg.apps.map((a) => a.name), ['quest'], 'registry must be unchanged after failed unregister');
});