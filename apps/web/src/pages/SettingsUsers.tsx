import { useState, type FormEvent } from "react";
import { ROLES, type Role } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { Alert, Badge, Button, Card, Field, Input, PageTitle, Select, Spinner } from "../ui";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  passkeys: number;
  totp: boolean;
  lockedUntil: string | null;
}

export function SettingsUsersPage() {
  const { user: me } = useAuth();
  const { data, loading, error, reload } = useApi<{ users: UserRow[] }>("/api/users");
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function run(fn: () => Promise<void>, ok?: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await reload();
      if (ok) setMsg({ kind: "success", text: ok });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Action failed" });
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const tempPassword = String(fd.get("tempPassword") || "");
    await run(async () => {
      const r = await post<{ inviteUrl: string | null }>("/api/users", { email: fd.get("email"), name: fd.get("name"), role: fd.get("role"), tempPassword: tempPassword || undefined });
      setInviteUrl(r.inviteUrl ? `${window.location.origin}${r.inviteUrl}` : null);
      form.reset();
    }, "User created.");
  }

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Could not load"}</Alert>;

  return (
    <>
      <PageTitle>Users</PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      {inviteUrl && (
        <div className="mb-4">
          <Alert kind="info">
            Invite link (valid 24 hours, single use): <code className="select-all">{inviteUrl}</code>
          </Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-2">User</th>
                  <th className="py-2 pr-2">Role</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2 pr-2">Last login</th>
                  <th className="py-2 pr-2">Passkeys / TOTP</th>
                  <th className="py-2 pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id} className="border-t border-slate-100 align-top">
                    <td className="py-2 pr-2">
                      <div>{u.name}</div>
                      <div className="text-xs text-slate-500">{u.email}</div>
                    </td>
                    <td className="py-2 pr-2">
                      <Select value={u.role} disabled={busy || u.id === me?.id} onChange={(e) => run(() => patch(`/api/users/${u.id}`, { role: e.target.value }).then(() => undefined))} className="w-32">
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="py-2 pr-2">
                      {u.disabled ? <Badge tone="red">disabled</Badge> : <Badge tone="green">active</Badge>}
                      {u.mustChangePassword && <Badge tone="amber">must change password</Badge>}
                      {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge tone="red">locked</Badge>}
                    </td>
                    <td className="py-2 pr-2 text-slate-500">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : "never"}</td>
                    <td className="py-2 pr-2 text-slate-500">
                      {u.passkeys} / {u.totp ? "on" : "off"}
                    </td>
                    <td className="py-2 pr-2">
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" disabled={busy || u.id === me?.id} onClick={() => run(() => patch(`/api/users/${u.id}`, { disabled: !u.disabled }).then(() => undefined))}>
                          {u.disabled ? "Enable" : "Disable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            const p = window.prompt("Temporary password for this user (at least 12 characters):");
                            if (p) void run(() => post(`/api/users/${u.id}/reset-password`, { tempPassword: p }).then(() => undefined), "Password reset; the user must change it at next login.");
                          }}
                        >
                          Reset password
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => post(`/api/users/${u.id}/force-logout`).then(() => undefined), "Signed out everywhere.")}>
                          Force logout
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-slate-500">Passkeys and TOTP are planned for v1.1; the column shows their status once enabled. The last active admin cannot be demoted or disabled.</p>
          </Card>
        </div>
        <Card title="Add user">
          <form onSubmit={create} className="space-y-3">
            <Field label="Name">
              <Input name="name" required />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" required />
            </Field>
            <Field label="Role">
              <Select name="role" defaultValue="staff">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Temporary password" hint="Leave blank to get a 24-hour invite link instead.">
              <Input name="tempPassword" type="text" autoComplete="off" />
            </Field>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
