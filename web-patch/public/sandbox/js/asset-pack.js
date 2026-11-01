// public/sandbox/js/ui/asset-pack.js — 设置 →「读取方舟资源」区块。
//
// 这块只在 Android 壳里出现（window.AndroidShell 存在时才渲染）。桌面 / 浏览器里
// 提取是 `npm run assets` 的事，网页里没得点，所以整块隐藏。
//
// 它做三件事：
//   1. 告诉用户现在的状态：Shizuku 装没装 / 服务跑没跑 / 有没有授权 / 资源目录能不能读 / 已经提取了多少
//   2. 提供「读取方舟资源」按钮，点了走壳里的 Shizuku（shell 身份直读方舟 bundle）
//   3. 讲清楚为什么要这条通道（方舟自己的目录普通应用读不到），以及没走通会退化成什么样
//
// UI 一律沿用设置对话框的既有 class（settings__row / menu__button / settings__hint），
// 文案也保持原有中文口吻。

const shell = () => globalThis.AndroidShell;
const hasShell = () => {
  const s = shell();
  return !!(s && typeof s.extractStatus === 'function');
};

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1 << 30) return `${(v / (1 << 30)).toFixed(2)} GB`;
  if (v >= 1 << 20) return `${(v / (1 << 20)).toFixed(1)} MB`;
  if (v >= 1 << 10) return `${(v / (1 << 10)).toFixed(0)} KB`;
  return v > 0 ? `${v} B` : '尚未提取';
};

/** 读一次壳里的状态；任何一步失败都退回安全默认值。 */
export function readAssetState() {
  const s = shell();
  const out = {
    installed: false, alive: false, granted: false, uid: -1, version: -1,
    arkReadable: false, ready: false, running: false, phase: 'IDLE',
    message: '', bytes: 0, tail: '', exit: -1,
    flavors: [], currentFlavor: 'cn',
  };
  if (!hasShell()) return out;
  try {
    const st = JSON.parse(s.shizukuStatus() || '{}');
    Object.assign(out, {
      installed: !!st.installed, alive: !!st.alive, granted: !!st.granted,
      uid: Number(st.uid) || -1, version: Number(st.version) || -1,
      arkReadable: !!st.arkReadable,
    });
  } catch { /* 保持默认 */ }
  try {
    const fl = JSON.parse(s.arkFlavors ? s.arkFlavors() : '{}');
    out.flavors = Array.isArray(fl.flavors) ? fl.flavors : [];
    out.currentFlavor = String(fl.current || 'cn');
  } catch { /* 保持默认 */ }
  try {
    const ex = JSON.parse(s.extractStatus() || '{}');
    Object.assign(out, {
      ready: !!ex.ready, running: !!ex.running, phase: String(ex.phase || 'IDLE'),
      message: String(ex.message || ''), bytes: Number(ex.bytes) || 0,
      tail: String(ex.tail || ''), exit: Number(ex.exit) || -1,
    });
  } catch { /* 保持默认 */ }
  return out;
}

/** 一句话状态：设置页那行小字。 */
export function statusLine(st) {
  if (!hasShell()) return '仅 Android 版支持';
  if (!st.installed) return '未安装 Shizuku · 官方美术会退化为替代素材';
  if (!st.alive) return 'Shizuku 服务没在运行 · 请先启动 Shizuku';
  if (!st.granted) return '还没授权本应用使用 Shizuku';
  if (!st.arkReadable) return '读不到方舟资源目录 · 确认方舟已安装且资源已下载';
  if (st.running) return `正在提取… ${st.message || ''}`.trim();
  if (st.phase === 'FAILED') return `上次提取失败 · ${st.message || ''}`.trim();
  if (st.ready) return `${fmtBytes(st.bytes)} 已就绪`;
  return '已就绪，可以直接提取';
}

/** 徽章配色：就绪绿、需要动作黄、失败红。 */
function toneOf(st) {
  if (!hasShell()) return 'off';
  if (st.phase === 'FAILED') return 'bad';
  if (st.running) return 'busy';
  if (st.granted && st.arkReadable) return 'ok';
  return 'warn';
}

/**
 * 生成设置对话框里的资源区块 HTML。
 * @param {{ log?: string[] }} [opts] 之前跑过的日志（对话框里实时刷）
 */
export function assetSectionHtml(st) {
  if (!hasShell()) {
    return '';
  }
  const tone = toneOf(st);
  const badge = {
    ok: '已就绪', warn: '需要授权', bad: '上次失败', busy: '提取中', off: '不可用',
  }[tone] || '';
  const btnLabel = st.running ? '正在提取…' : (st.ready ? '重新提取' : '开始提取');
  const disabled = st.running ? ' disabled' : '';

  const steps = [];
  if (!st.installed) {
    steps.push('安装 <a href="https://shizuku.rikka.app/" target="_blank" rel="noopener">Shizuku</a>（开源免费，无需 root），按它里面的提示用无线调试启动服务。');
  } else if (!st.alive) {
    steps.push('打开 Shizuku，让它里面的服务跑起来（手机重启后需要重新启动一次）。');
  } else if (!st.granted) {
    steps.push('点下面的「开始提取」，系统会弹一个授权框，选「允许」即可。');
  } else if (!st.arkReadable) {
    steps.push('读了 Shizuku 但还是进不去方舟目录 —— 确认《明日方舟》已安装并且资源包已下载完。');
  }

  return `<section class="settings__assets">
    <h3>方舟本地资源 <span class="settings__badge is-${tone}">${badge}</span></h3>
    <p class="settings__hint settings__assets-state" data-asset-state>${escapeHtml(statusLine(st))}</p>
    <p class="settings__hint settings__assets-why">
      棋盘贴图、干员立绘、敌人模型这些官方美术不在公开资源里，只能从手机上的《明日方舟》里读。
      那个目录属于方舟自己，普通应用（含本应用、含「所有文件访问权限」）都读不到，
      所以要借 <b>Shizuku</b> 拿到 shell 身份 —— 全程<b>只读</b>，不改动方舟的任何文件，
      提取出的图片也只写在本应用自己的目录里。
    </p>
    ${flavorSelectHtml(st)}
    ${steps.length ? `<p class="settings__hint settings__assets-todo">还差一步：${steps.join(' ')}</p>` : ''}
    <div class="settings__assets-actions">
      <button type="button" class="menu__button menu__button--primary" data-asset-extract${disabled}>${btnLabel}</button>
      <button type="button" class="menu__button" data-asset-help>授权教程</button>
      <span class="settings__assets-size" data-asset-size>${fmtBytes(st.bytes)}</span>
    </div>
    <p class="settings__hint settings__assets-note">
      没走通也不影响玩：只是官方美术改用替代素材，玩法与数值完全不受影响。
    </p>
  </section>`;
}

