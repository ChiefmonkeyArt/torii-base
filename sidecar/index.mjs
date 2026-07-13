// torii-base sidecar — a tiny fastify server that backs the launcher.
//
// Endpoints (all served under /torii/*):
//   GET  /torii/apps.json     → { apps: [...], root_app: string|null, version }
//   GET  /torii/healthz       → liveness
//   POST /torii/set-root      → change root_app (admin-only)
//
// State lives entirely on disk under $TORII_ROOT (default /opt/torii):
//   registry.json             → { apps: [...], root_app: string|null }
//   root_app.conf             → nginx include, rewritten by set-root
//   nginx-fragments/*.conf    → per-app fragments (read-only here)
//
// Admin auth: `Bearer <token>` in Authorization header. Token is loaded from
// $TORII_ADMIN_TOKEN env at boot. If the env is unset, admin endpoints refuse
// all requests. GET endpoints are public (they only expose which apps exist,
// same info the launcher renders anyway).

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const TORII_ROOT = process.env.TORII_ROOT || '/opt/torii';
const REGISTRY_PATH = join(TORII_ROOT, 'registry.json');
const ROOT_APP_CONF = join(TORII_ROOT, 'root_app.conf');
const PORT = Number(process.env.TORII_SIDECAR_PORT || 8780);
const HOST = process.env.TORII_SIDECAR_HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.TORII_ADMIN_TOKEN || '';
const VERSION = '0.1.2';

const APP_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

// Apps that must never own `/`. Continuum is an authenticated app builder +
// agent surface; promoting it to the public homepage is unsafe, so the
// launcher greys out its "Set as homepage" control and set-root rejects it
// here as defense-in-depth. This only blocks the root promotion — Continuum
// stays fully reachable at its own mount (/continuum/).
const ROOT_BLOCKLIST = new Set(['continuum']);

export const isRootAllowed = (name) => !ROOT_BLOCKLIST.has(name);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true,
});
await app.register(cookie);

async function readRegistry() {
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { apps: [], root_app: null };
    return {
      apps: Array.isArray(parsed.apps) ? parsed.apps : [],
      root_app: typeof parsed.root_app === 'string' ? parsed.root_app : null,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { apps: [], root_app: null };
    throw err;
  }
}

async function writeRegistry(reg) {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

async function writeRootAppConf(appName) {
  // Empty file when unset — nginx include is a no-op.
  const body = appName
    ? `# Written by torii-base sidecar. Do not edit by hand.\nlocation = / {\n    return 302 /${appName}/;\n}\n`
    : `# Written by torii-base sidecar. root_app is unset; launcher owns /.\n`;
  await writeFile(ROOT_APP_CONF, body, 'utf8');
}

async function nginxReload() {
  // Escape hatch for tests / dry-run environments without a real nginx.
  if (process.env.TORII_SKIP_NGINX_RELOAD === '1') return;
  // Sidecar runs as the `torii` system user, which cannot reload nginx
  // directly (SIGHUP to the root-owned master requires CAP_KILL or root).
  // bootstrap.sh drops a sudoers snippet at /etc/sudoers.d/torii-nginx
  // that grants passwordless access to exactly `nginx -t` and
  // `nginx -s reload`; we call both through `sudo -n` so any failure to
  // acquire privilege surfaces as an error instead of hanging on a prompt.
  // Validate first; only reload if config is valid.
  await execFileAsync('sudo', ['-n', 'nginx', '-t']);
  await execFileAsync('sudo', ['-n', 'nginx', '-s', 'reload']);
}

function requireAdmin(req, reply) {
  if (!ADMIN_TOKEN) {
    reply.code(503).send({ error: 'admin_token_unset' });
    return false;
  }
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m || m[1] !== ADMIN_TOKEN) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// Public endpoints
// ─────────────────────────────────────────────────────────────

app.get('/torii/healthz', async () => ({ ok: true, version: VERSION }));

app.get('/torii/apps.json', async () => {
  const reg = await readRegistry();
  return { version: VERSION, apps: reg.apps, root_app: reg.root_app };
});

// ─────────────────────────────────────────────────────────────
// Admin endpoints
// ─────────────────────────────────────────────────────────────

app.post('/torii/set-root', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const target = req.body?.root_app;
  if (target !== null && (typeof target !== 'string' || !APP_NAME_RE.test(target))) {
    return reply.code(400).send({ error: 'invalid_root_app' });
  }
  if (target !== null && !isRootAllowed(target)) {
    return reply.code(403).send({ error: 'root_not_allowed', name: target });
  }
  const reg = await readRegistry();
  if (target !== null && !reg.apps.some((a) => a.name === target)) {
    return reply.code(404).send({ error: 'app_not_installed', name: target });
  }
  reg.root_app = target;
  await writeRegistry(reg);
  await writeRootAppConf(target);
  try {
    await nginxReload();
  } catch (err) {
    // Roll back the conf change if nginx refused it.
    reg.root_app = null;
    await writeRegistry(reg);
    await writeRootAppConf(null);
    req.log.error({ err }, 'nginx reload failed, rolled back');
    return reply.code(500).send({ error: 'nginx_reload_failed' });
  }
  return { ok: true, root_app: target };
});

