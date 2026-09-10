// Shared NIP-07 admin sign-in for the launcher and homepage editor.
//
// Ownership is proven by the operator's npub, not a shared secret: this module
// signs a single-use kind-22242 challenge with window.nostr and exchanges it for
// a short-lived HMAC session token from the sidecar, then holds that token in
// memory + sessionStorage (cleared when the tab closes). Admin calls send it as
// `Authorization: Bearer <token>`.

const CHALLENGE_URL = '/torii/auth/challenge';
const VERIFY_URL = '/torii/auth/verify';
const TOKEN_KEY = 'torii.admin.session.v1';

let token = null; // in-memory session token
let tokenExp = 0;

const nowSec = () => Math.floor(Date.now() / 1000);

function readStoredToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.token === 'string' && Number(p.exp) > nowSec()) return p.token;
  } catch (_) {
    /* storage blocked/absent — ignore */
  }
  return null;
}

function storeToken(t, exp) {
  token = t || null;
  tokenExp = Number(exp) || 0;
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: t, exp: tokenExp }));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch (_) {
    /* ignore */
  }
}

export function hasSigner() {
  return typeof window !== 'undefined' && !!(window.nostr && window.nostr.signEvent);
}

export function getSessionToken() {
  if (token && tokenExp > nowSec()) return token;
  const stored = readStoredToken();
  if (stored) {
    token = stored;
    return stored;
  }
  return null;
}

export function isSignedIn() {
  return !!getSessionToken();
}

/**
 * Challenge -> NIP-07 sign -> verify -> session token.
 * @returns {Promise<string>} the session token
 * @throws {Error} with a human-readable message on any failure
 */
export async function signIn() {
  if (!hasSigner()) {
    throw new Error('No NIP-07 signer found. Install a signer extension (nos2x, Alby, Amber…) and reload.');
  }

  const chal = await fetch(CHALLENGE_URL, { method: 'POST', credentials: 'same-origin' });
  if (!chal.ok) throw new Error(`Could not request a sign-in challenge (${chal.status}).`);
  const { challenge } = await chal.json();
  if (!challenge) throw new Error('Malformed sign-in challenge.');

  // Fold the pubkey into the event up front so the signer's id/sig hash over a
  // complete event (NIP-07 signers vary on whether they backfill pubkey).
  let pubkey;
  try {
    if (window.nostr.getPublicKey) pubkey = await window.nostr.getPublicKey();
  } catch (_) {
    /* signer may not expose it; let signEvent fill it */
  }

  const event = await window.nostr.signEvent({
    kind: 22242,
    content: challenge,
    created_at: nowSec(),
    tags: [
      ['challenge', challenge],
      ['relay', window.location.origin],
    ],
    ...(pubkey ? { pubkey } : {}),
  });

  const ver = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ event }),
  });
  if (!ver.ok) {
    const body = await ver.json().catch(() => ({}));
    throw new Error(body.error || `Sign-in rejected (${ver.status}).`);
  }
  const { token: t, expires_at } = await ver.json();
  if (!t) throw new Error('Sign-in returned no session.');
  storeToken(t, expires_at);
  return t;
}

export function signOut() {
  storeToken(null, 0);
}

// Attach a global handle so pages can consume the session without importing this
// module directly (keeps create.js / launcher.js importable by the node test
// harness, which cannot resolve URL imports). Load this module before the page
// script in each HTML file.
if (typeof window !== 'undefined') {
  window.ToriiAdmin = { getSessionToken, isSignedIn, signIn, signOut, hasSigner };
}