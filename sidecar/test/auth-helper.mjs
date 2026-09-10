// Shared test helper: a generated admin key + helpers that sign the NIP-42
// challenge and mint a real session token through the live challenge/verify
// flow. No secrets hardcoded; the key exists only for this test process.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import assert from 'node:assert/strict';

export const ADMIN_SECRET = generateSecretKey();
export const ADMIN_PUBKEY_HEX = getPublicKey(ADMIN_SECRET);
export const ADMIN_NPUB = nip19.npubEncode(ADMIN_PUBKEY_HEX);
export const SESSION_SECRET = 'test-session-secret'.padEnd(64, 'x');

/** Sign a challenge string as the admin key, returning a finished NIP-42 event. */
export function signChallenge(challenge) {
  return finalizeEvent(
    {
      kind: 22242,
      content: challenge,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['challenge', challenge],
        ['relay', 'https://example.test'],
      ],
      pubkey: ADMIN_PUBKEY_HEX,
    },
    ADMIN_SECRET,
  );
}

/** Challenge + sign + verify, returning a session token for the admin. */
export async function adminToken(app) {
  const chal = await app.inject({ method: 'POST', url: '/torii/auth/challenge' });
  assert.equal(chal.statusCode, 200, 'challenge should issue');
  const { challenge } = chal.json();
  assert.ok(challenge, 'challenge present');

  const event = signChallenge(challenge);
  const ver = await app.inject({ method: 'POST', url: '/torii/auth/verify', payload: { event } });
  assert.equal(ver.statusCode, 200, 'verify should accept the admin signature');
  const { token } = ver.json();
  assert.ok(token, 'verify returns a token');
  return token;
}

/** Ready-to-use Authorization header carrying a freshly-minted admin token. */
export async function authHeaders(app) {
  return { authorization: `Bearer ${await adminToken(app)}` };
}