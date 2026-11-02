// public/js/safeArea.js — 把 Android 壳量到的挖孔 / 手势条尺寸写进 --sa-* 变量。
//
// 为什么需要：CSS 的 env(safe-area-inset-*) 在 WebView 里并不总是有值（挖孔信息要
// viewport-fit=cover + Chromium 够新），而且本项目的战术界面装在 music-shell.html 的
// iframe 里，iframe 文档拿不到外层设过的变量。所以由每个文档自己去问一次壳。
//
// 没有 AndroidShell（桌面浏览器 / 直接跑服务端）时什么都不做，完全沿用 env() 的行为。
const KEY = { top: '--sa-t', right: '--sa-r', bottom: '--sa-b', left: '--sa-l' };

function apply() {
  const shell = globalThis.AndroidShell;
  if (!shell || typeof shell.safeInsets !== 'function') return false;
  let insets;
  try {
    insets = JSON.parse(shell.safeInsets());
  } catch {
    return false;
  }
  if (!insets) return false;
  const root = document.documentElement;
  let any = false;
  for (const [side, prop] of Object.entries(KEY)) {
    const v = Number(insets[side]);
    if (!Number.isFinite(v) || v < 0) continue;
    root.style.setProperty(prop, `${v}px`);
    any = any || v > 0;
  }
  return any;
}

export function installSafeArea() {
  if (typeof document === 'undefined') return;
  apply();
  // 转屏、系统栏临时唤起都会改变 inset；壳里改了会重发一次，这里兜个底。
  globalThis.addEventListener?.('resize', () => { apply(); }, { passive: true });
  globalThis.addEventListener?.('orientationchange', () => {
    setTimeout(() => { apply(); }, 120);
  }, { passive: true });
  // 字体 / 布局晚一点稳定，再补一次（首帧时 WebView 的量可能还没回填）
  setTimeout(() => { apply(); }, 300);
  setTimeout(() => { apply(); }, 1200);
}
