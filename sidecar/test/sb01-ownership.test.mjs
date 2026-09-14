// SB-01 regression: local post-compromise escalation via a service-writable
// parent. The historic layout owned /opt/torii by the `torii` service user and
// `env` as root:torii 0640, so a compromised sidecar could rename/replace the
// root-consumed `env` (session secret); when a later privileged `torii` CLI run
// `source`d it, arbitrary code executed as root.
//
// This suite guards the two load-bearing properties the fix introduced (and
// that must not regress):
//   1. bootstrap.sh now root-owns /opt/torii + `env` and moves runtime state
//      into a torii-owned state/ subdir.
//   2. `bin/torii` must never `source` /opt/torii/env (fixed-KV parsing, not
//      shell interpretation — systemd reads it as EnvironmentFile, not code).
// The live container proof (attempt the rename/replace as `torii` and assert
// the sentinel is not executed) lives in test/sb01-ownership.test.sh, which
// needs root + an isolated environment; these are the static invariants that
// run everywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readRepo(rel) {
  return readFile(join(REPO, rel), 'utf8');
}

test('bootstrap.sh root-owns /opt/torii and the env file', async () => {
  const s = await readRepo('bootstrap.sh');
  assert.match(s, /chown root:root "\$TORII_ROOT"/, 'expected /opt/torii to be root-owned');
  assert.match(s, /chown root:root "\$TORII_ROOT\/env"/, 'expected env to be root-owned');
  assert.doesNotMatch(s, /chown root:"\$TORII_USER"\s+"\$TORII_ROOT\/env"/, 'old root:torii env ownership must be gone');
});

test('bootstrap.sh moves runtime state into torii-owned state/ dir', async () => {
  const s = await readRepo('bootstrap.sh');
  assert.match(s, /STATE_DIR=/, 'STATE_DIR must be defined');
  assert.match(s, /"\$STATE_DIR\/registry\.json"/, 'registry must live under state/');
  assert.match(s, /"\$STATE_DIR\/root_app\.conf"/, 'root_app.conf must live under state/');
  assert.doesNotMatch(s, /"\$TORII_ROOT\/registry\.json"/, 'legacy /opt/torii/registry.json must be gone');
  assert.doesNotMatch(s, /"\$TORII_ROOT\/root_app\.conf"/, 'legacy /opt/torii/root_app.conf must be gone');
});

test('bin/torii never sources the env file', async () => {
  const s = await readRepo('bin/torii');
  // The old exploit was `source "$ENV_FILE"` / `. "$ENV_FILE"` executed as root.
  assert.doesNotMatch(s, /^\s*(source|\.)\s+.*ENV_FILE/m, 'bin/torii must not source the env file');
  assert.doesNotMatch(s, /^\s*(source|\.)\s+.*\/env/m, 'bin/torii must not source any env file');
});

test('sidecar service narrows writable paths and keeps fixed-KV env', async () => {
  const svc = await readRepo('systemd/torii-base-sidecar.service');
  assert.match(svc, /EnvironmentFile=\/opt\/torii\/env/, 'env is read as fixed KV by systemd');
  assert.match(svc, /ReadWritePaths=\/opt\/torii\/state/, 'writable surface narrowed to state/ only');
});