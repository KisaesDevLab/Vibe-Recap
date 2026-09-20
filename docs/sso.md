# Single sign-on (Vibe Auth) — operator notes

Vibe Recap can let staff sign in through the firm's identity provider instead of a local
password. The identity provider is **Vibe Auth** (bundled authentik plus a broker); Recap talks to
it through `@kisaesdevlab/vibe-auth`, OIDC authorization code with PKCE. Decision record:
`QUESTIONS.md` Q57 to Q60.

Single sign-on is **off until you turn it on**. With `VIBE_AUTH_MODE` unset Recap behaves exactly
as it did before. Local accounts, invites, password reset and the `/setup` page are unchanged in
`local` and `both`.

| Mode | Sign-in page | Who can use a local password |
|---|---|---|
| `local` (default) | the password form | everyone |
| `both` | a **Sign in with …** button above the password form | everyone |
| `oidc_only` | the button only | the break-glass account, at `/login/local` |

The mode is seeded from the environment and can be changed at **Settings › Authentication**
(admins only). What that page stores overrides the environment. Switching to `oidc_only` there is
refused until a break-glass account exists and a *Test connection* has succeeded in that session.

What does not change: nothing from a return goes to the identity provider. It learns that a
person signed in to Recap, and tells Recap that person's email, name and groups. The worker is
untouched and still has no route out.

---

## Environment

Written by the broker when Recap is registered; paste the block it returns into `.env` (the
appliance writes it into `/opt/vibe/env/vibe-recap.env` itself):

```
VIBE_OIDC_ISSUER=http://<host>/auth/application/o/vibe-recap/
VIBE_OIDC_INTERNAL_BASE=http://vibe-auth-authentik-server:9000   # origin only; omit if the broker is on another host
VIBE_OIDC_CLIENT_ID=vibe-vibe-recap-<12 hex>
VIBE_OIDC_CLIENT_SECRET=<secret>
VIBE_OIDC_PUBLIC_URL=http://<host>:5183        # Recap's public base, no trailing slash
VIBE_OIDC_IDP_NAME=Vibe Auth
```

Set by you:

```
VIBE_AUTH_MODE=local|both|oidc_only            # default local
VIBE_OIDC_ROLE_MAP={"vibe-admin":"admin",...}  # optional; the default map is below
VIBE_OIDC_ALLOW_JIT=true                       # create accounts on first sign-in
VIBE_OIDC_REQUIRE_MFA_AMR=false                # true = refuse a sign-in the IdP did not second-factor
VIBE_BREAKGLASS_USERNAME=vibe-breakglass
```

An empty value counts as unset. `VIBE_OIDC_PUBLIC_URL` must carry the scheme the browser really
uses: `http://` on a LAN IP (Caddy issues no certificate for a bare IP), `https://` in domain mode.
The redirect URI is `VIBE_OIDC_PUBLIC_URL + /auth/oidc/callback` and authentik matches it
**exactly**. `compose.yml` passes every one of these through to the api container.

A client secret saved from Settings › Authentication is stored wrapped with the master key, the
same key as the documents (`/data/keys/master.key`). `rotate-master-key` carries it across.

### Roles

Accounts are created on first sign-in with a role mapped from the person's Vibe groups, and the
role is **re-synced on every sign-in**: change someone's group in authentik and their role here
follows next time they sign in.

| Vibe group | Recap role |
|---|---|
| `vibe-admin`, `vibe-it`, `vibe-partner` | `admin` |
| `vibe-manager` | `preparer` |
| `vibe-staff` | `staff` |

A user in none of these is refused (`no_role`); nobody lands as `viewer` by accident. An existing
local account is linked to its identity the first time that person signs in through the identity
provider, by email, and only when the provider says the email is verified. After that the link is
the provider's subject id, so a later email change does not break it.

**The last admin is never demoted by a role sync.** If the firm's only active admin signs in
through the identity provider while their groups map lower, the role is kept and a
`vibe.auth.role.changed` row with `refused: true` is written. Put that person in `vibe-admin`, or
make a second admin first. The break-glass account does not count as one, here or under
Settings › Users.

### Accounts that exist only through single sign-on

An account created by a first sign-in has a random password nobody knows and is marked
**single sign-on only** (the badge under Settings › Users). It **cannot use "Forgot your
password?"**: the request gets the same answer as one for an unknown address, no email is sent,
and `auth.password_reset_refused` is audited with `why: sso_only_account`. Otherwise whoever can
read that mailbox could mint a local password for a person whose factors live at the identity
provider.

