import { Routes, Route } from "react-router-dom";

import Landing from "../modules/landing/Landing";
import Login from "../modules/auth/Login";
import Signup from "../modules/auth/Signup";
import Dashboard from "../modules/dashboard/Dashboard";
import Documents from "../modules/documents/Documents";
import AIAssistant from "../modules/ai/AIAssistant";

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/documents" element={<Documents />} />
      <Route path="/ai" element={<AIAssistant />} />
    </Routes>
  );
}

export default AppRoutes;
