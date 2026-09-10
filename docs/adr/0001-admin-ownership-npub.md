# ADR 0001 — Admin ownership is the install npub (NIP-07), not a shared token

- Status: Accepted
- Date: 2026-09-10

## Context

torii-base's sidecar gated three admin write endpoints — `/torii/homepage`,
`/torii/set-root`, and app registration (`/torii/apps`, `DELETE /torii/apps/:name`)
— behind a generated bearer token written to `/opt/torii/env`. The operator had to
copy that token into the browser to save a homepage. This was an unmigrated legacy
leftover: Continuum, Quest, and the suite never used it, and it produced a
confusing copy-the-secret UX.

The established Torii ownership model is simpler: the operator records their
**npub** at install and proves ownership by signing in with the NIP-07 signer that
holds the matching private key. Ownership is a public-key match, not a shared
secret to remember or paste.

## Decision

1. **The install admin npub is the identity.** `TORII_ADMIN_NPUB` (passed by the
   suite as the operator's `CONTINUUM_ADMIN_NPUB`) is the sole admin identity.
   The sidecar boots fail-closed if it is absent or undecodable.

2. **Public write endpoints prove ownership with a NIP-07 sign-in.**
   `/torii/homepage` and `/torii/set-root` follow Continuum's challenge/verify
   flow: the browser fetches a single-use kind-22242 challenge, the operator's
   signer signs it, and the sidecar verifies `pubkey === admin npub` before
   minting a short-lived HMAC session token (`iat.exp.pubkey.sig`), sent as
   `Bearer <token>`. No refresh/oiat — torii-base keeps the token deliberately
   simple, with a 12h default TTL.

3. **Registration is root/loopback only, with no login.** The installer owns the
   box. `torii register` runs as root and talks to the sidecar on loopback;
   nginx blocks the `/torii/apps` write routes at the public edge, so an anon can
   never add or remove app tiles. There is no credential on this path — root +
   loopback is the gate.

4. **The bearer token is removed everywhere.** No token generation in
   `bootstrap.sh`, no token in the env file, no token input in the launcher or
   homepage editor, and the `torii` CLI no longer reads or sends one.

## Consequences

- The operator logs in once per tab with their signer; the session token lives in
  memory + `sessionStorage` (cleared on close). Nothing to copy or store.
- Anonymous callers cannot write: public writes require a valid admin-npub
  signature, and registration routes are unreachable from the public web.
- `torii set-root` is removed from the CLI (homepage/root-app changes happen in
  the browser with a sign-in); `torii register`/`unregister`/`status`/`doctor`/
  `reload` remain.
- If the admin npub must change, `TORII_ADMIN_NPUB` is updated in `/opt/torii/env`
  and the sidecar restarted — matching how the suite's `set-admin-npub.sh` already
  rotates Continuum's admin.