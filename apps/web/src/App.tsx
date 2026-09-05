import { Navigate, Route, Routes, useLocation } from "react-router";
import type { ReactNode } from "react";
import type { Role } from "@vibe-recap/shared";
import { useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { SetupPage } from "./pages/Setup";
import { DashboardPage } from "./pages/Dashboard";
import { UploadPage } from "./pages/Upload";
import { BatchPage } from "./pages/Batch";
import { ClientDetailPage, ClientsPage } from "./pages/Clients";
import { JobPage } from "./pages/Job";
import { Alert, Spinner } from "./ui";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, setupNeeded } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (setupNeeded) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireRole({ min, children }: { min: Role; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(min)) return <Alert kind="error">Your role does not have access to this page.</Alert>;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route
          path="/upload"
          element={
            <RequireRole min="staff">
              <UploadPage />
            </RequireRole>
          }
        />
        <Route path="/batches/:id" element={<BatchPage />} />
        <Route path="/jobs/:id" element={<JobPage />} />
        <Route
          path="/clients"
          element={
            <RequireRole min="staff">
              <ClientsPage />
            </RequireRole>
          }
        />
        <Route
          path="/clients/:id"
          element={
            <RequireRole min="staff">
              <ClientDetailPage />
            </RequireRole>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
