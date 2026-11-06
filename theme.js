/* 全局深色模式：切换根节点主题，状态保存在 localStorage */
(function () {
  'use strict';

  const KEY = 'studyhub.theme';
  const root = document.documentElement;
  let current = 'light';

  function readSaved() {
    try {
      const saved = localStorage.getItem(KEY);
      return saved === 'dark' || saved === 'light' ? saved : 'light';
    } catch (e) {
      return 'light';
    }
  }

  function writeSaved(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) { /* 隐私模式忽略 */ }
  }

  function syncButton() {
    const btn = document.getElementById('theme-toggle');
    const icon = document.getElementById('theme-icon');
    if (!btn || !icon) return;
    const dark = current === 'dark';
    icon.textContent = dark ? '☀️' : '🌙';
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
    btn.title = dark ? '切换到浅色模式' : '切换到深色模式';
  }

  function apply(theme, persist) {
    current = theme === 'dark' ? 'dark' : 'light';
    const dark = current === 'dark';
    root.classList.toggle('dark', dark);
    root.dataset.theme = current;
    if (persist) writeSaved(current);
    syncButton();
  }

  // 在 body 渲染前应用，避免深色模式刷新时闪白
  apply(readSaved(), false);

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        apply(current === 'dark' ? 'light' : 'dark', true);
      });
    }
    syncButton();
  });

  // 其他标签页切换主题时同步过来
  window.addEventListener('storage', e => {
    if (e.key !== KEY) return;
    apply(e.newValue === 'dark' ? 'dark' : 'light', false);
  });

  window.studyhubTheme = {
    get: () => current,
    set: theme => apply(theme, true)
  };
})();
