// Frontend: the homepage creator must expose a single primary action. The old
// two-button split ("Save" vs "Save & activate") confused operators into
// thinking the token had failed or the form was broken, and a separate "Reset
// to launcher" duplicated the launcher's own "Unset homepage" control. Both are
// gone: exactly one action button ("Save & activate") remains.

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

test('create.html has a single action: "Save & activate"', async () => {
  const html = await readFile(CREATE_HTML, 'utf8');
  const dom = new JSDOM(html);
  const actions = [...dom.window.document.querySelectorAll('.editor-actions button')];
  assert.equal(actions.length, 1, 'expected exactly one action button in the footer');
  assert.equal(actions[0].textContent.trim(), 'Save & activate');
  assert.equal(actions[0].getAttribute('type'), 'submit');
  assert.equal(actions[0].hasAttribute('data-activate'), false, 'stale data-activate flag is gone');
  // The redundant "Reset to launcher" (duplicated by the launcher's own
  // "Unset homepage") must not come back.
  assert.equal(dom.window.document.getElementById('reset-root'), null);
});

test('create.html hint shows a value-only token command', async () => {
  const html = await readFile(CREATE_HTML, 'utf8');
  assert.match(html, /cut -d= -f2-/);
});