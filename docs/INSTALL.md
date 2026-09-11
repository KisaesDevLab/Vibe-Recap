# Installing Vibe Recap

From a fresh Ubuntu Server 24.04 host to a released recap video in under 20 minutes, not counting
the one-time model download.

## 1. Prerequisites

| Item | Requirement |
|---|---|
| Host | Ubuntu Server 24.04 (any Linux with Docker works). Reference box: GMKtec NucBox M6, Ryzen 5 6600H, 32 GB. |
| Docker | Docker Engine 27+ with the Compose plugin (`docker compose version` prints v2.x). |
| Disk | 60 GB free. Images are about 5 GB, the language model 5 GB, the rest is your returns and videos. |
| Ports | 80 and 443 free on the host. |
| Network | Outbound HTTPS from the host for the first pull only (images, language model). The worker never has internet access. |
| Optional | Tailscale on the host if the firm reaches the box over its tailnet. |

Install Docker on Ubuntu:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker
```

## 2. Get the stack

```bash
git clone https://github.com/kisaesdevlab/vibe-recap.git
cd vibe-recap
cp .env.example .env
```

Edit `.env`:

| Variable | Set it to |
|---|---|
| `POSTGRES_PASSWORD` | A long random string. Required. |
| `TLS_MODE` | `lan` (default), `tailscale`, or `domain`. See section 4. |
| `DOMAIN` | The hostname clients will use, for `tailscale` and `domain` modes. |
| `RECAP_DATA` | Where encrypted files live on the host. Default `./data`. Put it on the disk you back up. |
| `MASTER_KEY_PASSPHRASE` | Optional. If set, the master key on disk is wrapped with it and the passphrase must be present at every start. |

Everything else has a working default.

## 3. First start

```bash
docker compose up -d
docker compose logs -f ollama-init   # exits when the language model is downloaded (about 5 GB)
```

Pre-built images are pulled from GHCR. To build from source instead: `docker compose up -d --build`.

What starts:

| Service | Role |
|---|---|
| `caddy` | TLS and reverse proxy on 80/443 |
| `web` | the React UI |
| `api` | Fastify API, auth, settings, retention, audit, email |
| `worker` | extraction, script, verification, narration, video. No internet route. |
| `ollama` | the language model (and OCR model) |
| `ollama-init` | one-shot model download, exits when done |
| `postgres`, `redis` | database and queue |

Check health:

```bash
curl -k https://<host>/healthz   # {"ok":true,...}
curl -k https://<host>/readyz    # "ok" once Ollama answers; "degraded" while the model downloads
```

## 4. TLS modes

**lan** (default). Caddy's internal CA issues a certificate on the fly for whatever name or IP the
browser used. Browsers warn once. To stop the warning on office PCs, import
`data/caddy/pki/authorities/local/root.crt` as a trusted root.

**tailscale**. Set `TLS_MODE=tailscale` and `DOMAIN=<machine>.<tailnet>.ts.net`. Enable *HTTPS
certificates* in the Tailscale admin console. Copy `compose.override.example.yml` to
`compose.override.yml` and uncomment the `caddy` block that mounts the tailscaled socket. Restart
with `docker compose up -d`.

**domain**. Set `TLS_MODE=domain` and `DOMAIN=recap.yourfirm.com`. Point the DNS name at the host and
make sure ports 80 and 443 are reachable from the internet for the certificate challenge.

## 5. First admin

Open `https://<host>/`. While no users exist the app shows a one-time setup page that creates the
first administrator and disables itself. From the command line instead:

```bash
docker compose run --rm api seed-admin admin@yourfirm.com "Your Name" 'a-long-passphrase'
```

Passwords need 12 characters or more and cannot be one of the 100,000 most common passwords.

## 6. Settings to review before the first return

Settings > General: firm name, logo, colors, sign-off sentence, default narration voice. Each user can
choose their own narration voice under Your account; it overrides the default for the recaps they upload.
Settings > Retention: how long source PDFs, scripts, and videos stay. Defaults 30 / 365 / 90 days.
Settings > Users: add preparers and staff; invite links are valid for 24 hours.
Settings > Email: optional outgoing email so invites and password resets arrive by email (section 6c).

## 6a. Vibe AI Router (default script provider)

Scripts are generated through the Vibe AI Router, which serves the firm's configured models
(DigitalOcean serverless open-source models by default in the Vibe suite) under its
data-boundary policy. Only the extracted figures, first names, filing status, states, and the
preparer's note are sent; the return PDF never leaves the box.

1. In the router console, mint an app token for `vibe-recap` (App tokens) and put it in `.env`
   as `VIBE_AI_TOKEN`.
2. The router lives on the Docker network `vibe_net`. On the Vibe Appliance it already exists;
   on a standalone host run `docker network create vibe_net` once and start the router stack on it.
3. Start Recap. The API registers the task class `recap_script`, which begins `local_only` with
   no model bound. In the router console (Policies) bind a model to it and, if you want cloud
   models, widen its sensitivity. Until a model is bound, script jobs fail with a clear
   "policy_blocked" message naming this step.
4. Settings > General > *Test connections* shows the router state and the class's sensitivity.

Without a token, or with *Bundled Ollama* selected, scripts are generated locally by `qwen3:8b`.

## 6c. Outgoing email (optional)

