# Installing Vibe Recap

Draft for Phase 1. Final version lands in Phase 9.

## Prerequisites

- Ubuntu Server 24.04 (or any Linux host with Docker Engine 27+ and Docker Compose v2)
- 6 CPU cores, 32 GB RAM, 60 GB free disk (models take ~6 GB; videos and PDFs use the rest)
- Ports 80 and 443 free on the host
- Optional: Tailscale on the host if you want tailnet TLS

## First run

```bash
git clone https://github.com/kisaesdevlab/vibe-recap.git
cd vibe-recap
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, pick TLS_MODE, set DOMAIN if not lan
docker compose up --build -d
docker compose logs -f api worker ollama-init
```

The first start pulls the language model (several GB). The `ollama-init` container exits when the
pull finishes. The API is usable before that; script generation waits for the model.

## TLS modes

| TLS_MODE | When | Extra steps |
|---|---|---|
| `lan` (default) | Inside the office network only | Browser warns once. Trust `data/caddy/pki/authorities/local/root.crt` on each workstation to stop the warning. |
| `tailscale` | Access over the tailnet | Set `DOMAIN` to the machine's tailnet name. Copy `compose.override.example.yml` to `compose.override.yml` and uncomment the tailscale socket mount. Enable HTTPS certificates in the Tailscale admin console. |
| `domain` | Public DNS name | Set `DOMAIN`. Ports 80/443 must be reachable from the internet for ACME. |

## First admin

Open `https://<host>/` in a browser. While no users exist the app shows a one-time setup page that
creates the first administrator. Alternatively from the CLI:

```bash
docker compose run --rm api seed-admin admin@yourfirm.com "Your Name" 'a-long-passphrase'
```

Passwords must be at least 12 characters and not appear in the bundled list of 100,000 commonly
breached passwords.

## Health

```bash
curl -k https://<host>/healthz   # 200 when the API is up
curl -k https://<host>/readyz    # ok | degraded (Ollama down) | failed (Postgres or Redis down)
```

## Using an Ollama that already runs on the host

Keep the worker offline and route it through a small proxy. See `compose.override.example.yml`,
section `ollama-proxy`, then set `OLLAMA_URL=http://ollama-proxy:11434` in `.env`.

## Updating

```bash
docker compose pull && docker compose up -d
```

Database migrations run automatically when the API starts.
