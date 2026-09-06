/**
 * The four messages Recap sends, as plain text plus a small HTML twin. Every value is escaped;
 * nothing from a tax return is ever part of a message. Firm name and URLs only.
 */
import type { EmailContent } from "./email.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function wrap(firm: string, title: string, paragraphs: string[], action?: { label: string; url: string }, footer?: string): EmailContent {
  const brand = firm || "Vibe Recap";
  const text = [title, "", ...paragraphs.flatMap((p) => [p, ""]), ...(action ? [`${action.label}: ${action.url}`, ""] : []), footer ?? `Sent by ${brand} (Vibe Recap).`].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e293b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px">
<tr><td style="padding:20px 24px 0;font-size:13px;font-weight:600;color:#1f3a5f">${escapeHtml(brand)}</td></tr>
<tr><td style="padding:12px 24px 0;font-size:18px;font-weight:600">${escapeHtml(title)}</td></tr>
${paragraphs.map((p) => `<tr><td style="padding:12px 24px 0;font-size:14px;line-height:1.5">${escapeHtml(p)}</td></tr>`).join("\n")}
${
  action
    ? `<tr><td style="padding:20px 24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#1f3a5f;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:6px">${escapeHtml(action.label)}</a></td></tr>
<tr><td style="padding:12px 24px 0;font-size:12px;color:#64748b;word-break:break-all">If the button does not work, open this link: ${escapeHtml(action.url)}</td></tr>`
    : ""
}
<tr><td style="padding:20px 24px 24px;font-size:12px;color:#64748b">${escapeHtml(footer ?? `Sent by ${brand} (Vibe Recap).`)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: title, text, html };
}

export function passwordResetEmail(o: { firmName: string; url: string; ttlMinutes: number }): EmailContent {
  return wrap(
    o.firmName,
    "Reset your Vibe Recap password",
    [
      "Someone asked to reset the password for your Vibe Recap account. If that was you, use the link below to choose a new password.",
      `The link works once and expires in ${o.ttlMinutes} minutes. Every existing sign-in for the account ends when the password changes.`,
      "If you did not ask for this, you can ignore this message; your password stays as it is.",
    ],
    { label: "Choose a new password", url: o.url },
  );
}

export function inviteEmail(o: { firmName: string; url: string; name: string; role: string; ttlHours: number }): EmailContent {
  const brand = o.firmName || "Vibe Recap";
  return wrap(
    o.firmName,
    `You have been added to ${brand} on Vibe Recap`,
    [`${o.name}, an administrator created a Vibe Recap account for you with the ${o.role} role.`, `Use the link below to set your password. It works once and expires in ${o.ttlHours} hours.`],
    { label: "Set your password", url: o.url },
  );
}

export function passwordChangedEmail(o: { firmName: string; url: string }): EmailContent {
  return wrap(
    o.firmName,
    "Your Vibe Recap password was changed",
    ["The password for your Vibe Recap account was just changed and every other sign-in was ended.", "If you made this change, nothing else is needed. If you did not, tell your administrator right away so they can secure the account."],
    o.url ? { label: "Open Vibe Recap", url: o.url } : undefined,
  );
}

export function testEmail(o: { firmName: string; url: string; sentBy: string }): EmailContent {
  return wrap(o.firmName, "Vibe Recap test message", [`Outgoing email is working. This test was sent from Settings > Email by ${o.sentBy}.`], o.url ? { label: "Open Vibe Recap", url: o.url } : undefined);
}