Without email, an administrator hands new users an invite link and resets a forgotten password
by setting a temporary one under Settings > Users. With email on, invites and one-hour reset
links are sent to the user, the sign-in page gains *Forgot your password?*, and every password
change sends the account a notice. Recap emails firm users only, never clients, and never
attaches anything from a return.

1. Create an account at [emailit.com](https://emailit.com), verify your sending domain, and
   create an API key limited to that domain (Settings > API keys).
2. In Recap, Settings > Email: provider *Emailit*, paste the key, set the sender address on the
   verified domain (for example `recap@yourfirm.com`), optionally a sender name and reply-to.
   The key can also come from `EMAILIT_API_KEY` in `.env`.
3. Set *Public URL* to the address your users open Recap at if it differs from the address the
   server sees (behind a reverse proxy or a Tailscale name). Blank works for most installs.
4. Save, then *Send test message*. The key is stored on this box, shown masked, and is not part of
   the settings export.

Every user can change their own password at any time from their name in the top-right corner.

## 6b. Installing on the Vibe Appliance

Recap ships the appliance manifest, compose overlay, and env template under `.appliance/`.
Once they are in the appliance repo (`console/manifests/vibe-recap.json`, `apps/vibe-recap.yml`,
`env-templates/per-app/vibe-recap.env.tmpl`) and the images are on GHCR, enable it from the
console's Apps panel or `vibe enable vibe-recap`. The appliance provides Postgres, Redis, TLS,
the AI Router token, and the first admin's password (First-login card). Recap's own `compose.yml`
is for standalone hosts only.

## 7. Using an Ollama already running on the host

Keep the worker offline and route it through a tiny proxy that only reaches the host's Ollama:

1. In `compose.override.yml` uncomment the `ollama-proxy` block and the two `replicas: 0` blocks.
2. In `.env` set `OLLAMA_URL=http://ollama-proxy:11434`.
3. `docker compose up -d`.

The host's Ollama must listen on all interfaces (`OLLAMA_HOST=0.0.0.0`) and have `qwen3:8b` and
`glm-ocr` pulled.

## 8. Updating

```bash
git pull
docker compose pull
docker compose up -d
```

Database migrations run automatically when the API starts. Form profiles under
`data/form-profiles` are reconciled with the image at every worker start: a profile you have not
edited is replaced by the newer version the image ships; one you have edited is kept, and the
worker log names it so you can merge the change by hand (`.seeded/` holds what the image last
installed).

## 9. Backups

Back up two things together: the `RECAP_DATA` directory (encrypted blobs and `keys/master.key`)
and the Postgres database. See Settings > Backup for the Duplicati sidecar and the `pg_dump` line.
Keep a separate offline copy of `data/keys/master.key`. Without it the blobs cannot be read.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Browser shows a certificate error in `lan` mode | Expected once. Import the root certificate (section 4) or click through. |
| `readyz` says `degraded` | Ollama is still downloading the model, or `OLLAMA_URL` points somewhere unreachable. `docker compose logs ollama-init`. |
| Job fails at `script` with "model ... is not available" | The model is not pulled yet, or the model name in Settings > General does not match. Use *Test Ollama*. |
| Sign-in with the seeded admin says "Invalid email or password" (appliance) | The seed never ran. Run `sudo docker exec vibe-recap-api seed-admin` (older images: `sudo docker exec vibe-recap-api docker-entrypoint.sh seed-admin`); it is a no-op once any user exists. |
| Sign-in succeeds and the next page bounces back to the login form | The session cookie is marked Secure but the page is plain HTTP (LAN mode, emergency port). Set `COOKIE_SECURE=false` in the api env and restart it; on the appliance the template renders this per mode. |
| Job fails at `extract` with "required lines missing" | The package is not a 1040, or the software layout needs a profile tweak. Copy `data/form-profiles/1040-2025-<software>.yaml`, adjust, re-extract. |
| Job fails at `recon` | The extracted lines do not foot. Open the job, read the check that failed. A preparer can downgrade one check with a reason; the job then proceeds and the exception stays visible. |
| Job fails at `verify` | The script states something the return does not support. Edit the script or regenerate. |
| Job fails at `ocr` with "scanned pages exceeded time limit" | Scanned packages over about 12 pages need more than the 90 s per-page cap on this CPU. Ask for a text-layer PDF. |
| Worker logs `PermissionError` on `/data/keys` | `RECAP_DATA` is owned by another user. Both containers run as uid 1000; `sudo chown -R 1000:1000 data`. |
| "worker restarted mid-job" on a job | The worker was restarted while processing. Click *Retry*; it resumes at that step. |
| Upload says "PDF is password-protected" | Remove the password in the tax software's print dialog and upload again. |
| *Forgot your password?* is missing from the sign-in page | Outgoing email is off. An admin turns it on under Settings > Email (section 6c) or resets the password with a temporary one under Settings > Users. |
| Reset or invite emails do not arrive | Settings > Email > *Send test message* shows Emailit's answer. Common causes: the sender address is not on a verified Emailit domain, the key is limited to another domain, or the message is in spam. Failed sends are in the audit log as `auth.password_reset_email_failed`. |
| Links in emails point at the wrong host | Set *Public URL* under Settings > Email (or `PUBLIC_URL` in `.env`). |
| Changing *Concurrency* had no effect | `docker compose restart worker`. |

Logs: `docker compose logs -f api worker`. Logs contain job ids and hashes, never names or amounts.
