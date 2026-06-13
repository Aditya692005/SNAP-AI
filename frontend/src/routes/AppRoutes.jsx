// routes/AppRoutes.jsx

import { Routes, Route } from "react-router-dom";

import Landing from "../modules/landing/Landing";
import Login from "../modules/auth/Login";
import Signup from "../modules/auth/Signup";
import Dashboard from "../modules/dashboard/Dashboard";

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/dashboard" element={<Dashboard />} />
    </Routes>
  );
}

export default AppRoutes;
