// Shared homepage module: validation rules, URL sanitising, and the rendered
// HTML being escaped + script-free. This module backs both the browser editor
// preview and the server-side render, so these are the load-bearing tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHomepage, renderHomepage, sanitizeUrl, THEMES, LIMITS, DEFAULT_THEME,
} from '../../launcher/assets/homepage-render.mjs';

test('valid config passes and is normalised', () => {
  const r = validateHomepage({
    title: '  My Torii  ',
    tagline: 'hi',
    theme: 'matrix',
    links: [{ label: 'Quest', url: '/quest/' }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.title, 'My Torii');
  assert.equal(r.value.theme, 'matrix');
  assert.equal(r.value.links.length, 1);
});

test('title is required and length-capped', () => {
  assert.equal(validateHomepage({ title: '' }).ok, false);
  assert.equal(validateHomepage({ title: '   ' }).ok, false);
  const long = validateHomepage({ title: 'x'.repeat(LIMITS.title + 1) });
  assert.equal(long.ok, false);
  assert.ok(long.errors.some((e) => e.field === 'title'));
});

test('tagline over the cap is rejected', () => {
  const r = validateHomepage({ title: 'ok', tagline: 'y'.repeat(LIMITS.tagline + 1) });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'tagline'));
});

test('unknown theme is rejected and falls back to default value', () => {
  const r = validateHomepage({ title: 'ok', theme: 'neon-chaos' });
  assert.equal(r.ok, false);
  assert.equal(r.value.theme, DEFAULT_THEME);
});

test('sanitizeUrl allows site-relative and http(s), rejects the rest', () => {
  assert.equal(sanitizeUrl('/quest/'), '/quest/');
  assert.equal(sanitizeUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeUrl('data:text/html,<b>'), null);
  assert.equal(sanitizeUrl('//evil.example'), null);
  assert.equal(sanitizeUrl('mailto:a@b.c'), null);
  assert.equal(sanitizeUrl('x'.repeat(LIMITS.linkUrl + 1)), null);
});

test('links with bad urls or missing labels are flagged; too many rejected', () => {
  const r = validateHomepage({
    title: 'ok',
    links: [{ label: 'bad', url: 'javascript:1' }, { label: '', url: '/x' }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field.startsWith('links[0]')));
  assert.ok(r.errors.some((e) => e.field.startsWith('links[1]')));

  const many = validateHomepage({
    title: 'ok',
    links: Array.from({ length: LIMITS.links + 2 }, (_, i) => ({ label: `l${i}`, url: '/x' })),
  });
  assert.ok(many.errors.some((e) => e.field === 'links'));
});

test('fully-empty link rows are dropped, not errored', () => {
  const r = validateHomepage({ title: 'ok', links: [{ label: '', url: '' }] });
  assert.equal(r.ok, true);
  assert.equal(r.value.links.length, 0);
});

test('render escapes hostile content and never emits a script tag', () => {
  const html = renderHomepage({
    title: '<script>alert(1)</script>',
    tagline: 'a & b "c" <d>',
    theme: 'midnight',
    links: [{ label: '<img>', url: '/quest/' }],
  });
  assert.equal(/<script/i.test(html), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('a &amp; b &quot;c&quot; &lt;d&gt;'));
  assert.ok(html.includes('&lt;img&gt;'));
  assert.ok(html.includes("script-src 'none'") || html.includes("default-src 'none'"));
});

test('render works with no links (missing optional apps)', () => {
  const html = renderHomepage({ title: 'Solo', theme: 'sakura', links: [] });
  assert.ok(html.includes('Solo'));
  assert.equal(html.includes('<ul class="links">'), false);
});

test('render includes a route back to the editor', () => {
  const html = renderHomepage({ title: 'x' });
  assert.ok(html.includes('/assets/create.html'));
});

test('every theme renders', () => {
  for (const t of THEMES) {
    const html = renderHomepage({ title: 'T', theme: t.id });
    assert.ok(html.includes(t.accent), `theme ${t.id} should embed its accent`);
  }
});