If the firm runs `both` and that person should also be able to sign in locally, an admin sets a
temporary password or emails a reset link from Settings › Users. Either clears the mark. That is
the same trust an admin already exercises creating any account.

---

## Break-glass account

`oidc_only` hides the password form from everyone, so there must be a way in when the identity
provider is down. That is the break-glass account: a local admin, username `vibe-breakglass`
(stored under `vibe-breakglass@vibe-recap.local`, because Recap signs people in by email). **The
api refuses to start in `oidc_only` without one**, and says so in its log.

Provision it inside the running api container:

```bash
docker compose exec api breakglass ensure --json        # standalone
docker exec -i vibe-recap-api docker-entrypoint.sh breakglass ensure --json   # what the appliance runs
```

It prints the password **once**. Store it where the firm keeps emergency credentials.
`breakglass rotate` issues a new one and clears a lockout; `breakglass status` reports whether the
account exists. Sign in at **`/login/local`** (not linked from anywhere) with the username
`vibe-breakglass`.

- **Password only.** Recap has no local second factor for anyone (passkeys and TOTP are v1.1,
  Q25), so neither does this account. Treat the password accordingly. Every use writes
  `vibe.auth.breakglass.used`, which Vibe Sentinel alerts on (`SENT-V-AUTH-001`).
- **It cannot be disabled, demoted, given a temporary password or emailed a reset link** from
  Settings › Users, in any mode (`409`), and its address cannot be used for a new user. Rotate it
  with the command above. The ordinary lockout after repeated wrong passwords still applies, for
  15 minutes; `rotate` clears it.
- **It is not a first admin.** `/setup` and `seed-admin` ignore it, so an appliance that
  provisions break-glass before anyone has signed in can still be set up. In `oidc_only`, `/setup`
  is refused: the first admin arrives through the identity provider.
- After restoring an older database, the stored password and the account no longer match and
  nothing warns you. Run `breakglass rotate` and store the new password.

---

## Registration

### On the Vibe Appliance

`.appliance/manifest.json` carries `"requires": ["identity"]` (soft: Recap runs on local sign-in
without Vibe Auth), the `sso` block, and an `/auth/*` matcher that sends those paths to the api
container past the web tier. The appliance reads its **own vendored copy** of the manifest, so:

1. Release a Recap image that contains single sign-on **first**. Once the vendored manifest says
   `sso.capable`, the console registers the product and shows "registered" even against an image
   that ignores every `VIBE_OIDC_*` line.
