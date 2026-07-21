// Theme handling. Dark is the default; the choice persists in localStorage and
// is applied as `data-theme` on <html> (see theme.css for light overrides).

const KEY = "theme";

export function getTheme() {
  return localStorage.getItem(KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

export function toggleTheme() {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

// Call once on startup so the saved theme (or dark default) is applied before render.
export function initTheme() {
  applyTheme(getTheme());
}
