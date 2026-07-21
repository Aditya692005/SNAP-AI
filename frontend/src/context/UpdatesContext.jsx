import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { authService, updatesService } from "../services/authService";
import UpdatesPopups from "../components/UpdatesPopups";

// Global store for the in-app "Updates" feed: the notifications list, the unread
// count (drives the sidebar badge), and the transient popups that appear for
// ~10s when a new update lands. The full list lives on its own page (/updates);
// this provider just keeps the data warm and surfaces new arrivals as popups.
// Poll-based — the backend has no websocket — but cheap: a small list every
// POLL_MS, plus an immediate refresh on navigation, tab focus, and after the
// chat posts an AI-reply update.

const POLL_MS = 25000;
const POPUP_MS = 10000; // requirement: the popup shows for 10 seconds

const UpdatesContext = createContext(null);

export function useUpdates() {
  const ctx = useContext(UpdatesContext);
  if (!ctx) throw new Error("useUpdates must be used inside <UpdatesProvider>");
  return ctx;
}

export function UpdatesProvider({ children }) {
  const [updates, setUpdates] = useState([]);
  const [unread, setUnread] = useState(0);
  const [popups, setPopups] = useState([]);

  const location = useLocation();
  // Ids we've already surfaced, so a poll only pops NEW arrivals. Seeded on the
  // first load so existing unread items don't all pop at once on page load.
  const knownIds = useRef(new Set());
  const seeded = useRef(false);

  const dismissPopup = useCallback((id) => {
    setPopups((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const refresh = useCallback(async () => {
    if (!authService.isAuthenticated()) return;
    let data;
    try {
      data = await updatesService.list();
    } catch {
      return; // transient/network — keep whatever we have
    }
    const list = data.updates || [];
    setUpdates(list);
    setUnread(data.unread || 0);

    // Newly-arrived unread updates → popups (skip the very first seed).
    const fresh = list.filter((u) => !u.read_at && !knownIds.current.has(u.id));
    if (seeded.current && fresh.length > 0) {
      setPopups((prev) => [...fresh.slice(0, 3), ...prev].slice(0, 4));
    }
    list.forEach((u) => knownIds.current.add(u.id));
    seeded.current = true;
  }, []);

  // Poll + refresh on navigation / focus. The pathname dep also kicks off the
  // first fetch right after login (the app redirects to /dashboard).
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    const onManual = () => refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("snap:updates-refresh", onManual);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("snap:updates-refresh", onManual);
    };
  }, [refresh, location.pathname]);

  // Auto-dismiss each popup after POPUP_MS.
  useEffect(() => {
    if (popups.length === 0) return undefined;
    const timers = popups.map((p) => setTimeout(() => dismissPopup(p.id), POPUP_MS));
    return () => timers.forEach(clearTimeout);
  }, [popups, dismissPopup]);

  const markAllRead = useCallback(async () => {
    // Optimistic: clear the badge immediately, then confirm with the server.
    setUpdates((prev) => prev.map((u) => (u.read_at ? u : { ...u, read_at: new Date().toISOString() })));
    setUnread(0);
    try {
      const { unread: n } = await updatesService.markRead();
      setUnread(n || 0);
    } catch {
      refresh();
    }
  }, [refresh]);

  const markOneRead = useCallback(async (id) => {
    setUpdates((prev) =>
      prev.map((u) => (u.id === id && !u.read_at ? { ...u, read_at: new Date().toISOString() } : u))
    );
    setUnread((n) => Math.max(0, n - 1));
    try {
      await updatesService.markRead([id]);
    } catch {
      refresh();
    }
  }, [refresh]);

  const removeUpdate = useCallback(async (id) => {
    // Optimistic remove; drop the badge if it was unread. Keep it out of the
    // popup stack too. Re-syncs from the server on failure.
    let wasUnread = false;
    setUpdates((prev) => {
      const target = prev.find((u) => u.id === id);
      wasUnread = target ? !target.read_at : false;
      return prev.filter((u) => u.id !== id);
    });
    setPopups((prev) => prev.filter((p) => p.id !== id));
    if (wasUnread) setUnread((n) => Math.max(0, n - 1));
    try {
      const { unread: n } = await updatesService.remove(id);
      if (typeof n === "number") setUnread(n);
    } catch {
      refresh();
    }
  }, [refresh]);

  const clearAll = useCallback(async () => {
    setUpdates([]);
    setPopups([]);
    setUnread(0);
    try {
      await updatesService.clearAll();
    } catch {
      refresh();
    }
  }, [refresh]);

  const value = {
    updates,
    unread,
    popups,
    refresh,
    markAllRead,
    markOneRead,
    removeUpdate,
    clearAll,
    dismissPopup,
  };

  return (
    <UpdatesContext.Provider value={value}>
      {children}
      <UpdatesPopups />
    </UpdatesContext.Provider>
  );
}

export default UpdatesProvider;
