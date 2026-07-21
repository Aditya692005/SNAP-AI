// Theme handling.
//
// Two distinct ideas, deliberately kept apart:
//   - the PREFERENCE the user picked: "system" | "dark" | "light"  (persisted)
//   - the RESOLVED theme actually painted:      "dark" | "light"   (applied to <html>)
// They differ only when the preference is "system", where the OS decides.
//
// Dark remains the default when nothing is stored, preserving the original
// behaviour. The resolved theme is applied as `data-theme` on <html>; see
// theme.css, which overrides for light only.

const KEY = "theme";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function systemTheme() {
  return window.matchMedia?.(LIGHT_QUERY).matches ? "light" : "dark";
}

// "system" | "dark" | "light". Anything unrecognised (or absent) means dark.
export function getThemePreference() {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "system" ? stored : "dark";
}

// The theme actually in effect right now: never "system".
export function getTheme() {
  const pref = getThemePreference();
  return pref === "system" ? systemTheme() : pref;
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function setThemePreference(pref) {
  localStorage.setItem(KEY, pref);
  const resolved = pref === "system" ? systemTheme() : pref;
  applyTheme(resolved);
  return resolved;
}

// Explicit dark <-> light flip (the UserMenu shortcut). Flipping while on
// "system" pins the user to the opposite of whatever they're currently seeing,
// which is what a toggle labelled with the current theme should do.
export function setTheme(theme) {
  return setThemePreference(theme);
}

export function toggleTheme() {
  const next = getTheme() === "dark" ? "light" : "dark";
  setThemePreference(next);
  return next;
}

// Call once on startup so the saved theme (or dark default) is applied before
// render, and so a "system" user follows their OS live rather than only on reload.
export function initTheme() {
  applyTheme(getTheme());
  window.matchMedia?.(LIGHT_QUERY).addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme(systemTheme());
  });
}
