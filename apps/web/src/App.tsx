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
import { SettingsLayout } from "./pages/Settings";
import { SettingsRetentionPage } from "./pages/SettingsRetention";
import { SettingsGeneralPage } from "./pages/SettingsGeneral";
import { SettingsUsersPage } from "./pages/SettingsUsers";
import { SettingsAuditPage } from "./pages/SettingsAudit";
import { SettingsQualityPage } from "./pages/SettingsQuality";
import { SettingsBackupPage } from "./pages/SettingsBackup";
import { InvitePage } from "./pages/Invite";
import { ForgotPasswordPage } from "./pages/ForgotPassword";
import { ResetPasswordPage } from "./pages/ResetPassword";
import { AccountPage } from "./pages/Account";
import { SettingsEmailPage } from "./pages/SettingsEmail";
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
  // A password set by an administrator must be replaced before anything else is used.
  if (user.mustChangePassword && location.pathname !== "/account") return <Navigate to="/account?required=1" replace />;
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
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="/account" element={<AccountPage />} />
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
        <Route
          path="/settings"
          element={
            <RequireRole min="admin">
              <SettingsLayout />
            </RequireRole>
          }
        >
          <Route index element={<Navigate to="/settings/general" replace />} />
          <Route path="general" element={<SettingsGeneralPage />} />
          <Route path="retention" element={<SettingsRetentionPage />} />
          <Route path="users" element={<SettingsUsersPage />} />
          <Route path="email" element={<SettingsEmailPage />} />
          <Route path="audit" element={<SettingsAuditPage />} />
          <Route path="quality" element={<SettingsQualityPage />} />
          <Route path="backup" element={<SettingsBackupPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
