"""Real-browser single sign-on check: Recap against a real authentik through Vibe Auth.

Drives headless Chromium (the worker venv's Playwright) through the whole sign-in: the
"Sign in with ..." button on /login, authentik's identification, password, TOTP enrolment
and validation stages, the redirect back to /auth/oidc/callback, the SPA's /api/auth/me,
sign-out, and a second sign-in that must link the account created by the first. The final
hop back to Recap is a top-level navigation started from the authentik origin, exactly as
authentik's own UI does it, which is what the SameSite=Strict session cookie has to survive.

authentik's stages are answered through its flow executor API from inside the authentik
page (same cookies as the UI); the browser does every navigation.

Prerequisites
  * Recap running with VIBE_AUTH_MODE=both and a VIBE_OIDC_* block from a broker
    registration (docs/sso.md, "By hand"); /setup already done.
  * An authentik user with a password and NO enrolled device (the check enrols TOTP); its
    Vibe group decides the Recap role (default map: vibe-manager -> preparer).
  * No Recap account yet for that user's email (the check expects a first sign-in).

Environment
  RECAP_URL        default https://localhost
  AUTHENTIK_URL    authentik's public base including its path, default http://localhost:18080/auth
  SSO_USER         authentik username,   default recap-tester
  SSO_PASSWORD     that user's password
  SSO_EMAIL        the email authentik sends, default recap-tester@example.test
  SSO_ROLE         Recap role expected after the first sign-in, default preparer

Usage
  worker/.venv/Scripts/python scripts/sso-browser-check.py [screenshot-dir]

Exit code 0 when every check passes. Nothing here touches a return; the account it creates
is a staff account for a synthetic person and can be deleted under Settings > Users.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import struct
import sys
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

RECAP = os.environ.get("RECAP_URL", "https://localhost").rstrip("/")
AK = os.environ.get("AUTHENTIK_URL", "http://localhost:18080/auth").rstrip("/")
AK_PATH = urlparse(AK).path  # "/auth" on the appliance and in the test stack
USER = {
    "username": os.environ.get("SSO_USER", "recap-tester"),
    "password": os.environ.get("SSO_PASSWORD", ""),
    "totp": None,
}
EMAIL = os.environ.get("SSO_EMAIL", "recap-tester@example.test")
ROLE = os.environ.get("SSO_ROLE", "preparer")
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
results = []
LAST_COUNTER = [0]


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  -- ' + str(detail)[:300]) if detail else ''}", flush=True)


def totp(secret_b32, t=None):
    key = base64.b32decode(secret_b32.upper() + "=" * (-len(secret_b32) % 8))
    counter = int((t or time.time()) // 30)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return str((struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000).zfill(6)


def fresh_code(secret_b32):
    """authentik refuses a TOTP code reused inside its window: wait for a new counter."""
    while int(time.time() // 30) <= LAST_COUNTER[0]:
        time.sleep(1)
    LAST_COUNTER[0] = int(time.time() // 30)
    return totp(secret_b32)


def executor(page, slug, query, body=None):
    """GET or POST authentik's flow executor from the authentik page."""
    return page.evaluate(
        """async ([path, slug, query, body]) => {
          const url = `${path}/api/v3/flows/executor/${slug}/?query=${encodeURIComponent(query)}`;
          const r = await fetch(url, { method: body ? 'POST' : 'GET',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: body ? JSON.stringify(body) : undefined, redirect: 'follow' });
          const text = await r.text();
          try { return { status: r.status, body: JSON.parse(text) }; }
          catch { return { status: r.status, body: { component: '__unparseable__', text: text.slice(0, 300) } }; }
        }""",
        [AK_PATH, slug, query, body],
    )


