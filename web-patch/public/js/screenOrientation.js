// screenOrientation.js — 设置「战斗界面屏幕方向」(settings battleOrientation, ui/gameLogic/settings.js SCREEN_ORIENTATIONS).
//
// 'landscape' 横屏 (the default: the battle field is designed for a wide screen) | 'auto' 自动 | 'portrait' 竖屏.
//
// Two hosts, two mechanisms:
//   * the Android shell (the APK) exposes `window.AndroidShell.setBattleOrientation(mode)` — it re-locks the activity's
//     requestedOrientation, which no browser API can do. It returns false when the value did not change and `true` once
//     it has been applied, so a truthy result means "handled, do not fall through".
//   * a plain browser only allows the Screen Orientation API while the page is fullscreen; both calls are wrapped, since
//     a refused lock throws (Android Chrome) or does not exist at all (desktop Firefox).

const MODES = ['landscape', 'auto', 'portrait'];

/**
 * Whether an Android shell (the APK's WebView) is driving this page.
 * @returns {boolean}
 */
export function hasAndroidShell() {
  try { return typeof window.AndroidShell?.setBattleOrientation === 'function'; } catch { return false; }
}

/**
 * Ask the host to use the given orientation. Unknown values fall back to 'auto'.
 * @param {'landscape'|'auto'|'portrait'} value
 * @returns {boolean} whether the request reached a host that can honour it
 */
export function applyBattleOrientation(value) {
  const mode = MODES.includes(value) ? value : 'auto';
  try {
    const shell = window.AndroidShell;
    if (typeof shell?.setBattleOrientation === 'function') { shell.setBattleOrientation(mode); return true; }
  } catch { /* the bridge is gone (page reloaded, activity finished) — fall through */ }
  const orientation = globalThis.screen?.orientation;
  try {
    if (mode === 'auto') { orientation?.unlock?.(); return true; }
    const target = mode === 'landscape' ? 'landscape' : 'portrait';
    const result = orientation?.lock?.(target);
    if (result && typeof result.catch === 'function') result.catch(() => { /* refused outside fullscreen */ });
    return !!result;
  } catch { return false; }
}
