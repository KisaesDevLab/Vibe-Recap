import { NavLink, Outlet, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { Button, cx } from "../ui";

const links: Array<{ to: string; label: string; min: "viewer" | "staff" | "preparer" | "admin" }> = [
  { to: "/", label: "Dashboard", min: "viewer" },
  { to: "/upload", label: "Upload", min: "staff" },
  { to: "/clients", label: "Clients", min: "staff" },
  { to: "/settings", label: "Settings", min: "admin" },
];

export function Layout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-8">
            <NavLink to="/" className="text-base font-bold text-brand">
              Vibe Recap
            </NavLink>
            <nav className="flex gap-1">
              {links
                .filter((l) => can(l.min))
                .map((l) => (
                  <NavLink
                    key={l.to}
                    to={l.to}
                    end={l.to === "/"}
                    className={({ isActive }) =>
                      cx("rounded-md px-3 py-1.5 text-sm font-medium", isActive ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:text-slate-900")
                    }
                  >
                    {l.label}
                  </NavLink>
                ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <NavLink to="/account" className={({ isActive }) => cx("rounded-md px-2 py-1 text-slate-600 hover:text-slate-900", isActive && "bg-slate-100 text-slate-900")} title="Your account">
              {user?.name} <span className="text-slate-400">({user?.role})</span>
            </NavLink>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout();
                navigate("/login");
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
