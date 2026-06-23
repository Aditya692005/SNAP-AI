import { Routes, Route, Navigate } from "react-router-dom";

import Landing from "../modules/landing/Landing";
import Login from "../modules/auth/Login";
import Signup from "../modules/auth/Signup";
import VerifyEmail from "../modules/auth/VerifyEmail";
import Dashboard from "../modules/dashboard/Dashboard";
import Documents from "../modules/documents/Documents";
import AIAssistant from "../modules/ai/AIAssistant";
import ProtectedRoute from "../components/ProtectedRoute";

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

      {/* Any unknown route → redirect to login */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default AppRoutes;