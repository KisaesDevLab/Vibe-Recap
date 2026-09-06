import { NavLink, Outlet } from "react-router";
import { cx } from "../ui";

const TABS = [
  { to: "/settings/general", label: "General" },
  { to: "/settings/retention", label: "Retention" },
  { to: "/settings/users", label: "Users" },
  { to: "/settings/email", label: "Email" },
  { to: "/settings/audit", label: "Audit log" },
  { to: "/settings/quality", label: "Quality" },
  { to: "/settings/backup", label: "Backup" },
];

export function SettingsLayout() {
  return (
    <div className="grid gap-6 md:grid-cols-[200px_1fr]">
      <nav className="flex flex-row gap-1 md:flex-col">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => cx("rounded-md px-3 py-1.5 text-sm font-medium", isActive ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:text-slate-900")}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div>
        <Outlet />
      </div>
    </div>
  );
}