2. In `Vibe-Appliance`: copy `requires`, `sso` and the `auth` matcher into
   `console/manifests/vibe-recap.json`; run `npm test` in `console/`. The env template needs no
   change (`ALLOWED_ORIGIN` is already rendered; do **not** add `VIBE_AUTH_MODE` to it, a
   re-render would drop the firm's choice).
3. Check the break-glass command in the image the box will run:
   `docker run --rm --entrypoint breakglass ghcr.io/kisaesdevlab/vibe-recap-api:<tag>` must print
   the usage line (exit 2), not "not found".
4. On the host: `sudo vibe identity register vibe-recap`. A rebuilt image alone does not
   re-register.
5. Sign in at `http://<ip>:5183/` in `both`, then `oidc_only` with break-glass at `/login/local`.

Known appliance behaviour to expect: `register`, `rotate` and `mode` recreate every service in the
overlay, so the migrate one-shot re-runs and the worker restarts. Do not change the mode while a
recap is rendering.

### By hand (standalone)

```bash
curl -X POST http://<vibe-auth-host>/vibe-auth/registrations \
  -H "Authorization: Bearer <VIBE_AUTH_CONSOLE_TOKEN>" -H 'Content-Type: application/json' \
  -d '{
    "slug": "vibe-recap",
    "displayName": "Vibe Recap",
    "baseUrl": "https://<recap-public-origin>",
    "redirectPaths": ["/auth/oidc/callback"],
    "logoutPaths": ["/auth/oidc/backchannel"],
    "publicPaths": [],
    "internalUrl": "http://api:3000"
  }'
```

Put the returned `VIBE_OIDC_*` lines in `.env`, set `VIBE_AUTH_MODE=both`, and
`docker compose up -d api`. The bundled Caddy already routes `/auth/*` to the api. Registration is
idempotent on the slug. After a host, IP or routing change, re-register (or `POST
/vibe-auth/rebase`): the redirect URI is an exact match.

### Networks and back-channel logout

When someone signs out at the identity provider, authentik POSTs a logout token to
`internalUrl + /auth/oidc/backchannel`, container to container, and Recap deletes the single
sign-on sessions of that identity (their local-password sessions, if any, are left alone). For
that to arrive, authentik must be able to reach the api container: on the appliance both are on
`vibe_net`; standalone, the api is on `vibe_net` too, so put Vibe Auth there or give the broker a
`baseUrl` it can reach and drop `internalUrl`. A lost back-channel call is not retried: the
session then lives until it expires (12 h idle, 7 days absolute) or the user signs out.

*Sign out* in Recap ends the Recap session only; the person stays signed in to the identity
provider and the other Vibe apps.

---

## What it writes

- **Migration `0007_vibe_auth`**: `auth_identities` (identity-provider subject ↔ user),
  `auth_settings` (what the Authentication page saves, client secret wrapped),
  `auth_revocations` (unused here), four `oidc_*` columns on `sessions`, and `users.sso_only`.
- **Sessions**: a single sign-on produces the same `sessions` row, the same per-session CSRF token
  and the same `recap_sid` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` per `COOKIE_SECURE`) as
  a password sign-in, with `oidc_issuer` set. The ID token is kept wrapped, only to hand back to
  the identity provider at sign-out. `/auth/*` is outside `/api/`, but a write to `/auth/settings`
  still has to pass the Origin allow-list and the CSRF check.
- **Audit**: Vibe Auth's event names, verbatim, in `audit_events`: `vibe.auth.login.success|failure`,
  `user.provisioned`, `user.linked`, `role.changed`, `logout`, `mode.changed`,
  `breakglass.used|rotated`, `idp.unreachable`, `settings.changed`. Filter Settings › Audit log by
  `vibe.auth`. Recap adds `auth.login_refused` (`oidc_only`) and `auth.password_reset_refused`.
- **Outbound**: the api container gains one destination, the identity provider (discovery, keys,
  token exchange). On the appliance that is a container on `vibe_net`.

## Building from source

`@kisaesdevlab/vibe-auth` is on GitHub Packages, which wants a credential even to read, and the
package is not public. Pulling the published images needs nothing. Building needs a token with
`read:packages` that can see the package:

```bash
# npm install / npm ci / npm test
echo "//npm.pkg.github.com/:_authToken=<PAT>" >> ~/.npmrc      # never the repo's .npmrc
# images
NODE_AUTH_TOKEN=$(gh auth token) docker compose build
```

The token reaches the build as a BuildKit secret, mounted for one `RUN`; it is in no layer and no
image history. CI uses `GITHUB_TOKEN` with `packages: read`, which works once the package's
settings grant this repository access (*Manage Actions access*).

The package lists Express as a required peer, so npm installs it beside Fastify. Nothing loads it;
reported upstream (`Vibe-Auth/docs/integration-plans/vibe-1040-findings.md` item 1).

## Testing

`npx vitest run test/sso.integration.test.ts` from `apps/api`: the real app, the real engine, the
real database and a fake identity provider (`test/fake-idp.ts`) that signs real tokens. Sixteen
cases: modes, first sign-in with a mapped role, email link and role sync, the refusals, the
last-admin floor, the reset refusal, back-channel and both sign-outs, `oidc_only` with
break-glass, the boot refusal, and the Settings › Users guards.

**Not yet exercised**: a real browser against a real authentik. That is the first real test of
`SameSite=Strict` across the redirect back from the identity provider. The reasoning says it
holds, since the callback *sets* the cookie and nothing needs to *send* one until the SPA's
same-origin `/api/auth/me`, but it has not been watched.

## Deviations from `Vibe-Auth/docs/integration-plans/vibe-recap.md`

1. **Migration is drizzle-kit generated** from `schema.ts` (the repo's convention), not the
   package's SQL file pasted in. The tables match `sql/auth_identities.sql`.
2. **`/auth/*` goes in the Caddyfile, not `apps/web/nginx.conf`.** Standalone, Caddy routes
   `/api/*` to the api and nginx only serves files; the plan assumed nginx proxied.
3. **The test is a vitest suite**, not `test/sso-e2e.mjs`, so CI runs it with everything else.
4. **`users.sso_only` closes the reset hole** (plan: "lets a JIT account bootstrap local
   credentials"). Recap has no local factor to key on as 1040 does, so the mark is explicit and
   an admin action clears it.
5. **Break-glass is guarded in every mode** and excluded from the first-run and last-admin counts.
6. **postgres.js needed a parameter shim**: the package's stores hand `Date` values to `$1` SQL,
   which `sql.unsafe()` does not serialize. `textParam` in `src/lib/vibeAuth.ts`.
7. **Vibe-Appliance is not edited by this change**; the checklist is above.
