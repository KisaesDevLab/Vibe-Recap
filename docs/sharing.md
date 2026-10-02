# Client sharing

A preparer can send an approved video to the client as a link instead of downloading it and
sending the file through another channel. Off by default. Decided by Kurt on 2026-10-02
(QUESTIONS.md Q73); it amends the download-only rule (PLAN.md L11).

## What the client sees

1. A message from the firm, by email or text, with a link. It carries the firm's name and the
   expiry date. Never the client's name, never a figure from the return.
2. The link opens a page on the firm's watch address (for example `https://watch.yourfirm.com`)
   with one button: **Send my code**. The code goes to the email address or phone number the
   preparer entered, never to one the client types, so a forwarded link is useless on its own.
3. The client enters the 6-digit code and, if the preparer asked for it, the last four digits of
   their SSN. The page then plays the video, captions on, with no download button.

## Rules

| What | Rule |
|---|---|
| Link | 256-bit random token; only its SHA-256 is stored. Valid 7 days. |
| Code | 6 digits, single use, 10 minutes, stored hashed in Redis. One send per minute, 10 per link. |
| Last 4 | Optional per share (on by default). Argon2id hash on the share, erased when the link expires. Recap still never reads an SSN from a return. |
| Contact | Wrapped with the master key, shown masked (`j•••@gmail.com`, `••• ••• 1234`), erased when the link expires or the job is purged. |
| Sessions | A passed check opens a 2-hour viewing session (seeking and replays are free). At most 5 per link. |
| Wrong answers | Wrong code and wrong last 4 count together: a 15-minute cooldown after every 3, a permanent lock at 10. The preparer re-issues. |
| Playback | Inline, range requests, `no-store`, no download control. This deters saving; it cannot prevent a screen recording. |
| Release | Sharing an approved job releases it, as a download does. Shares do not change retention: when the purge takes the video, the link says it is gone. |
| Timeline | The job page lists every event (sent, code sent, verified, wrong answer, cooldown, locked, watched, revoked, expired) with the client's IP and browser. IP and browser are kept until the job is purged; the audit log records the events without them. |
| Who | Preparer and admin share, revoke and re-issue; staff see the timeline. |

**Re-issue** sends a fresh 7-day link to the same contact with the same last-4 check and revokes
the old link. It works until the old link's 7 days are up; after that the contact is erased and
the preparer creates a new share.

## Network

The staff UI stays on the LAN or Tailscale. Only the watch page reaches the internet, through an
outbound-only Cloudflare tunnel; no router port is opened.

```
client ── https ──> Cloudflare ──tunnel──> cloudflared ──> caddy:8088 ──> api:3000 /watch/*
                                                            └── anything else: 404
```

Caddy's watch site (`http://:8088`, no host port) serves `/watch/*` and nothing else, and takes
the client's address from Cloudflare's `Cf-Connecting-Ip`. The watch page is rendered by the API,
not by the staff React app, under a strict content security policy.

New outbound destinations: the API container may reach `api.twilio.com` when text messages are on,
and the `cloudflared` container dials Cloudflare. The worker's egress is unchanged.

## Setup

1. **Cloudflare tunnel.** In Cloudflare Zero Trust › Networks › Tunnels, create a tunnel
   (type *cloudflared*) and copy its token. Add a public hostname, for example
   `watch.yourfirm.com`, with service **HTTP** and URL **`caddy:8088`**. Use a hostname that is
   not the staff address. Do not point it at `caddy:443` or `web`: that would put the staff UI on
   the internet.
2. **.env.**
   ```
   COMPOSE_PROFILES=share
   CLOUDFLARE_TUNNEL_TOKEN=eyJ...
   SHARE_PUBLIC_URL=https://watch.yourfirm.com
   ```
   then `docker compose up -d` (and `docker compose restart caddy` after an update that changed
   the Caddyfile).
3. **Email** (Settings › Email) must be on for email shares. The same Emailit sender is used.
4. **Text messages (optional).** Settings › Sharing › Twilio: account SID, auth token, and a
   sending number or Messaging Service SID. US numbers need A2P 10DLC registration before
   carriers deliver. Send a test text to your own phone. The token can also come from
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` in `.env`; it is never exported.
5. **Turn it on.** Settings › Sharing › *Let preparers share videos with clients*. The badge says
   why it is off until the watch address and at least one channel are ready.
6. **Check.** Open `https://watch.yourfirm.com/` (404, as it should) and
   `https://watch.yourfirm.com/api/auth/me` (404). Share a test job to yourself.

On the Vibe Appliance the staff host already routes `/watch/*`; a public watch host there is not
set up yet.

## Troubleshooting

| Symptom | Check |
|---|---|
| "Client sharing is not available" on the job page | Settings › Sharing shows the reason. |
| Link opens a Cloudflare error page | The tunnel's public hostname must point at `http://caddy:8088`, and the `cloudflared` container must be running (`COMPOSE_PROFILES=share`). |
| The link opens but every IP in the timeline is the same | The hostname is not going through Cloudflare (no `Cf-Connecting-Ip`). |
| Texts do not arrive | Settings › Sharing › *Send test text* shows Twilio's answer. Unregistered US numbers are filtered by carriers. |
| "This link is locked" | Ten wrong answers. Re-issue from the job page. |
