// Frontend: the launcher greys out the "Set as homepage" control for
// Continuum and never fires set-root for it, while other apps (Quest) keep
// a working, clickable control.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SET_ROOT_URL = '/torii/set-root';
const LAUNCHER_JS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'launcher', 'assets', 'launcher.js',
);

let renderTile;
let isRootAllowed;
let NO_HOMEPAGE_COPY;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = dom.window.requestAnimationFrame || (() => {});
  ({ renderTile, isRootAllowed, NO_HOMEPAGE_COPY } = await import(LAUNCHER_JS));
});

const continuum = { name: 'continuum', display_name: 'Continuum', description: 'App builder' };
const quest = { name: 'quest', display_name: 'Quest', description: 'WebGL arena' };

test('policy mirror: continuum blocked, quest allowed', () => {
  assert.equal(isRootAllowed('continuum'), false);
  assert.equal(isRootAllowed('quest'), true);
});

test('continuum tile renders a disabled, accessible homepage control', () => {
  const tile = renderTile(continuum, false);
  const openLink = tile.querySelector('a.btn-primary');
  const setBtn = tile.querySelector('button[data-action="set"]');

  // Launching is untouched.
  assert.ok(openLink);
  assert.equal(openLink.getAttribute('href'), '/continuum/');

  // Promotion control is present but visibly + programmatically disabled.
  assert.ok(setBtn);
  assert.equal(setBtn.disabled, true);
  assert.equal(setBtn.getAttribute('aria-disabled'), 'true');
  assert.equal(setBtn.getAttribute('title'), NO_HOMEPAGE_COPY);
  assert.match(setBtn.getAttribute('aria-label'), new RegExp(NO_HOMEPAGE_COPY));
  assert.ok(setBtn.classList.contains('btn-disabled'));

  const note = tile.querySelector('.tile-note');
  assert.ok(note);
  assert.equal(note.textContent, NO_HOMEPAGE_COPY);
});

test('clicking the continuum control never fires set-root', () => {
  const calls = [];
  global.fetch = (url) => { calls.push(url); return new Promise(() => {}); };
  const tile = renderTile(continuum, false);
  tile.querySelector('button[data-action="set"]').click();
  assert.deepEqual(calls, []);
});

test('quest tile keeps an enabled control that fires set-root on click', () => {
  const calls = [];
  global.fetch = (url) => { calls.push(url); return new Promise(() => {}); };
  const tile = renderTile(quest, false);
  const setBtn = tile.querySelector('button[data-action="set"]');

  assert.ok(setBtn);
  assert.equal(setBtn.disabled, false);
  assert.equal(setBtn.getAttribute('aria-disabled'), null);
  assert.equal(setBtn.textContent, 'Set as homepage');
  assert.equal(tile.querySelector('.tile-note'), null);

  setBtn.click();
  assert.deepEqual(calls, [SET_ROOT_URL]);
});

test('the homepage (root) app still offers an unset control', () => {
  const tile = renderTile(quest, true);
  assert.ok(tile.querySelector('button[data-action="unset"]'));
  assert.equal(tile.querySelector('button[data-action="set"]'), null);
});
