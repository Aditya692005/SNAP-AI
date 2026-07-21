import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AppShell from "../../components/AppShell";
import { authService, organizationService } from "../../services/authService";
import { getThemePreference, setThemePreference } from "../../services/theme";
import { passwordProblems } from "../../utils/password";
import { initials, roleLabel } from "../../utils/user";
import "./Settings.css";

const TABS = ["profile", "security"];

const THEME_OPTIONS = [
  { value: "system", icon: "🖥️", label: "System", hint: "Follow your OS setting" },
  { value: "dark", icon: "🌙", label: "Dark", hint: "The SNAP AI default" },
  { value: "light", icon: "☀️", label: "Light", hint: "Bright, high contrast" },
];

function formatDate(value, withTime = false) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

function Settings() {
  // The tab lives in the URL (unlike Admin's local-state tabs) so the UserMenu can
  // link straight to /settings?tab=security. Sidebar highlights on pathname alone,
  // so the query string doesn't disturb it.
  const [params, setParams] = useSearchParams();
  const rawTab = params.get("tab");
  const tab = TABS.includes(rawTab) ? rawTab : "profile";
  const setTab = (next) => setParams(next === "profile" ? {} : { tab: next }, { replace: true });

  const [user, setUser] = useState(authService.getUser());
  const [org, setOrg] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Profile tab
  const [name, setName] = useState(user?.name || "");
  const [savingName, setSavingName] = useState(false);

  // Appearance tab
  const [themePref, setThemePref] = useState(getThemePreference());

  // Security tab. The new-password fields stay hidden until the user has entered
  // their current password and confirmed it with "Continue".
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwUnlocked, setPwUnlocked] = useState(false);
  const [verifyingPw, setVerifyingPw] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  const pwProblems = passwordProblems(pw.next);

  // The cached user is a login-time snapshot: an admin may since have moved the
  // user's department or role. Re-fetch so the profile shows the truth.
  useEffect(() => {
    let alive = true;
    authService.refreshUser().then((fresh) => {
      if (!alive || !fresh) return;
      setUser(fresh);
      setName(fresh.name || "");
    });
    organizationService
      .get()
      .then((o) => {
        if (!alive) return;
        setOrg(o);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  async function saveName(e) {
    e.preventDefault();
    setError("");
    const trimmed = name.trim();
    if (trimmed.length < 2) return setError("Name must be at least 2 characters");
    if (trimmed === user?.name) return setError("That's already your name");

    setSavingName(true);
    try {
      const fresh = await authService.updateProfile({ name: trimmed });
      setUser(fresh);
      setName(fresh.name || "");
      setNotice("Profile updated");
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingName(false);
    }
  }

  function pickTheme(pref) {
    setThemePreference(pref);
    setThemePref(pref);
  }

  // Step 1: the new-password fields unlock only once the CURRENT password is
  // verified correct against the server.
  async function continueToNewPassword(e) {
    e.preventDefault();
    setError("");
    if (!pw.current) return setError("Enter your current password");
    setVerifyingPw(true);
    try {
      await authService.verifyPassword(pw.current);
      setPwUnlocked(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setVerifyingPw(false);
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    setError("");
    if (!pw.current) return setError("Enter your current password");
    if (pwProblems.length > 0) return setError("New password does not meet the requirements");
    if (pw.next !== pw.confirm) return setError("New passwords do not match");
    if (pw.next === pw.current) {
      return setError("New password must be different from your current password");
    }

    setSavingPw(true);
    try {
      await authService.changePassword(pw.current, pw.next);
      setPw({ current: "", next: "", confirm: "" });
      setPwUnlocked(false);
      setNotice("Password changed");
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingPw(false);
    }
  }

  if (!user) return null;

  const deptName = user.department_name || (user.department_id ? "…" : "Unassigned");

  return (
    <AppShell>
      <div className="settings-content">
        <div className="settings-header">
          <div>
            <span className="settings-eyebrow">SNAP AI · Account</span>
            <h1>Settings</h1>
            <p>Manage your profile, appearance and password.</p>
          </div>
          <div className="settings-tabs">
            <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>
              Profile
            </button>
            <button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>
              Security
            </button>
          </div>
        </div>

        {error && (
          <div className="settings-toast settings-error">
            <span>{error}</span>
            <button className="settings-toast-close" onClick={() => setError("")} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="settings-toast settings-notice">
            <span>{notice}</span>
            <button className="settings-toast-close" onClick={() => setNotice("")} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {/* ── PROFILE ───────────────────────────────────────────── */}
        {tab === "profile" && (
          <div className="settings-panel">
            <div className="settings-identity">
              <div className="settings-avatar">{initials(user.name, user.email)}</div>
              <div className="settings-identity-text">
                <h2>{user.name || "—"}</h2>
                <span>{user.email}</span>
              </div>
            </div>

            <form className="settings-field" onSubmit={saveName}>
              <label htmlFor="settings-name">Display name</label>
              <div className="settings-field-row">
                <input
                  id="settings-name"
                  type="text"
                  value={name}
                  maxLength={255}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError("");
                  }}
                  disabled={savingName}
                />
                <button type="submit" className="settings-save" disabled={savingName}>
                  {savingName ? "Saving…" : "Save"}
                </button>
              </div>
              <p className="settings-hint">This is the name teammates see on your uploads and shares.</p>
            </form>

            <div className="settings-sep" />

            {/* Everything below is assigned by an admin, so it is read-only here. */}
            <div className="settings-rows">
              <div className="settings-row">
                <span className="settings-key">Email</span>
                <span className="settings-val">
                  {user.email}
                  <span className={`settings-badge ${user.email_verified ? "on" : "pending"}`}>
                    {user.email_verified ? "Verified" : "Unverified"}
                  </span>
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-key">Role</span>
                <span className="settings-val">{roleLabel(user.role)}</span>
              </div>
              <div className="settings-row">
                <span className="settings-key">Department</span>
                <span className="settings-val">{deptName}</span>
              </div>
              <div className="settings-row">
                <span className="settings-key">Organization</span>
                <span className="settings-val">{org?.name || "—"}</span>
              </div>
              <div className="settings-row">
                <span className="settings-key">Member since</span>
                <span className="settings-val">{formatDate(user.created_at)}</span>
              </div>
            </div>
            <p className="settings-hint">
              Your role and department are set by a company admin. Ask them if either looks wrong.
            </p>

            <div className="settings-sep" />

            {/* Appearance lives here now — it's a personal preference like the rest. */}
            <h2 className="settings-panel-title">Appearance</h2>
            <p className="settings-hint">Theme applies to this browser only.</p>
            <div className="settings-themes">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`settings-theme-card ${themePref === opt.value ? "active" : ""}`}
                  onClick={() => pickTheme(opt.value)}
                  aria-pressed={themePref === opt.value}
                >
                  <span className="settings-theme-icon">{opt.icon}</span>
                  <span className="settings-theme-label">{opt.label}</span>
                  <span className="settings-theme-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── SECURITY ──────────────────────────────────────────── */}
        {tab === "security" && (
          <div className="settings-panel">
            <h2 className="settings-panel-title">Change password</h2>
            <form
              className="settings-form"
              onSubmit={pwUnlocked ? savePassword : continueToNewPassword}
            >
              <label htmlFor="pw-current">Current password</label>
              <input
                id="pw-current"
                type="password"
                autoComplete="current-password"
                value={pw.current}
                onChange={(e) => {
                  setPw((p) => ({ ...p, current: e.target.value }));
                  setError("");
                }}
                disabled={savingPw || verifyingPw || pwUnlocked}
              />
              {pwUnlocked && <p className="settings-hint">✓ Current password confirmed.</p>}

              {!pwUnlocked ? (
                <>
                  <p className="settings-hint">
                    Enter your current password to continue, then choose a new one.
                  </p>
                  <button
                    type="submit"
                    className="settings-save"
                    disabled={!pw.current || verifyingPw}
                  >
                    {verifyingPw ? "Verifying…" : "Continue"}
                  </button>
                </>
              ) : (
                <>
                  <label htmlFor="pw-next">New password</label>
                  <input
                    id="pw-next"
                    type="password"
                    autoComplete="new-password"
                    value={pw.next}
                    onChange={(e) => {
                      setPw((p) => ({ ...p, next: e.target.value }));
                      setError("");
                    }}
                    disabled={savingPw}
                    autoFocus
                  />
                  {pw.next && pwProblems.length > 0 && (
                    <ul className="settings-reqs">
                      {pwProblems.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}

                  <label htmlFor="pw-confirm">Confirm new password</label>
                  <input
                    id="pw-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={pw.confirm}
                    onChange={(e) => {
                      setPw((p) => ({ ...p, confirm: e.target.value }));
                      setError("");
                    }}
                    disabled={savingPw}
                  />

                  <button type="submit" className="settings-save" disabled={savingPw}>
                    {savingPw ? "Updating…" : "Change password"}
                  </button>
                </>
              )}
            </form>

            <div className="settings-sep" />

            <div className="settings-rows">
              <div className="settings-row">
                <span className="settings-key">Last sign-in</span>
                <span className="settings-val">{formatDate(user.last_login, true)}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default Settings;
