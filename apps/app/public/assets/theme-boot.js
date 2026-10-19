// Applies the stored theme before the first paint, so the page never flashes the wrong one. A classic script from the
// app's own origin (the Content-Security-Policy allows no inline script). Same rule as src/lib/theme.ts: "light",
// "dark" or "system" from localStorage key "crove-theme", light when nothing valid is stored.
(function () {
  var setting = null;
  try {
    setting = localStorage.getItem('crove-theme');
  } catch {
    // Storage blocked: the default applies.
  }
  var system = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
  var dark = setting === 'system' ? system : setting === 'dark';
  var root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
