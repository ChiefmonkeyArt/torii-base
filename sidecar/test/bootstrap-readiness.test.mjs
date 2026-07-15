// Bootstrap readiness gate (lib/wait-for-sidecar.sh). The systemd unit is
// Type=simple, so `systemctl restart` returns before the sidecar has run
// reconcileRoot(). bootstrap.sh closes that race by blocking on /torii/healthz
// before it validates/reloads nginx — the sidecar reconciles root_app.conf
// *before* it listens, so a healthy response guarantees `/` has a valid owner.
//
// These tests drive the real helper script (no logic duplication) against a
// fake sidecar to prove: (1) it waits through delayed readiness and only
// returns once root_app.conf has been reconciled, and (2) it fails closed on
// timeout without disturbing the existing config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'wait-for-sidecar.sh');

const LEGACY_STUB = '# Written by torii-base bootstrap. root_app is unset; the launcher owns /.\n';
const LAUNCHER_BLOCK =
  '# Written by torii-base sidecar. Do not edit by hand.\n# root_app is unset; the launcher owns /.\nlocation = / {\n    root /opt/torii/launcher;\n    try_files /index.html =404;\n}\n';

// Run the helper; resolve with { code, ms } instead of throwing on non-zero.
function runHelper(url, retries, interval) {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile('bash', [HELPER, url, String(retries), String(interval)], (err) => {
      resolve({ code: err ? err.code ?? 1 : 0, ms: Date.now() - started });
    });
  });
}

const listenOn = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('waits through delayed readiness and returns only after reconcile has run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torii-ready-'));
  const conf = join(dir, 'root_app.conf');
  // Pre-0.1.3 state: a comment-only stub with no `location = /` owner.
  await writeFile(conf, LEGACY_STUB, 'utf8');

  const READY_AFTER_MS = 500;
  let ready = false;
  // Mimic the sidecar's boot order: reconcile the conf, THEN start answering
  // healthz. The helper must not see 200 until the conf is already valid.
  const timer = setTimeout(async () => {
    await writeFile(conf, LAUNCHER_BLOCK, 'utf8');
    ready = true;
  }, READY_AFTER_MS);

  const server = createServer((req, res) => {
    if (req.url === '/torii/healthz' && ready) res.writeHead(200).end('{"ok":true}');
    else res.writeHead(503).end('not ready');
  });
  const port = await listenOn(server);

  try {
    const { code, ms } = await runHelper(`http://127.0.0.1:${port}/torii/healthz`, 50, 0.1);
    assert.equal(code, 0, 'helper should report ready');
    assert.ok(ms >= READY_AFTER_MS - 100, `helper returned too early (${ms}ms), did not wait`);
    // The guarantee that matters: by the time the helper unblocks bootstrap,
    // the `/` include is already the valid launcher block, not the stub.
    assert.equal(await readFile(conf, 'utf8'), LAUNCHER_BLOCK);
  } finally {
    clearTimeout(timer);
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fails closed on timeout and leaves the existing config untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torii-ready-'));
  const conf = join(dir, 'root_app.conf');
  await writeFile(conf, LEGACY_STUB, 'utf8');

  // Grab a port, then close it so nothing is listening — the sidecar never
  // comes up. A tight budget keeps the test fast: 3 * 0.05s ≈ 150ms.
  const probe = createServer();
  const deadPort = await listenOn(probe);
  await new Promise((r) => probe.close(r));

  const { code, ms } = await runHelper(`http://127.0.0.1:${deadPort}/torii/healthz`, 3, 0.05);
  assert.equal(code, 1, 'helper must exit non-zero when the sidecar never becomes ready');
  assert.ok(ms < 2000, `helper should honor the bounded budget (took ${ms}ms)`);
  // fail-closed contract: bootstrap aborts before touching nginx, so the
  // pre-existing include is still exactly what it was — nothing clobbered.
  assert.equal(await readFile(conf, 'utf8'), LEGACY_STUB);

  await rm(dir, { recursive: true, force: true });
});
