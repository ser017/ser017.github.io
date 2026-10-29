(() => {
  const key = 'ser017-blog-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try { const saved = localStorage.getItem(key); if (saved === 'light' || saved === 'dark') preference = saved; } catch {}
  const current = () => preference || (system.matches ? 'dark' : 'light');
  function apply() {
    const dark = current() === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const label = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
      button.setAttribute('aria-label', 'Тёмная тема');
      button.setAttribute('title', label);
      button.setAttribute('aria-checked', String(dark));
      button.hidden = false;
    });
  }
  // Выполняется в head до CSS: сохранённая тема применяется до первой отрисовки.
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.addEventListener('click', () => {
        preference = current() === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(key, preference); } catch {}
        apply();
      });
    });
    apply();
  });
  system.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key) return;
    preference = ['light', 'dark'].includes(event.newValue) ? event.newValue : null;
    apply();
  });
})();