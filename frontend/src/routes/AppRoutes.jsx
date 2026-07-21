import { Routes, Route, Navigate } from "react-router-dom";

import Landing from "../modules/landing/Landing";
import Login from "../modules/auth/Login";
import Signup from "../modules/auth/Signup";
import VerifyEmail from "../modules/auth/VerifyEmail";
import ForgotPassword from "../modules/auth/ForgotPassword";
import AcceptInvite from "../modules/auth/AcceptInvite";
import Dashboard from "../modules/dashboard/Dashboard";
import Documents from "../modules/documents/Documents";
import UpdatesPage from "../modules/updates/Updates";
import AIAssistant from "../modules/ai/AIAssistant";
import Admin from "../modules/admin/Admin";
import Settings from "../modules/settings/Settings";
import Reports from "../modules/reports/Reports";
import ProtectedRoute from "../components/ProtectedRoute";

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />

      {/* Changing your password now lives in Settings; keep the old path working. */}
      <Route path="/change-password" element={<Navigate to="/settings?tab=security" replace />} />
      <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/documents" element={<ProtectedRoute><Documents /></ProtectedRoute>} />
      <Route path="/updates" element={<ProtectedRoute><UpdatesPage /></ProtectedRoute>} />
      <Route path="/ai" element={<ProtectedRoute><AIAssistant /></ProtectedRoute>} />

      <Route path="/reports" element={<ProtectedRoute><Reports /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute role="org_admin"><Admin /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />

      {/* Any unknown route → dashboard if logged in, otherwise login */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default AppRoutes;