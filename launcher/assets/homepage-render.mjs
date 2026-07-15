// Shared homepage validation + rendering. Pure ESM, zero dependencies, so it
// runs unchanged in the browser (live preview in the editor) and in the
// sidecar (server-side render to a static file). Keeping a single source of
// truth means the preview a user sees is byte-for-byte what gets activated.
//
// Security posture: this module NEVER emits user content unescaped and NEVER
// emits <script>. All string interpolation goes through escapeHtml; URLs go
// through sanitizeUrl (relative-path or http(s) only). The rendered page
// carries a strict CSP meta (script-src 'none') as defence in depth.

export const LIMITS = Object.freeze({
  title: 60,
  tagline: 160,
  linkLabel: 40,
  linkUrl: 512,
  links: 8,
});

// Curated, self-hosted themes. Each is a small palette; "funk" comes from
// gradients + accent, not from external assets or fonts. All values are
// baked into an inline <style> at render time, so there are no runtime deps.
export const THEMES = Object.freeze([
  { id: 'vermilion', label: 'Vermilion (Torii)', bg: '#0b0d10', card: '#12161b', fg: '#e8ecef', mute: '#8b95a1', accent: '#d94f2c', glow: 'radial-gradient(1200px 600px at 20% -10%, #2a1109 0%, transparent 60%)' },
  { id: 'midnight', label: 'Midnight', bg: '#080b1a', card: '#111634', fg: '#e6e9ff', mute: '#8890c0', accent: '#6c7bff', glow: 'radial-gradient(1000px 500px at 80% -10%, #1a2050 0%, transparent 55%)' },
  { id: 'sakura', label: 'Sakura', bg: '#fff5f7', card: '#ffffff', fg: '#3a1e28', mute: '#9c6b78', accent: '#e5578a', glow: 'radial-gradient(1000px 500px at 10% -10%, #ffd9e6 0%, transparent 60%)' },
  { id: 'matrix', label: 'Terminal', bg: '#05100a', card: '#0a1c12', fg: '#c6ffd8', mute: '#5f9f79', accent: '#31d874', glow: 'radial-gradient(900px 500px at 50% -10%, #0b3320 0%, transparent 60%)' },
  { id: 'sunset', label: 'Sunset', bg: '#1a0f14', card: '#241419', fg: '#ffece2', mute: '#c79a8b', accent: '#ff8a3d', glow: 'radial-gradient(1100px 600px at 30% -10%, #4a1e10 0%, transparent 55%)' },
]);

const THEME_IDS = new Set(THEMES.map((t) => t.id));
export const DEFAULT_THEME = 'vermilion';

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Collapse whitespace + strip control chars. Homepage content is plain text.
const cleanText = (s) => String(s ?? '')
  .replace(/[\x00-\x1f\x7f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Accept only same-origin relative paths ("/quest/") or absolute http(s)
// URLs. Everything else (javascript:, data:, mailto:, protocol-relative //)
// is rejected. Returns a safe string or null.
export function sanitizeUrl(raw) {
  const v = cleanText(raw);
  if (!v || v.length > LIMITS.linkUrl) return null;
  if (v.startsWith('//')) return null;              // protocol-relative
  if (v.startsWith('/') && !v.startsWith('/\\')) return v; // site-relative
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    return null;
  } catch {
    return null;
  }
}

// Validate arbitrary input into a clean config. Never throws.
// Returns { ok, errors: [{field,message}], value }.
export function validateHomepage(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};

  const title = cleanText(src.title);
  if (!title) errors.push({ field: 'title', message: 'Title is required.' });
  else if (title.length > LIMITS.title) errors.push({ field: 'title', message: `Title must be ${LIMITS.title} characters or fewer.` });

  const tagline = cleanText(src.tagline);
  if (tagline.length > LIMITS.tagline) errors.push({ field: 'tagline', message: `Tagline must be ${LIMITS.tagline} characters or fewer.` });

  let theme = cleanText(src.theme) || DEFAULT_THEME;
  if (!THEME_IDS.has(theme)) {
    errors.push({ field: 'theme', message: 'Unknown theme.' });
    theme = DEFAULT_THEME;
  }

  const rawLinks = Array.isArray(src.links) ? src.links : [];
  if (rawLinks.length > LIMITS.links) errors.push({ field: 'links', message: `At most ${LIMITS.links} links.` });
  const links = [];
  for (let i = 0; i < rawLinks.length && links.length < LIMITS.links; i++) {
    const l = rawLinks[i] || {};
    const label = cleanText(l.label);
    const url = sanitizeUrl(l.url);
    if (!label && !l.url) continue; // skip fully-empty rows
    if (!label) { errors.push({ field: `links[${i}].label`, message: 'Link label is required.' }); continue; }
    if (label.length > LIMITS.linkLabel) { errors.push({ field: `links[${i}].label`, message: `Link label must be ${LIMITS.linkLabel} characters or fewer.` }); continue; }
    if (!url) { errors.push({ field: `links[${i}].url`, message: 'Link URL must be a "/path" or http(s) URL.' }); continue; }
    links.push({ label, url });
  }

  return {
    ok: errors.length === 0,
    errors,
    value: { title, tagline, theme, links },
  };
}

