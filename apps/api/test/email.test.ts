import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailError, EmailitClient, formatSender, isEmailAddress } from "../src/services/email.js";
import { escapeHtml, inviteEmail, passwordResetEmail } from "../src/services/email-templates.js";
import { REDACT_PATHS } from "../src/logger.js";

describe("EmailitClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the v2 contract with a bearer key and returns the message id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ object: "email", id: "em_123", status: "pending" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EmailitClient("https://api.emailit.com");
    const r = await client.send({ apiKey: "em_api_key", from: "Firm <recap@firm.com>", replyTo: "office@firm.com", to: "user@firm.com", subject: "S", text: "T", html: "<p>H</p>" });
    expect(r.id).toBe("em_123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.emailit.com/v2/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer em_api_key");
    expect(JSON.parse(String(init.body))).toEqual({ from: "Firm <recap@firm.com>", to: ["user@firm.com"], subject: "S", html: "<p>H</p>", text: "T", reply_to: "office@firm.com" });
  });

  it("turns a 401 into an EmailError that names the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthenticated" }), { status: 401 })));
    const client = new EmailitClient("https://api.emailit.com");
    await expect(client.send({ apiKey: "bad", from: "a@b.co", to: "c@d.co", subject: "s", text: "t", html: "h" })).rejects.toMatchObject({ status: 401, message: /check the API key/ });
  });

  it("reports validation errors verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Validation failed", validation_errors: ["Missing required field: from"] }), { status: 400 })));
    const client = new EmailitClient("https://api.emailit.com");
    await expect(client.send({ apiKey: "k", from: "", to: "c@d.co", subject: "s", text: "t", html: "h" })).rejects.toThrow(/Missing required field: from/);
  });

  it("wraps network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const client = new EmailitClient("https://api.emailit.com");
    await expect(client.send({ apiKey: "k", from: "a@b.co", to: "c@d.co", subject: "s", text: "t", html: "h" })).rejects.toBeInstanceOf(EmailError);
  });
});

describe("email helpers and templates", () => {
  it("validates plain addresses only", () => {
    expect(isEmailAddress("kurt@firm.com")).toBe(true);
    expect(isEmailAddress("Kurt <kurt@firm.com>")).toBe(false);
    expect(isEmailAddress("nope")).toBe(false);
  });

  it("formats the sender with a quoted display name when needed", () => {
    expect(formatSender("", "recap@firm.com")).toBe("recap@firm.com");
    expect(formatSender("Smith CPA", "recap@firm.com")).toBe("Smith CPA <recap@firm.com>");
    expect(formatSender("Smith, Jones & Co", "recap@firm.com")).toBe('"Smith, Jones & Co" <recap@firm.com>');
    expect(formatSender("Evil\r\nBcc: x@y.z", "recap@firm.com")).not.toContain("\n");
  });

  it("escapes firm names and puts the link in both bodies", () => {
    const m = passwordResetEmail({ firmName: "Smith & <Sons>", url: "https://recap.firm.com/reset-password/abc", ttlMinutes: 60 });
    expect(m.html).toContain("Smith &amp; &lt;Sons&gt;");
    expect(m.html).not.toContain("<Sons>");
    expect(m.text).toContain("https://recap.firm.com/reset-password/abc");
    expect(m.html).toContain('href="https://recap.firm.com/reset-password/abc"');
    expect(m.text).toContain("60 minutes");
    const inv = inviteEmail({ firmName: "", url: "https://x.y/invite/t", name: "Pat", role: "preparer", ttlHours: 24 });
    expect(inv.subject).toContain("Vibe Recap");
    expect(inv.text).toContain("preparer");
    expect(escapeHtml(`<a href="x">'`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;");
  });

  it("redacts recipient and body fields at the logger", () => {
    for (const k of ["*.to", "*.from", "*.html", "*.email"]) expect(REDACT_PATHS).toContain(k);
  });
});
