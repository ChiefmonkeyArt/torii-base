// Homepage creator — vanilla ESM, no build step. Shares validation +
// rendering with the sidecar via homepage-render.mjs, so the live preview is
// exactly what gets saved and served. Admin actions authenticate with a NIP-07
// sign-in (admin-session.mjs): the operator signs a challenge with their signer,
// and the resulting session token is sent as `Bearer <token>`.

import {
  THEMES, LIMITS, DEFAULT_THEME, validateHomepage, renderHomepage,
} from '/assets/homepage-render.mjs';
const { getSessionToken, signIn, signOut, isSignedIn } = window.ToriiAdmin;

const HOMEPAGE_URL = '/torii/homepage.json';
const APPS_URL = '/torii/apps.json';
const SAVE_URL = '/torii/homepage';

// Suggested links for first-class integrations when they're installed. Absent
// apps are simply not suggested — nothing hard-fails.
const SUGGESTED = {
  quest: { label: 'Play Quest', url: '/quest/' },
  plebeian: { label: 'Plebeian Market', url: '/plebeian/' },
};

const $ = (sel, root = document) => root.querySelector(sel);
const state = { theme: DEFAULT_THEME, links: [] };

const setStatus = (msg, kind = '') => {
  const el = $('#status');
  el.textContent = msg;
  el.className = `editor-status${kind ? ' is-' + kind : ''}`;
};

function renderAdminState() {
  const signin = $('#admin-signin');
  if (!signin) return;
  const signedIn = isSignedIn();
  signin.hidden = signedIn;
  $('#admin-signout').hidden = !signedIn;
  $('#admin-state').textContent = signedIn ? 'Signed in as admin' : '';
  $('#admin-state').className = `admin-state${signedIn ? ' is-ok' : ''}`;
}

function readForm() {
  return {
    title: $('#title').value,
    tagline: $('#tagline').value,
    theme: state.theme,
    links: state.links.map((l) => ({ label: l.label, url: l.url })),
  };
}

function updatePreview() {
  const html = renderHomepage(readForm());
  $('#preview').srcdoc = html;
}

function renderThemes() {
  const wrap = $('#themes');
  wrap.innerHTML = '';
  for (const t of THEMES) {
    const id = `theme-${t.id}`;
    const label = document.createElement('label');
    label.className = 'theme-chip';
    label.htmlFor = id;
    label.style.setProperty('--chip-accent', t.accent);
    label.style.setProperty('--chip-bg', t.bg);
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'theme';
    input.id = id;
    input.value = t.id;
    input.checked = t.id === state.theme;
    input.addEventListener('change', () => { state.theme = t.id; updatePreview(); });
    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = t.label;
    label.append(input, swatch, name);
    wrap.appendChild(label);
  }
}

function renderLinks() {
  const wrap = $('#links');
  wrap.innerHTML = '';
  state.links.forEach((link, i) => {
    const row = document.createElement('div');
    row.className = 'link-row';

    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = LIMITS.linkLabel;
    label.placeholder = 'Label';
    label.value = link.label;
    label.setAttribute('aria-label', `Link ${i + 1} label`);
    label.addEventListener('input', () => { state.links[i].label = label.value; updatePreview(); });

    const url = document.createElement('input');
    url.type = 'text';
    url.maxLength = LIMITS.linkUrl;
    url.placeholder = '/path or https://…';
    url.value = link.url;
    url.setAttribute('aria-label', `Link ${i + 1} URL`);
    url.addEventListener('input', () => { state.links[i].url = url.value; updatePreview(); });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost link-del';
    del.textContent = 'Remove';
    del.setAttribute('aria-label', `Remove link ${i + 1}`);
    del.addEventListener('click', () => { state.links.splice(i, 1); renderLinks(); updatePreview(); });

    row.append(label, url, del);
    wrap.appendChild(row);
  });
}

function addLink(link = { label: '', url: '' }) {
  if (state.links.length >= LIMITS.links) return;
  state.links.push({ label: link.label || '', url: link.url || '' });
  renderLinks();
  updatePreview();
}

