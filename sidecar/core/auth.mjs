/**
 * NIP-07 login + session tokens for the torii-base launcher.
 *
 * Mirrors torii-continuum's agent core/auth.mjs. Ownership is proven by the
 * operator's npub, not by a shared secret: the browser signs a NIP-42
 * (kind 22242) challenge with a NIP-07 signer, and the server accepts it only
 * if the signer's pubkey is the admin npub recorded at install.
 *
 * Flow:
 *   1. POST /torii/auth/challenge -> { challenge, expires_in, kind: 22242 }
 *   2. Browser signs `{ kind: 22242, content: challenge,
 *                        tags: [['challenge', challenge], ['relay', origin]] }`
 *   3. POST /torii/auth/verify { event } -> server verifies:
 *        - event.pubkey === admin npub (hex)
 *        - kind === 22242, a matching 'challenge' tag, content === challenge
 *        - id + signature verifies (nostr-tools verifyEvent)
 *      On success it mints an HMAC-signed session token. No server-side
 *      session state; revoke by rotating session_secret.
 *   4. Subsequent admin calls send `Authorization: Bearer <token>`.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyEvent, getEventHash } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

const CHALLENGE_TTL_SEC = 5 * 60;
const CHALLENGE_KIND = 22242;
const DEFAULT_MAX_CHALLENGES = 1000;
const DEFAULT_SESSION_TTL_SEC = 12 * 60 * 60; // 12h

/**
 * @param {object} cfg
 * @param {string} cfg.admin_npub       bech32 npub1... of the admin (from install)
 * @param {string} cfg.session_secret   >=32-char random secret for HMAC tokens
 * @param {number} [cfg.session_ttl_sec]
 * @param {number} [cfg.max_challenges]
 */
export function createAuth(cfg) {
  const sessionTtl =
    Number.isFinite(cfg.session_ttl_sec) && cfg.session_ttl_sec > 0
      ? cfg.session_ttl_sec
      : DEFAULT_SESSION_TTL_SEC;
  const maxChallenges =
    Number.isFinite(cfg.max_challenges) && cfg.max_challenges > 0
      ? cfg.max_challenges
      : DEFAULT_MAX_CHALLENGES;

  const sessionSecret = cfg.session_secret;
  if (!sessionSecret || typeof sessionSecret !== 'string' || sessionSecret.length < 32) {
    throw new Error('auth: session_secret must be a string of at least 32 characters');
  }

  // Decode the admin npub to hex once. A missing/undecodable admin_npub is a
  // hard misconfiguration: fail closed at boot rather than run with no owner.
  let adminHex;
  try {
    const decoded = nip19.decode(cfg.admin_npub);
    if (decoded.type !== 'npub') throw new Error('not an npub');
    adminHex = decoded.data;
  } catch (e) {
    throw new Error(`auth: admin_npub decode failed: ${e.message}`);
  }
  const adminNpub = cfg.admin_npub;

  const now = () => Math.floor(Date.now() / 1000);
  const challenges = new Map(); // challenge -> { expiresAt, ip }

  function gc() {
    const t = now();
    for (const [k, v] of challenges) {
      if (v.expiresAt < t) challenges.delete(k);
    }
  }

  function issueChallenge(clientIp) {
    gc();
    // Bound the pending-challenge set so a flood cannot grow memory unbounded.
    if (challenges.size >= maxChallenges) {
      let oldest = null;
      for (const e of challenges) {
        if (!oldest || e[1].expiresAt < oldest[1].expiresAt) oldest = e;
      }
      if (oldest) challenges.delete(oldest[0]);
    }
    const challenge = randomBytes(24).toString('hex');
    challenges.set(challenge, { expiresAt: now() + CHALLENGE_TTL_SEC, ip: clientIp });
    return { challenge, expires_in: CHALLENGE_TTL_SEC };
  }

  /**
   * @returns {Promise<{ok:true, token:string, expires_at:number} |
   *                    {ok:false, code:string, reason:string}>}
   */
  async function verifyChallenge(event) {
    if (!event || typeof event !== 'object') {
      return { ok: false, code: 'malformed_event', reason: 'no event' };
    }
    if (event.kind !== CHALLENGE_KIND) {
      return { ok: false, code: 'wrong_kind', reason: 'wrong kind (expected 22242)' };
    }
    if (event.pubkey !== adminHex) {
      return { ok: false, code: 'not_owner', reason: 'pubkey is not admin npub' };
    }

    const tag = (event.tags || []).find((t) => Array.isArray(t) && t[0] === 'challenge');
    if (!tag || !tag[1]) {
      return { ok: false, code: 'malformed_event', reason: 'missing challenge tag' };
    }
    const challenge = tag[1];

    const entry = challenges.get(challenge);
    if (!entry) {
      return { ok: false, code: 'challenge_expired', reason: 'unknown or expired challenge' };
    }
    if (entry.expiresAt < now()) {
      challenges.delete(challenge);
      return { ok: false, code: 'challenge_expired', reason: 'expired challenge' };
    }

    if (event.content && event.content !== challenge) {
      return { ok: false, code: 'malformed_event', reason: 'content/tag mismatch' };
    }

    let sigOk = false;
    try {
      if (getEventHash(event) !== event.id) {
        return { ok: false, code: 'malformed_event', reason: 'id mismatch' };
      }
      sigOk = verifyEvent(event);
    } catch (e) {
      return { ok: false, code: 'bad_signature', reason: `sig verify threw: ${e.message}` };
    }
    if (!sigOk) {
      return { ok: false, code: 'bad_signature', reason: 'bad signature' };
    }

    // Single-use: consume the challenge once a signature has verified.
    challenges.delete(challenge);

    const token = issueSessionToken();
    return { ok: true, token: token.token, expires_at: token.expiresAt };
  }

  function issueSessionToken() {
    const iat = now();
    const exp = iat + sessionTtl;
    const payload = `${iat}.${exp}.${adminHex}`;
    const sig = createHmac('sha256', sessionSecret).update(payload).digest('hex');
    return { token: `${payload}.${sig}`, expiresAt: exp };
  }

  /**
   * @returns {{ok:boolean, npub?:string, exp?:number, reason?:string}}
   */
  function verifySessionToken(token) {
    if (!token || typeof token !== 'string') return { ok: false, reason: 'no token' };
    const parts = token.split('.');
    if (parts.length !== 4) return { ok: false, reason: 'malformed' };
    const [iatStr, expStr, pk, sig] = parts;
    const iat = parseInt(iatStr, 10);
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return { ok: false, reason: 'bad timestamps' };
    if (exp < now()) return { ok: false, reason: 'expired' };
    if (pk !== adminHex) return { ok: false, reason: 'not admin pubkey' };

    const expected = createHmac('sha256', sessionSecret)
      .update(`${iat}.${exp}.${pk}`)
      .digest('hex');
    let match = false;
    try {
      match = timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return { ok: false, reason: 'sig length mismatch' };
    }
    if (!match) return { ok: false, reason: 'bad signature' };

    return { ok: true, npub: adminNpub, exp, iat };
  }

  return {
    issueChallenge,
    verifyChallenge,
    verifySessionToken,
    adminNpub: () => adminNpub,
    _challenges: challenges, // test hook
  };
}