/** 包体切换：默认简中官服；B 服可用；其它语言服先列出但标「暂不可用」。 */
function flavorSelectHtml(st) {
  const list = st.flavors || [];
  if (!list.length) return '';
  const rows = list.map((f) => {
    const on = f.id === st.currentFlavor;
    let hint;
    if (!f.usable) hint = '暂不可用';
    else if (!f.installed) hint = '未安装';
    else hint = '已安装';
    const disabled = !f.usable || (f.id !== st.currentFlavor && !f.installed);
    return `<button type="button" class="settings__flavor${on ? ' is-on' : ''}${f.usable ? '' : ' is-off'}"
      data-flavor="${escapeHtml(f.id)}"${disabled ? ' disabled' : ''} aria-pressed="${on}">
      <b>${escapeHtml(f.label)}</b>
      <small>${escapeHtml(f.pkg)}</small>
      <span class="settings__flavor-tag${f.usable ? '' : ' is-off'}">${escapeHtml(hint)}</span>
    </button>`;
  }).join('');
  return `<div class="settings__flavors">
    <p class="settings__hint">读取哪个客户端的资源：默认简中官服；装了 B 服也可以切过去读 B 服的文件。
      其它语言服暂时用不了（目录结构与资源命名还没适配，先列在这里）。</p>
    <div class="settings__flavor-list">${rows}</div>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 把资源区块接到已打开的设置对话框上：按钮、轮询刷新、教程。
 * @param {HTMLDialogElement} dialog
 */
export function wireAssetSection(dialog) {
  const box = dialog.querySelector('.settings__assets');
  if (!box) return () => {};

  const stateEl = box.querySelector('[data-asset-state]');
  const sizeEl = box.querySelector('[data-asset-size]');
  const badgeEl = box.querySelector('.settings__badge');
  const btn = box.querySelector('[data-asset-extract]');
  const status = dialog.querySelector('[role="status"]');

  const refresh = () => {
    const st = readAssetState();
    if (stateEl) stateEl.textContent = statusLine(st);
    if (sizeEl) sizeEl.textContent = fmtBytes(st.bytes);
    if (badgeEl) {
      const tone = toneOf(st);
      badgeEl.className = `settings__badge is-${tone}`;
      badgeEl.textContent = { ok: '已就绪', warn: '需要授权', bad: '上次失败', busy: '提取中', off: '不可用' }[tone] || '';
    }
    if (btn) {
      btn.disabled = st.running;
      btn.textContent = st.running ? '正在提取…' : (st.ready ? '重新提取' : '开始提取');
    }
  };

  btn?.addEventListener('click', () => {
    const s = shell();
    let reply;
    try {
      reply = s.extractAssets();
    } catch (error) {
      reply = `调用失败：${error.message}`;
    }
    if (status) status.textContent = reply || '已开始提取';
    refresh();
  });

  // 包体切换：点了立刻写进壳，然后把整块重画一遍（当前项高亮与「已安装」都变了）
  box.addEventListener('click', (e) => {
    const f = e.target.closest('[data-flavor]');
    if (!f || f.disabled) return;
    try {
      shell().selectArkFlavor(f.dataset.flavor);
    } catch (error) {
      if (status) status.textContent = `切换失败：${error.message}`;
      return;
    }
    // 重画整个资源区块：把新的状态塞回去，按钮、徽章、路径一次全更新
    const host = box.parentElement;
    if (host) {
      const tmp = document.createElement('div');
      tmp.innerHTML = assetSectionHtml(readAssetState());
      const fresh = tmp.querySelector('.settings__assets');
      if (fresh) box.replaceWith(fresh);
    }
    const ctl = dialog.querySelector('[role="status"]');
    if (ctl) ctl.textContent = `已切换到 ${f.querySelector('b')?.textContent || f.dataset.flavor}`;
    refresh();
  });

  box.querySelector('[data-asset-help]')?.addEventListener('click', () => {
    try {
      shell().showShizukuHelp();
    } catch { /* 没有壳就什么都不做 */ }
  });

  // 提取是后台线程跑的，这里每秒问一次；对话框关掉就停。
  const timer = setInterval(() => {
    if (!dialog.isConnected || !dialog.open) {
      clearInterval(timer);
      return;
    }
    refresh();
  }, 1000);

  refresh();
  return () => clearInterval(timer);
}