function renderSuggestions(apps) {
  const legendField = $('#add-link').parentElement;
  const bar = document.createElement('div');
  bar.className = 'suggest-row';
  let any = false;
  for (const app of apps) {
    const s = SUGGESTED[app.name];
    if (!s) continue;
    any = true;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn suggest-chip';
    chip.textContent = `+ ${s.label}`;
    chip.addEventListener('click', () => {
      if (state.links.some((l) => l.url === s.url)) return;
      addLink(s);
    });
    bar.appendChild(chip);
  }
  if (any) legendField.insertBefore(bar, $('#add-link'));
}

function clearFieldErrors() {
  document.querySelectorAll('.field-err').forEach((e) => { e.textContent = ''; });
}

function showFieldErrors(errors) {
  clearFieldErrors();
  for (const err of errors) {
    const field = err.field.replace(/\[.*/, ''); // links[0].url -> links
    const el = document.querySelector(`.field-err[data-err="${field}"]`);
    if (el) el.textContent = el.textContent ? el.textContent : err.message;
  }
}

async function save() {
  let token = getSessionToken();
  if (!token) {
    setStatus('Signing in…', '');
    try {
      token = await signIn();
    } catch (err) {
      setStatus(err.message || 'Sign-in failed.', 'err');
      return;
    }
    renderAdminState();
  }

  const config = readForm();
  const local = validateHomepage(config);
  if (!local.ok) {
    showFieldErrors(local.errors);
    setStatus('Fix the highlighted fields.', 'err');
    return;
  }
  clearFieldErrors();
  setStatus('Saving and activating…');
  try {
    const res = await fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...config, activate: true }),
    });
    if (res.status === 401 || res.status === 403) { setStatus('Sign-in expired — sign in again to save.', 'err'); renderAdminState(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The content is already persisted before activation runs; a 500 here
      // means activation (going live at /) failed — most commonly an nginx
      // reload — not that the save itself failed. Say what actually happened.
      if (res.status === 500 && data.saved === true) {
        setStatus('Saved, but not live yet — nginx reload failed. Run `sudo nginx -t` on the server.', 'warn');
        return;
      }
      if (Array.isArray(data.errors)) showFieldErrors(data.errors);
      setStatus(`Could not save (${res.status}).`, 'err');
      return;
    }
    setStatus('Saved. Your homepage is now live at /.', 'ok');
  } catch {
    setStatus('Network error — is the sidecar running?', 'err');
  }
}

async function load() {
  renderThemes();
  renderLinks();

  const [hp, appsRes] = await Promise.allSettled([
    fetch(HOMEPAGE_URL).then((r) => r.json()),
    fetch(APPS_URL).then((r) => r.json()),
  ]);

  if (hp.status === 'fulfilled' && hp.value && hp.value.configured) {
    $('#title').value = hp.value.title || '';
    $('#tagline').value = hp.value.tagline || '';
    state.theme = hp.value.theme || DEFAULT_THEME;
    state.links = Array.isArray(hp.value.links)
      ? hp.value.links.slice(0, LIMITS.links).map((l) => ({ label: l.label || '', url: l.url || '' }))
      : [];
    renderThemes();
    renderLinks();
  }

  if (appsRes.status === 'fulfilled' && Array.isArray(appsRes.value?.apps)) {
    renderSuggestions(appsRes.value.apps);
  }

  updatePreview();
  renderAdminState();
}

$('#form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  save();
});
$('#add-link').addEventListener('click', () => addLink());
$('#title').addEventListener('input', updatePreview);
$('#tagline').addEventListener('input', updatePreview);
$('#admin-signin').addEventListener('click', async () => {
  setStatus('Signing in…', '');
  try {
    await signIn();
    setStatus('Signed in.', 'ok');
  } catch (err) {
    setStatus(err.message || 'Sign-in failed.', 'err');
  }
  renderAdminState();
});
$('#admin-signout').addEventListener('click', () => {
  signOut();
  renderAdminState();
  setStatus('Signed out.', '');
});

load();
