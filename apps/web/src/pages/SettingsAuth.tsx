import { AuthSettingsPage } from "@kisaesdevlab/vibe-auth/react";
import { getCsrfToken } from "../lib/api";
import { PageTitle } from "../ui";

const fieldBase =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";
const buttonBase = "inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand/30";

// The page itself comes from @kisaesdevlab/vibe-auth; these make it look like the other tabs.
const CLASSES = {
  root: "space-y-6",
  section: "space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-xs",
  label: "block space-y-1 text-sm font-medium text-slate-700",
  input: fieldBase,
  button: `${buttonBase} border border-slate-300 bg-white text-ink hover:bg-slate-50`,
  buttonPrimary: `${buttonBase} bg-brand text-white hover:bg-brand-strong`,
  buttonDanger: `${buttonBase} bg-red-700 text-white hover:bg-red-800`,
  table: "w-full text-sm",
  note: "text-sm text-slate-500",
  error: "text-sm text-red-700",
};

// Module-level on purpose: the package rebuilds its client, and reloads, whenever this prop's
// identity changes, so an inline arrow would refetch on every render.
function csrfHeaders(): Record<string, string> {
  const token = getCsrfToken();
  return token ? { "x-csrf-token": token } : {};
}

/**
 * Settings > Authentication (Q57): sign-in mode, identity provider, role map, connection test and
 * break-glass status. It talks to /auth/settings, which sits outside /api but is still behind the
 * session and the CSRF check, so every write carries the token like the rest of the app.
 */
export function SettingsAuthPage() {
  return (
    <>
      <PageTitle>Authentication</PageTitle>
      <p className="mb-4 text-sm text-slate-600">
        Let staff sign in through your firm&apos;s identity provider (Vibe Auth). Local passwords keep working unless you choose single sign-on only, and that needs a
        break-glass account first.
      </p>
      <AuthSettingsPage
        basePath=""
        productName="Vibe Recap"
        classNames={CLASSES}
        headers={csrfHeaders}
      />
    </>
  );
}
