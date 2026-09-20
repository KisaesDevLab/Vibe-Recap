/**
 * In-process fake OpenID Provider for `sso.integration.test.ts`.
 *
 * A typed port of `Vibe-Auth/packages/client/test/fake-idp.ts` (by way of Vibe-1040's). The
 * published `@kisaesdevlab/vibe-auth` ships only `dist/` and `sql/`, so the fake provider lives
 * in each product; keep its behaviour identical to upstream when re-syncing. It serves
 * discovery, JWKS, authorization (it auto-consents as the configured user), token (PKCE S256 +
 * client_secret_basic), userinfo and end-session, and mints back-channel logout tokens.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";

export interface FakeUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
  roles?: string[];
  /** Defaults to `["pwd"]`. Recap does not require a second factor from the identity provider. */
  amr?: string[];
}

export interface FakeIdpOptions {
  clientId: string;
  clientSecret?: string;
  user: FakeUser;
}

interface PendingCode {
  redirectUri: string;
  nonce: string;
  codeChallenge: string | undefined;
}

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const atHash = (accessToken: string): string =>
  b64url(createHash("sha256").update(accessToken).digest().subarray(0, 16));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

export class FakeIdp {
  user: FakeUser;
  port = 0;
  private readonly opts: FakeIdpOptions;
  private server: Server | null = null;
  private priv: KeyLike | null = null;
  private pub: KeyLike | null = null;
  private readonly kid = "test-key";
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Set<string>();

  constructor(opts: FakeIdpOptions) {
    this.opts = opts;
    this.user = opts.user;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** authentik"s per-provider issuer shape, trailing slash included. */
  get issuer(): string {
    return `${this.base}/application/o/vibe-recap/`;
  }

  async start(): Promise<this> {
    const pair = await generateKeyPair("RS256");
    this.priv = pair.privateKey;
    this.pub = pair.publicKey;
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    // Keep-alive sockets from discovery/JWKS fetches would otherwise hold close() open.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async signIdToken(o: { nonce: string; accessToken: string }): Promise<string> {
    const u = this.user;
    const claims: Record<string, unknown> = {
      email: u.email,
      email_verified: u.email_verified,
      name: u.name,
      groups: u.groups,
      roles: u.roles,
      amr: u.amr ?? ["pwd"],
      sid: `sid-${u.sub}`,
      nonce: o.nonce,
      at_hash: atHash(o.accessToken),
    };
    for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: this.kid })
      .setIssuer(this.issuer)
      .setSubject(u.sub)
      .setAudience(this.opts.clientId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(this.priv!);
  }

  /** A back-channel logout token, as the IdP would POST it when the user signs out there. */
  async logoutToken(o: { sub?: string; sid?: string }): Promise<string> {
    const jwt = new SignJWT({
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      ...(o.sid ? { sid: o.sid } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: this.kid })
      .setIssuer(this.issuer)
      .setAudience(this.opts.clientId)
      .setIssuedAt()
      .setJti(randomUUID());
    if (o.sub) jwt.setSubject(o.sub);
    return jwt.sign(this.priv!);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const path = url.pathname;
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const redirect = (location: string): void => {
      res.writeHead(302, { location });
      res.end();
    };

    if (path.endsWith("/.well-known/openid-configuration")) {
      const iss = this.issuer;
      return send(200, {
        issuer: iss,
        authorization_endpoint: `${iss}authorize/`,
        token_endpoint: `${iss}token/`,
        userinfo_endpoint: `${iss}userinfo/`,
        jwks_uri: `${iss}jwks/`,
        end_session_endpoint: `${iss}end-session/`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["RS256"],
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
      });
    }

    if (path.endsWith("/jwks/")) {
      const jwk = await exportJWK(this.pub!);
      return send(200, { keys: [{ ...jwk, kid: this.kid, use: "sig", alg: "RS256" }] });
    }

    if (path.endsWith("/authorize/")) {
      const q = url.searchParams;
      if (q.get("client_id") !== this.opts.clientId) return send(400, { error: "unauthorized_client" });
      if (q.get("code_challenge_method") !== "S256") return send(400, { error: "invalid_request" });
      const redirectUri = q.get("redirect_uri") ?? "";
      const code = randomUUID();
      this.codes.set(code, {
        redirectUri,
        nonce: q.get("nonce") ?? "",
        codeChallenge: q.get("code_challenge") ?? undefined,
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", q.get("state") ?? "");
      return redirect(target.toString());
    }

    if (path.endsWith("/token/") && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (this.opts.clientSecret) {
        const expected =
          "Basic " +
          Buffer.from(
            `${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`,
          ).toString("base64");
        if (req.headers.authorization !== expected) return send(401, { error: "invalid_client" });
      }
      const code = form.get("code") ?? "";
      const pending = this.codes.get(code);
      this.codes.delete(code);
      if (!pending) return send(400, { error: "invalid_grant" });
      if (pending.redirectUri !== form.get("redirect_uri")) return send(400, { error: "invalid_grant" });
      if (pending.codeChallenge) {
        const expect = b64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest());
        if (expect !== pending.codeChallenge) return send(400, { error: "invalid_grant", error_description: "pkce" });
      }
      const accessToken = `at-${randomUUID()}`;
      this.accessTokens.add(accessToken);
      return send(200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 300,
        id_token: await this.signIdToken({ nonce: pending.nonce, accessToken }),
        scope: "openid profile email",
      });
    }

    if (path.endsWith("/userinfo/")) {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!this.accessTokens.has(token)) return send(401, { error: "invalid_token" });
      const u = this.user;
      return send(200, {
        sub: u.sub,
        email: u.email,
        email_verified: u.email_verified,
        name: u.name,
        groups: u.groups,
        roles: u.roles,
      });
    }

    if (path.endsWith("/end-session/")) {
      return redirect(url.searchParams.get("post_logout_redirect_uri") ?? "/");
    }

    send(404, { error: "not_found", path });
  }
}
