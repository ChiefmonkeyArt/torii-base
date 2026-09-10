// Frontend: the homepage creator must expose a single primary action. The old
// two-button split ("Save" vs "Save & activate") confused operators into
// thinking the token had failed or the form was broken. This guards against a
// second submit button creeping back, and checks the token hint gives a
// value-only command (so nobody pastes the `KEY=` prefix and gets a 401).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CREATE_HTML = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'launcher', 'assets', 'create.html',
);

test('create.html has exactly one submit action, labelled "Save & activate"', async () => {
  const html = await readFile(CREATE_HTML, 'utf8');
  const dom = new JSDOM(html);
  const buttons = [...dom.window.document.querySelectorAll('button[type="submit"]')];
  assert.equal(buttons.length, 1, 'expected a single primary submit button');
  assert.equal(buttons[0].textContent.trim(), 'Save & activate');
  assert.equal(buttons[0].hasAttribute('data-activate'), false, 'stale data-activate flag is gone');
});

test('create.html hint shows a value-only token command', async () => {
  const html = await readFile(CREATE_HTML, 'utf8');
  assert.match(html, /cut -d= -f2-/);
});