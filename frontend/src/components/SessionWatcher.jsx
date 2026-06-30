import { useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { authService } from "../services/authService";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

// Watches the session so a server-side change (e.g. an admin deactivating the
// user) logs them out promptly. Checks on every navigation, on window focus,
// and on a short interval. The backend's requireAuth returns 401 for a
// deactivated/invalid account, which is our signal to clear and redirect.
export default function SessionWatcher() {
  const navigate = useNavigate();
  const location = useLocation();

  const check = useCallback(async () => {
    if (!authService.isAuthenticated()) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${authService.getToken()}` },
      });
      if (res.status === 401) {
        authService.logout();
        navigate("/login", { replace: true });
      }
    } catch {
      /* network blip — ignore, try again next tick */
    }
  }, [navigate]);

  // Check on every route change.
  useEffect(() => {
    check();
  }, [location.pathname, check]);

  // Poll + check when the tab regains focus (covers an idle, logged-in user).
  useEffect(() => {
    const id = setInterval(check, 15000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", check);
    };
  }, [check]);

  return null;
}
