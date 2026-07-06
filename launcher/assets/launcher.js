// Torii launcher — vanilla, no framework, no build step.
//
// Reads GET /torii/apps.json to learn what's installed and which app
// (if any) currently owns the root. Renders tiles. Set-as-homepage
// posts to /torii/set-root. Admin auth is enforced by the base sidecar,
// not by this page — an unauthenticated visitor can browse the launcher
// and open apps but can't change root_app.

const APPS_URL = '/torii/apps.json';
const SET_ROOT_URL = '/torii/set-root';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const eyebrow = document.getElementById('eyebrow');
const rootStatus = document.getElementById('root-status');

const toast = (msg) => {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.classList.remove('show'), 2200);
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const renderTile = (app, isRoot) => {
  const li = document.createElement('article');
  li.className = 'tile';
  li.setAttribute('data-app', app.name);
  li.innerHTML = `
    <div class="tile-top">
      <div>
        <h2 class="tile-name">${escapeHtml(app.display_name || app.name)}${isRoot ? ' <span class="badge">Homepage</span>' : ''}</h2>
        <p class="tile-desc">${escapeHtml(app.description || '')}</p>
      </div>
      <span class="tile-version">${escapeHtml(app.version || '')}</span>
    </div>
    <div class="tile-actions">
      <a class="btn btn-primary" href="/${encodeURIComponent(app.name)}/">Open</a>
      ${
        isRoot
          ? `<button class="btn btn-ghost" data-action="unset">Unset homepage</button>`
          : `<button class="btn" data-action="set">Set as homepage</button>`
      }
    </div>
  `;
  li.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    ev.preventDefault();
    const action = btn.getAttribute('data-action');
    btn.disabled = true;
    try {
      const target = action === 'set' ? app.name : null;
      const res = await fetch(SET_ROOT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ root_app: target }),
      });
      if (res.status === 401 || res.status === 403) {
        toast('Sign in as admin to change the homepage.');
        return;
      }
      if (!res.ok) {
        toast(`Could not update: ${res.status}`);
        return;
      }
      toast(target ? `${app.display_name || app.name} is now the homepage.` : 'Homepage reset to launcher.');
      await load();
    } finally {
      btn.disabled = false;
    }
  });
  return li;
};

async function load() {
  grid.innerHTML = '';
  try {
    const res = await fetch(APPS_URL, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const apps = Array.isArray(data.apps) ? data.apps : [];
    const rootApp = typeof data.root_app === 'string' ? data.root_app : null;

    eyebrow.textContent = `Torii base · ${escapeHtml(data.version || '0.1.0')}`;
    rootStatus.innerHTML = rootApp
      ? `Homepage: <strong>${escapeHtml(rootApp)}</strong>`
      : `Homepage: <strong>launcher</strong>`;

    if (apps.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    apps.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const app of apps) grid.appendChild(renderTile(app, app.name === rootApp));
  } catch (err) {
    eyebrow.textContent = 'Torii base · offline';
    empty.hidden = false;
    empty.querySelector('h2').textContent = 'Base API unreachable.';
    empty.querySelector('p').textContent = 'Is the torii-base sidecar running?';
  }
}

load();