def run_through_authentik(page, who):
    """Answer the stages until authentik sends the browser back; return the landing URL."""
    m = re.search(r"/if/flow/([^/]+)/", urlparse(page.url).path)
    if not m:
        return page.url
    slug = m.group(1)
    query = urlparse(page.url).query
    ch = executor(page, slug, query)
    for _step in range(15):
        comp = ch["body"].get("component")
        errors = ch["body"].get("response_errors")
        print(f"   stage {comp}{('  ' + json.dumps(errors)[:200]) if errors else ''}", flush=True)
        if comp == "ak-stage-identification":
            ch = executor(page, slug, query, {"component": comp, "uid_field": who["username"], "password": who["password"]})
        elif comp == "ak-stage-password":
            ch = executor(page, slug, query, {"component": comp, "password": who["password"]})
        elif comp == "ak-stage-authenticator-validate":
            devs = ch["body"].get("device_challenges") or []
            tot = next((d for d in devs if d.get("device_class") == "totp"), None)
            if tot and who["totp"]:
                ch = executor(page, slug, query, {"component": comp, "code": fresh_code(who["totp"]), "selected_challenge": tot})
            elif ch["body"].get("configuration_stages"):
                stages = ch["body"]["configuration_stages"]
                cfg = next((s for s in stages if re.search("totp", s["name"], re.I)), stages[0])
                check("MFA enforced: enrolment offered to a user without a device", True, cfg["name"])
                ch = executor(page, slug, query, {"component": comp, "selected_stage": cfg["pk"]})
            else:
                check("validate stage offers a TOTP device this check knows", False, json.dumps(devs)[:300])
                return page.url
        elif comp == "ak-stage-authenticator-totp":
            secret = re.search(r"[?&]secret=([A-Z2-7]+)", ch["body"].get("config_url", ""), re.I)
            check("TOTP enrolment challenge carries a secret", bool(secret))
            if not secret:
                return page.url
            who["totp"] = secret.group(1)
            ch = executor(page, slug, query, {"component": comp, "code": fresh_code(who["totp"])})
        elif comp == "ak-stage-consent":
            ch = executor(page, slug, query, {"component": comp, "token": ch["body"].get("token")})
        elif comp == "xak-flow-redirect":
            to = ch["body"]["to"]
            with page.expect_navigation(wait_until="load", timeout=30000):
                page.evaluate("to => window.location.assign(to)", to)
            page.wait_for_url(lambda u: "/if/flow/" not in u and "/auth/oidc/" not in u, timeout=30000)
            page.wait_for_load_state("networkidle", timeout=30000)
            return page.url
        elif comp == "ak-stage-access-denied":
            check("authentik admitted the user", False, json.dumps(ch["body"])[:300])
            return page.url
        else:
            check(f"stage {comp} is one this check handles", False, json.dumps(ch["body"])[:300])
            return page.url
    check("authentik flow finished within 15 steps", False)
    return page.url


def me(page):
    return page.evaluate(
        "async () => { const r = await fetch('/api/auth/me'); return { status: r.status, body: await r.json().catch(() => null) }; }"
    )


def user_of(m):
    body = m.get("body") or {}
    return body.get("user", body) if isinstance(body, dict) else {}


def main():
    if not USER["password"]:
        print("SSO_PASSWORD is required", file=sys.stderr)
        return 2
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()

        # 1. the sign-in page in mode `both`
        page.goto(f"{RECAP}/login", wait_until="networkidle")
        btn = page.get_by_role("link", name=re.compile("Sign in with", re.I))
        check("login page shows the 'Sign in with ...' button", btn.count() == 1, btn.first.inner_text() if btn.count() else "no button")
        check("login page still shows the password form (mode both)", page.locator("input[type=password]").count() == 1)
        page.screenshot(path=f"{OUT}/sso-01-login.png")

        # 2. the button is a real navigation to /auth/oidc/start and on to authentik
        with page.expect_navigation(wait_until="networkidle", timeout=30000):
            btn.first.click()
        check("start redirected the browser to authentik's flow", "/if/flow/" in page.url, page.url)
        check("no recap_sid before the callback", not any(c["name"] == "recap_sid" for c in ctx.cookies(RECAP)))
        page.screenshot(path=f"{OUT}/sso-02-authentik.png")

        # 3. first sign-in: enrols TOTP, creates the account
        final = run_through_authentik(page, USER)
        check("browser landed back on Recap", final.startswith(RECAP + "/") and "/auth/" not in urlparse(final).path, final)
        sid = next((c for c in ctx.cookies(RECAP) if c["name"] == "recap_sid"), None)
        check("recap_sid cookie set by the callback", sid is not None)
        check("recap_sid is SameSite=Strict, HttpOnly, Secure", sid and sid.get("sameSite") == "Strict" and sid.get("httpOnly") and sid.get("secure"),
              {k: sid.get(k) for k in ("sameSite", "httpOnly", "secure")} if sid else None)
        m = me(page)
        u = user_of(m)
        check("/api/auth/me returns the account created on first sign-in", m["status"] == 200 and u.get("email") == EMAIL, json.dumps(m)[:200])
        check(f"Vibe group mapped to role {ROLE}", u.get("role") == ROLE, u.get("role"))
        page.wait_for_timeout(1000)
        check("SPA rendered a signed-in page, not the login form", page.locator("input[type=password]").count() == 0 and "/login" not in page.url, page.url)
        page.screenshot(path=f"{OUT}/sso-03-signed-in.png")

        # 4. sign out of Recap only
        page.goto(f"{RECAP}/auth/oidc/logout?local=1", wait_until="networkidle")
        m2 = me(page)
        check("after /auth/oidc/logout?local=1 the Recap session is gone", m2["status"] == 401, json.dumps(m2)[:200])

        # 5. second sign-in: the identity provider session may still stand; either way the
        #    existing account must be linked, not duplicated
        page.goto(f"{RECAP}/login", wait_until="networkidle")
        with page.expect_navigation(wait_until="networkidle", timeout=30000):
            page.get_by_role("link", name=re.compile("Sign in with", re.I)).first.click()
        run_through_authentik(page, USER)
        m3 = me(page)
        u3 = user_of(m3)
        check("second sign-in links the existing account", m3["status"] == 200 and u3.get("email") == EMAIL and u3.get("id") == u.get("id"), json.dumps(m3)[:200])
        browser.close()

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
