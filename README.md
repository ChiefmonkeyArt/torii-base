# torii-base

The host layer for a Torii VPS. Installs nginx, a launcher page at `/`,
and a small sidecar service so apps like [Torii Continuum](https://github.com/ChiefmonkeyArt/torii-continuum),
[Plebeian Market](https://plebeian.market), and Torii Quest can be
mounted side-by-side at fixed sub-paths on the same domain.

```
https://your-domain.com/                — Torii launcher (or promoted app)
https://your-domain.com/continuum/      — Continuum Console
https://your-domain.com/plebeian/       — Plebeian marketplace
https://your-domain.com/quest/          — Torii Quest (WebGL arena)
```

Only the launcher and sidecar ship in this repo. Individual apps register
themselves after they're installed.

---

## Install

**Requirements:** Ubuntu 22.04 or 24.04, a DNS A record pointing at the VPS,
and root (or a passwordless-sudo user).

```bash
git clone https://github.com/ChiefmonkeyArt/torii-base.git
cd torii-base
# Your install admin npub — a NIP-07 signer's public key (never an nsec):
export TORII_ADMIN_NPUB=npub1...
sudo -E ./bootstrap.sh --domain your-domain.com --email you@your-domain.com
```

What it does:

- Installs `nginx`, `certbot`, `node@22`, and common utilities.
- Creates a `torii` OS user for the sidecar.
- Writes `/opt/torii/env` with your admin `npub` and a generated session secret.
- Installs the launcher, the main nginx server block, and the sidecar.
- Obtains a Let's Encrypt certificate (skip with `--no-letsencrypt`).
- Enables `torii-base-sidecar.service`.

After it finishes, visit `https://your-domain.com/` — you'll see an empty
launcher waiting for apps to register.

---

## `torii` CLI

The sidecar exposes a small REST API on `127.0.0.1:8780`. Everything you
need day-to-day is wrapped by the `torii` CLI on the host.

```bash
sudo torii register continuum --display "Continuum" --desc "App builder + agent" --version 0.3.0
sudo torii unregister quest
sudo torii status
sudo torii doctor
sudo torii reload                      # re-validate + reload nginx
```

Setting the homepage / root app is done in the browser: open the launcher, pick
a tile, and use "Set as homepage" (signed with your NIP-07 signer — the same
npub you set at install).

`torii doctor` verifies:

- Host layer (nginx config, sidecar reachability, launcher present).
- Registered apps respond on their mount paths.
- Continuum agent health, Routstr reachability, Ollama reachability, and
  the Cashu wallet directory (when Continuum is installed).

---

## Launcher

Static page at `/` that reads `/torii/apps.json` and renders one tile per
registered app. Each tile has an "Open" link and a "Set as homepage"
button; picking a homepage flips `root_app` in `registry.json` and the
next nginx reload swaps the `/` include from the launcher to a 302
redirect.

The launcher is dark-first — a privacy-first amber/orange/bronze palette
(Continuum amber, `hsl(38 92% 58%)`) — and has no dependencies: vanilla
HTML/CSS/JS, no third-party CDNs, fonts, or telemetry.

---

## Personal homepage

The launcher has a **Create a homepage** action (`/assets/create.html`) that
builds a small, funky front door for the domain. It's deliberately basic:

- **Fields:** title, optional tagline, one of a few curated self-hosted
  themes, and up to 8 links. Installed integrations (Torii Quest, Plebeian
  Market) are offered as one-click link suggestions when registered; absent
  apps are simply not suggested — nothing hard-fails.
- **Live preview:** the editor renders the exact output in a sandboxed
  iframe using the same `homepage-render.mjs` module the sidecar uses, so the
  preview is byte-for-byte what gets served.
- **Save / activate:** saving writes `homepage.json` and renders a static
  `homepage/index.html` (both atomic). *Save & activate* also promotes the
  homepage to `/`; nginx then serves the static file directly. A **Reset to
  launcher** button reverts `/`.
- **Route back:** the rendered page carries a "Made with Torii" link back to
  the editor, and the editor links back to the launcher.

Security: the homepage never accepts or renders arbitrary HTML/JS. All
content is escaped, lengths are capped, and link URLs must be a site-relative
`/path` or an `http(s)` URL. The rendered document contains **no scripts** and
ships a strict CSP (`script-src 'none'`). No third-party CDNs, fonts, or
telemetry. Admin auth (a NIP-07 sign-in proving you hold your install npub) is
required to save, activate, or reset, same as `set-root`.

Recovery: if `root_app` is `homepage` but the rendered file is missing, the
sidecar resets `/` to the launcher on boot so a broken homepage can never
strand the domain.

Upgrades: `torii.conf` no longer carries a `location = /` fallback —
`root_app.conf` is the single owner of `/`, and the sidecar's boot
reconciliation rewrites a stale (pre-0.1.3, comment-only) `root_app.conf` into
the correct block. Because that reconcile only runs at process start,
`bootstrap.sh` **restarts** `torii-base-sidecar.service` on every run (not
`enable --now`, which is a no-op for an already-running service) so an upgraded
host loads the new code and fixes its `/` include. Because the unit is
`Type=simple`, `restart` returns before reconcile has run, so bootstrap then
blocks on `/torii/healthz` (via `lib/wait-for-sidecar.sh`) — the sidecar
reconciles `root_app.conf` *before* it listens, so a healthy response proves `/`
has a valid owner. bootstrap only validates/reloads nginx after that gate, and
fails closed (leaving the existing config intact) if the sidecar never comes up.

---

## Layout

```
/opt/torii/
  env                            # TORII_ADMIN_NPUB, TORII_SESSION_SECRET, TORII_DOMAIN, etc.
  registry.json                  # apps registered on this host
  root_app.conf                  # nginx include for `/` (launcher/redirect/homepage)
  homepage.json                  # saved personal-homepage config
  homepage/index.html            # rendered personal homepage (served at / when active)
  launcher/                      # static assets served at /
  nginx-fragments/               # each app drops its own <name>.conf here

/etc/nginx/sites-available/
  torii                          # main server block; includes fragments + root_app

/usr/local/bin/
  torii                          # the CLI
```

---

## Registering another app

Apps are expected to:

1. Build their frontend to a directory the nginx user can read.
2. Drop an nginx `location` fragment at `/opt/torii/nginx-fragments/<name>.conf`.
3. Call `torii register <name> "<label>" <mount> "<description>"`.
4. Call `torii reload` (or just `nginx -s reload`).

The [Continuum Ansible installer](https://github.com/ChiefmonkeyArt/torii-continuum/tree/main/ops/ansible)
does all of this automatically.

---

## Security notes

- The sidecar binds to `127.0.0.1:8780` only. All external traffic goes
  through nginx.
- Ownership is your install `npub`. `/torii/homepage` and `/torii/set-root`
  require a NIP-07 sign-in proving you hold that key — no shared secret to copy.
- Registration (`/torii/apps`, `DELETE /torii/apps/:name`) is root/loopback only:
  nginx blocks those write routes publicly, so only the on-box `torii register`
  (as root) can add or remove app tiles.
- Systemd unit is hardened: `NoNewPrivileges`, `ProtectSystem=full`,
  `ReadWritePaths=/opt/torii`.
- The launcher and `apps.json` are public. If you don't want the world to
  know what you host, set an app as homepage in the browser so `/` redirects
  to your chosen app and never shows the launcher.

---

## License

MIT — see LICENSE.
