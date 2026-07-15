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
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { validateHomepage, renderHomepage } from '../launcher/assets/homepage-render.mjs';

const execFileAsync = promisify(execFile);

const TORII_ROOT = process.env.TORII_ROOT || '/opt/torii';
const REGISTRY_PATH = join(TORII_ROOT, 'registry.json');
const ROOT_APP_CONF = join(TORII_ROOT, 'root_app.conf');
const HOMEPAGE_JSON = join(TORII_ROOT, 'homepage.json');
const HOMEPAGE_DIR = join(TORII_ROOT, 'homepage');
const HOMEPAGE_HTML = join(HOMEPAGE_DIR, 'index.html');
const PORT = Number(process.env.TORII_SIDECAR_PORT || 8780);
const HOST = process.env.TORII_SIDECAR_HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.TORII_ADMIN_TOKEN || '';
const VERSION = '0.1.3';

const APP_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

// Reserved root target for the user-built personal homepage. It is not a
// registered app: `/` serves a static, sidecar-rendered HTML file instead of
// redirecting to a mount. set-root accepts it only when a homepage has been
// saved and rendered (see the homepage guard in the set-root handler).
const HOMEPAGE_ROOT = 'homepage';

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

// Write-to-temp-then-rename so readers (nginx, the launcher) never observe a
// half-written file, and a crash mid-write leaves the previous version intact.
async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

async function writeRegistry(reg) {
  await atomicWrite(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n');
}

const LAUNCHER_ROOT_BLOCK =
  `# Written by torii-base sidecar. Do not edit by hand.\n# root_app is unset; the launcher owns /.\nlocation = / {\n    root ${join(TORII_ROOT, 'launcher')};\n    try_files /index.html =404;\n}\n`;

async function writeRootAppConf(appName) {
  // This include is the *single* owner of `location = /` — torii.conf no
  // longer declares a fallback, because two `location = /` blocks in one
  // server is a fatal nginx error. So every state (unset, redirect, homepage)
  // must emit exactly one such block here.
  let body;
  if (appName === HOMEPAGE_ROOT) {
    // Serve the rendered personal homepage statically at /. try_files falls
    // back to 404 if the file is missing; boot reconciliation resets root to
    // the launcher in that case so a broken homepage can't strand the site.
    body = `# Written by torii-base sidecar. Do not edit by hand.\nlocation = / {\n    root ${HOMEPAGE_DIR};\n    try_files /index.html =404;\n}\n`;
  } else if (appName) {
    body = `# Written by torii-base sidecar. Do not edit by hand.\nlocation = / {\n    return 302 /${appName}/;\n}\n`;
  } else {
    body = LAUNCHER_ROOT_BLOCK;
  }
  await atomicWrite(ROOT_APP_CONF, body);
}

async function readHomepage() {
  try {
    const parsed = JSON.parse(await readFile(HOMEPAGE_JSON, 'utf8'));
    return validateHomepage(parsed).value;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
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

// Commit a new root_app: persist registry + conf, reload nginx, and roll
// everything back to the prior state if the reload fails. Returns true on
// success. `prev` is the root_app value to restore on failure.
async function applyRoot(reg, target, prev, log) {
  reg.root_app = target;
  await writeRegistry(reg);
  await writeRootAppConf(target);
  try {
    await nginxReload();
    return true;
  } catch (err) {
    reg.root_app = prev;
    await writeRegistry(reg);
    await writeRootAppConf(prev);
    log.error({ err }, 'nginx reload failed, rolled back root_app');
    return false;
  }
}

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
  if (target === HOMEPAGE_ROOT) {
    // The personal homepage is not a registered app; it just needs to have
    // been saved + rendered before it can own /.
    if (!existsSync(HOMEPAGE_HTML)) {
      return reply.code(409).send({ error: 'homepage_not_configured' });
    }
  } else if (target !== null && !reg.apps.some((a) => a.name === target)) {
    return reply.code(404).send({ error: 'app_not_installed', name: target });
  }
  const prev = reg.root_app;
  if (!(await applyRoot(reg, target, prev, req.log))) {
    return reply.code(500).send({ error: 'nginx_reload_failed' });
  }
  return { ok: true, root_app: target };
});

// GET /torii/homepage.json — current saved homepage config (public; the page
// it renders is public once activated anyway). Returns configured:false when
// nothing has been saved yet.
app.get('/torii/homepage.json', async () => {
  const value = await readHomepage();
  return value ? { configured: true, ...value } : { configured: false };
});

// POST /torii/homepage — save (and optionally activate) the personal homepage.
// Validates strictly, persists the clean config atomically, then renders a
// self-contained static HTML file. With { activate: true } it also promotes
// the homepage to owner of / (with the same rollback as set-root).
app.post('/torii/homepage', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const result = validateHomepage(req.body || {});
  if (!result.ok) {
    return reply.code(400).send({ error: 'invalid_homepage', errors: result.errors });
  }
  const value = { ...result.value, updated_at: new Date().toISOString() };
  await atomicWrite(HOMEPAGE_JSON, JSON.stringify(value, null, 2) + '\n');
  await atomicWrite(HOMEPAGE_HTML, renderHomepage(value));

  let activated = false;
  if (req.body?.activate === true) {
    const reg = await readRegistry();
    const prev = reg.root_app;
    if (!(await applyRoot(reg, HOMEPAGE_ROOT, prev, req.log))) {
      return reply.code(500).send({ error: 'nginx_reload_failed', saved: true });
    }
    activated = true;
  }
  return { ok: true, activated, value: result.value };
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

// Boot reconciliation. Two jobs:
//   1. Recovery — if the registry says the homepage owns / but its rendered
//      file is gone (deleted, half-migrated, disk wiped), the site would 404
//      at root. Reset to the launcher.
//   2. Rewrite the `location = /` include to match root_app. Because
//      torii.conf no longer hardcodes a launcher fallback, this also upgrades
//      pre-0.1.3 installs whose root_app.conf was a comment-only stub (which
//      would otherwise leave / with no location block after upgrade).
async function reconcileRoot() {
  const reg = await readRegistry();
  let target = reg.root_app;
  if (target === HOMEPAGE_ROOT && !existsSync(HOMEPAGE_HTML)) {
    app.log.warn('root_app=homepage but no rendered homepage found; resetting root to launcher');
    target = null;
    reg.root_app = null;
    await writeRegistry(reg);
  }
  await writeRootAppConf(target);
}

const start = async () => {
  if (!existsSync(REGISTRY_PATH)) {
    await mkdir(TORII_ROOT, { recursive: true }).catch(() => {});
    await writeRegistry({ apps: [], root_app: null }).catch(() => {});
  }
  if (!existsSync(ROOT_APP_CONF)) await writeRootAppConf(null).catch(() => {});
  await reconcileRoot().catch((err) => app.log.error({ err }, 'homepage reconcile failed'));
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

export { app, reconcileRoot };
