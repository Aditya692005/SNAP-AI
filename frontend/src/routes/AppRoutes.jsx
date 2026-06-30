import { Routes, Route, Navigate } from "react-router-dom";

import Landing from "../modules/landing/Landing";
import Login from "../modules/auth/Login";
import Signup from "../modules/auth/Signup";
import VerifyEmail from "../modules/auth/VerifyEmail";
import Dashboard from "../modules/dashboard/Dashboard";
import Documents from "../modules/documents/Documents";
import AIAssistant from "../modules/ai/AIAssistant";
import Admin from "../modules/admin/Admin";
import ProtectedRoute from "../components/ProtectedRoute";
import PlaceholderPage from "../components/PlaceholderPage";

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/verify-email" element={<VerifyEmail />} />

      <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/documents" element={<ProtectedRoute><Documents /></ProtectedRoute>} />
      <Route path="/ai" element={<ProtectedRoute><AIAssistant /></ProtectedRoute>} />

      <Route path="/reports" element={<ProtectedRoute><PlaceholderPage title="Reports" description="Generate and view reports from your knowledge base." /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute role="org_admin"><Admin /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute><PlaceholderPage title="Settings" description="Configure your SNAP AI workspace." /></ProtectedRoute>} />

      {/* Any unknown route → dashboard if logged in, otherwise login */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default AppRoutes;