function themeStyle(theme) {
  const t = THEMES.find((x) => x.id === theme) || THEMES[0];
  return `:root{--bg:${t.bg};--card:${t.card};--fg:${t.fg};--mute:${t.mute};--accent:${t.accent}}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);background-image:${t.glow};background-repeat:no-repeat;color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;min-height:100vh}
.wrap{max-width:720px;margin:0 auto;padding:14vh 24px 64px}
.hero h1{font-size:clamp(30px,7vw,52px);line-height:1.05;letter-spacing:-.02em;margin:0 0 14px;font-weight:800;background:linear-gradient(120deg,var(--fg),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{font-size:clamp(16px,2.4vw,20px);color:var(--mute);margin:0 0 40px;max-width:52ch}
.links{list-style:none;padding:0;margin:0;display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:560px){.links{grid-template-columns:1fr 1fr}}
.links a{display:flex;align-items:center;justify-content:space-between;gap:12px;text-decoration:none;color:var(--fg);background:var(--card);border:1px solid color-mix(in srgb,var(--fg) 12%,transparent);border-radius:12px;padding:16px 18px;font-weight:600;transition:transform .12s ease,border-color .12s ease}
.links a:hover{transform:translateY(-2px);border-color:var(--accent)}
.links a::after{content:"\\2192";color:var(--accent);font-weight:700}
.links a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
footer{margin-top:56px;padding-top:20px;border-top:1px solid color-mix(in srgb,var(--fg) 12%,transparent);font-size:12px;color:var(--mute)}
footer a{color:var(--mute)}
@media(prefers-reduced-motion:reduce){.links a{transition:none}}`;
}

// Render a full, self-contained HTML document. `opts.editorPath` is the
// route back to the Torii editor/launcher (defaults to the editor page).
export function renderHomepage(config, opts = {}) {
  const v = validateHomepage(config).value;
  const editorPath = typeof opts.editorPath === 'string' ? opts.editorPath : '/assets/create.html';
  const linksHtml = v.links.length
    ? `<ul class="links">${v.links.map((l) => `<li><a href="${escapeHtml(l.url)}"${/^https?:/i.test(l.url) ? ' rel="noopener noreferrer"' : ''}>${escapeHtml(l.label)}</a></li>`).join('')}</ul>`
    : '';
  const taglineHtml = v.tagline ? `<p>${escapeHtml(v.tagline)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(v.title)}</title>
<style>${themeStyle(v.theme)}</style>
</head>
<body>
<main class="wrap">
<div class="hero">
<h1>${escapeHtml(v.title)}</h1>
${taglineHtml}
</div>
${linksHtml}
<footer>Made with <a href="${escapeHtml(editorPath)}">Torii</a></footer>
</main>
</body>
</html>
`;
}