// POST /torii/apps — registrar for install scripts. Idempotent upsert by name.
// Called by each app installer after it writes its nginx fragment.
app.post('/torii/apps', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { name, display_name, description, version } = req.body || {};
  if (typeof name !== 'string' || !APP_NAME_RE.test(name)) {
    return reply.code(400).send({ error: 'invalid_name' });
  }
  const fragmentPath = join(TORII_ROOT, 'nginx-fragments', `${name}.conf`);
  if (!existsSync(fragmentPath)) {
    return reply.code(400).send({ error: 'missing_fragment', expected: fragmentPath });
  }
  const reg = await readRegistry();
  const entry = {
    name,
    display_name: typeof display_name === 'string' ? display_name : name,
    description: typeof description === 'string' ? description : '',
    version: typeof version === 'string' ? version : 'unknown',
    installed_at: new Date().toISOString(),
  };
  const idx = reg.apps.findIndex((a) => a.name === name);
  if (idx >= 0) reg.apps[idx] = { ...reg.apps[idx], ...entry };
  else reg.apps.push(entry);
  await writeRegistry(reg);
  try {
    await nginxReload();
  } catch (err) {
    req.log.error({ err }, 'nginx reload after register failed');
    return reply.code(500).send({ error: 'nginx_reload_failed' });
  }
  return { ok: true, app: entry };
});

// DELETE /torii/apps/:name — removes registration. Fragment removal is the
// installer's job; we just drop the row and reload.
app.delete('/torii/apps/:name', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { name } = req.params;
  if (!APP_NAME_RE.test(name)) return reply.code(400).send({ error: 'invalid_name' });
  const reg = await readRegistry();
  reg.apps = reg.apps.filter((a) => a.name !== name);
  if (reg.root_app === name) {
    reg.root_app = null;
    await writeRootAppConf(null);
  }
  await writeRegistry(reg);
  try {
    await nginxReload();
  } catch (err) {
    req.log.error({ err }, 'nginx reload after unregister failed');
  }
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────

const start = async () => {
  if (!existsSync(REGISTRY_PATH)) {
    await mkdir(TORII_ROOT, { recursive: true }).catch(() => {});
    await writeRegistry({ apps: [], root_app: null }).catch(() => {});
  }
  if (!existsSync(ROOT_APP_CONF)) await writeRootAppConf(null).catch(() => {});
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ version: VERSION, port: PORT, root: TORII_ROOT }, 'torii-base sidecar up');
};

// Only bind a port when run directly; tests import `app` and use inject().
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { app };
