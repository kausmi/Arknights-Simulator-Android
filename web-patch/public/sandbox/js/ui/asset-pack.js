// public/sandbox/js/ui/asset-pack.js — 设置 →「读取方舟资源」区块。
//
// 这块只在 Android 壳里出现（window.AndroidShell 存在时才渲染）。桌面 / 浏览器里
// 提取是 `npm run assets` 的事，网页里没得点，所以整块隐藏。
//
// 它做三件事：
//   1. 告诉用户现在的状态：提权通道通不通 / 资源目录能不能读 / 已经提取了多少
//   2. 提供「读取方舟资源」按钮，点了走壳里的提权通道（直接读方舟 bundle，不落中间副本）
//
// 提权通道有两条，用户可以在这里切换：
//   shizuku —— 借 Shizuku 的 shell 身份（uid 2000），不用 root，装个 App 就行
//   root    —— 走 su 拿 uid 0，手机已经 root 且授权给本应用时可用，权限更大
// 两条通道对上层的提取流程完全等价，差别只在「谁能进那个目录」。
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
    channel: 'shizuku', channelReady: false, channelReason: '',
    rootAvailable: false, rootProbe: '',
    arkReadable: false, ready: false, running: false, phase: 'IDLE',
    message: '', bytes: 0, tail: '', exit: -1,
    percent: 0, step: '', eta: -1,
    flavors: [], currentFlavor: 'cn',
  };
  if (!hasShell()) return out;
  try {
    const st = JSON.parse(s.shizukuStatus() || '{}');
    Object.assign(out, {
      installed: !!st.installed, alive: !!st.alive, granted: !!st.granted,
      uid: Number(st.uid) || -1, version: Number(st.version) || -1,
      arkReadable: !!st.arkReadable,
      channel: String(st.channel || 'shizuku'),
      channelReady: !!st.channelReady,
      channelReason: String(st.channelReason || ''),
      rootAvailable: !!st.rootAvailable,
      rootProbe: String(st.rootProbe || ''),
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
      percent: Math.max(0, Math.min(100, Number(ex.percent) || 0)),
      step: String(ex.step || ''), eta: Number(ex.eta) || -1,
    });
  } catch { /* 保持默认 */ }
  return out;
}

/** 剩余时间：给个粗糙但好读的量级，估不出来时说实话。 */
export function fmtEta(sec) {
  const v = Number(sec);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v <= 2) return '就快好了';
  if (v < 60) return `大约还要 ${Math.round(v)} 秒`;
  if (v < 3600) return `大约还要 ${Math.round(v / 60)} 分钟`;
  return `大约还要 ${(v / 3600).toFixed(1)} 小时`;
}

/** 一句话状态：设置页那行小字。 */
export function statusLine(st) {
  if (!hasShell()) return '仅 Android 版支持';
  const isRoot = st.channel === 'root';
  if (isRoot) {
    if (!st.rootAvailable) return `还没拿到超级用户权限${st.channelReason ? ` · ${st.channelReason}` : ''}`;
  } else {
    if (!st.installed) return '未安装 Shizuku · 官方美术会退化为替代素材';
    if (!st.alive) return 'Shizuku 服务没在运行 · 请先启动 Shizuku';
    if (!st.granted) return '还没授权本应用使用 Shizuku';
  }
  if (!st.arkReadable) return '读不到方舟资源目录 · 确认方舟已安装且资源已下载';
  if (st.running) {
    const pct = st.percent > 0 ? ` ${st.percent.toFixed(0)}%` : '';
    const step = st.step ? ` · ${st.step}` : '';
    const eta = fmtEta(st.eta);
    return `正在提取${pct}${step}${eta ? ` · ${eta}` : ''}`.trim();
  }
  if (st.phase === 'FAILED') return `上次提取失败 · ${st.message || ''}`.trim();
  if (st.ready) return `${fmtBytes(st.bytes)} 已就绪`;
  return '已就绪，可以直接提取';
}

/** 徽章配色：就绪绿、需要动作黄、失败红。 */
function toneOf(st) {
  if (!hasShell()) return 'off';
  if (st.phase === 'FAILED') return 'bad';
  if (st.running) return 'busy';
  if (st.channelReady && st.arkReadable) return 'ok';
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

  const isRoot = st.channel === 'root';
  const steps = [];
  if (isRoot) {
    if (!st.rootAvailable) {
      steps.push('这台设备还没给本应用超级用户权限。点下面「申请超级用户权限」，root 管理器（Magisk / KernelSU / APatch 等）会弹框，选「允许」。');
    } else if (!st.arkReadable) {
      steps.push('已经有 root 了，但还是进不去方舟目录 —— 确认《明日方舟》已安装并且资源包已下载完。');
    }
  } else {
    if (!st.installed) {
      steps.push('安装 <a href="https://shizuku.rikka.app/" target="_blank" rel="noopener">Shizuku</a>（开源免费，无需 root），按它里面的提示用无线调试启动服务。');
    } else if (!st.alive) {
      steps.push('打开 Shizuku，让它里面的服务跑起来（手机重启后需要重新启动一次）。');
    } else if (!st.granted) {
      steps.push('点下面的「开始提取」，系统会弹一个授权框，选「允许」即可。');
    } else if (!st.arkReadable) {
      steps.push('读了 Shizuku 但还是进不去方舟目录 —— 确认《明日方舟》已安装并且资源包已下载完。');
    }
  }

  return `<section class="settings__assets">
    <h3>方舟本地资源 <span class="settings__badge is-${tone}">${badge}</span></h3>
    <p class="settings__hint settings__assets-state" data-asset-state>${escapeHtml(statusLine(st))}</p>
    <p class="settings__hint settings__assets-why">
      棋盘贴图、干员立绘、敌人模型这些官方美术不在公开资源里，只能从手机上的《明日方舟》里读。
      那个目录属于方舟自己，普通应用（含本应用、含「所有文件访问权限」）都读不到，
      所以要借 ${isRoot ? '<b>root</b> 权限' : '<b>Shizuku</b> 的 shell 身份'}进去 —— 全程<b>只读</b>，不改动方舟的任何文件。
    </p>
    <p class="settings__hint settings__assets-privacy">
      解出来的图片<b>只存在 App 私有目录</b>（<code data-asset-path>/data/user/0/com.arksim.app/files/web</code>），
      不进相册、不进媒体库、文件管理器也翻不到，卸载 App 就一起清掉。
      提取时 python 只在自己的一次性临时目录里过一手，转存完立刻删除。
    </p>
    ${channelSelectHtml(st)}
    ${flavorSelectHtml(st)}
    ${steps.length ? `<p class="settings__hint settings__assets-todo">还差一步：${steps.join(' ')}</p>` : ''}
    <div class="settings__progress" data-asset-progress${st.running ? '' : ' hidden'}>
      <div class="settings__progress-bar"><i data-asset-fill style="width:${st.percent.toFixed(1)}%"></i></div>
      <div class="settings__progress-meta">
        <span data-asset-phase>${escapeHtml(st.step || '准备中')}</span>
        <span data-asset-percent>${st.percent.toFixed(0)}%</span>
        <span data-asset-eta>${escapeHtml(fmtEta(st.eta))}</span>
      </div>
    </div>
    <div class="settings__assets-actions">
      <button type="button" class="menu__button menu__button--primary" data-asset-extract${disabled}>${btnLabel}</button>
      ${isRoot ? '<button type="button" class="menu__button" data-asset-root>申请超级用户权限</button>' : ''}
      <button type="button" class="menu__button" data-asset-help>授权教程</button>
      <span class="settings__assets-size" data-asset-size>${fmtBytes(st.bytes)}</span>
    </div>
    <p class="settings__hint settings__assets-note">
      没走通也不影响玩：只是官方美术改用替代素材，玩法与数值完全不受影响。
    </p>
  </section>`;
}

/**
 * 提权通道切换：Shizuku（不用 root）/ root（需要超级用户权限）。
 *
 * 放在包体选择器上面 —— 先决定「用哪种身份进门」，再决定「进哪个客户端的门」，
 * 这个顺序和用户脑子里的顺序一致。
 */
function channelSelectHtml(st) {
  const isRoot = st.channel === 'root';
  const shizukuOk = st.alive && st.granted;
  const rootOk = st.rootAvailable;
  const card = (id, title, desc, ok, active, extra) => `
    <button type="button" class="settings__channel${active ? ' is-on' : ''}${ok ? '' : ' is-off'}"
      data-channel="${id}" aria-pressed="${active}">
      <b>${title}${active ? '<span class="settings__channel-now">使用中</span>' : ''}</b>
      <small>${desc}</small>
      <span class="settings__flavor-tag${ok ? '' : ' is-off'}">${ok ? '可用' : '待配置'}</span>
      ${extra || ''}
    </button>`;
  const shizukuDesc = shizukuOk
    ? '借 Shizuku 的 shell 身份读取，全程只读'
    : '装 Shizuku 并用无线调试启动服务后可用；不需要 root';
  const rootDesc = rootOk
    ? '已获得超级用户权限，直接以 root 身份读取'
    : '手机需已 root（Magisk / KernelSU / APatch 等）并授权本应用';
  return `<div class="settings__channels">
    <p class="settings__hint">用哪种身份去读方舟的资源目录：两条通道读出来的东西完全一样，
      区别只是「谁有权限进那个目录」。已经 root 的手机走 ROOT 最省事，不用装 Shizuku；没 root 就用 Shizuku。</p>
    <div class="settings__channel-list">
      ${card('shizuku', 'Shizuku（shell 身份）', shizukuDesc, shizukuOk, !isRoot)}
      ${card('root', 'ROOT（超级用户）', rootDesc, rootOk, isRoot)}
    </div>
    <p class="settings__hint settings__channel-note">
      ${isRoot
        ? '当前走 ROOT：直接以 uid 0 读取。提取产物仍然只落在 App 私有目录，不进相册与媒体库。'
        : '当前走 Shizuku：以 shell 身份（uid 2000）读取。提取产物只落在 App 私有目录，不进相册与媒体库。'}
    </p>
  </div>`;
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

/** 进度条：只在提取中显示；跑完/失败后藏起来，别留个 100% 的空条。 */
function paintProgress(st) {
  const box = document.querySelector('.settings__assets [data-asset-progress]');
  if (!box) return;
  const on = !!st.running;
  box.hidden = !on;
  if (!on) return;
  const fill = box.querySelector('[data-asset-fill]');
  if (fill) fill.style.width = `${st.percent.toFixed(1)}%`;
  const phase = box.querySelector('[data-asset-phase]');
  if (phase) phase.textContent = st.step || '准备中';
  const pct = box.querySelector('[data-asset-percent]');
  if (pct) pct.textContent = `${st.percent.toFixed(0)}%`;
  const eta = box.querySelector('[data-asset-eta]');
  if (eta) eta.textContent = fmtEta(st.eta);
}

/**
 * 把资源区块接到已打开的设置对话框上：按钮、轮询刷新、教程。
 * @param {HTMLDialogElement} dialog
 */
export function wireAssetSection(dialog) {
  let timer = 0;

  /** 把当前这块（可能是刚重画出来的新节点）接上线。 */
  function wire() {
    const box = dialog.querySelector('.settings__assets');
    if (!box) return;

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
      paintProgress(st);
      // 把真实落地路径写出来（App 私有目录），让人一眼看到它不在相册里。
      const pathEl = box.querySelector('[data-asset-path]');
      if (pathEl) {
        try {
          const info = JSON.parse(window.AndroidShell.storageInfo() || '{}');
          if (info.path) pathEl.textContent = info.path;
        } catch {
          /* 桌面 / 浏览器里没有 AndroidShell，保留默认文案 */
        }
      }
    };

    // 每次重画都会得到新节点，监听器要重新挂 —— 所以这里用一次性绑定 + 递归重接线
    btn?.addEventListener('click', () => {
      let reply;
      try {
        reply = shell().extractAssets();
      } catch (error) {
        reply = `调用失败：${error.message}`;
      }
      if (status) status.textContent = reply || '已开始提取';
      refresh();
    });

    box.querySelector('[data-asset-help]')?.addEventListener('click', () => {
      try {
        shell().showShizukuHelp();
      } catch { /* 没有壳就什么都不做 */ }
    });

    // 申请超级用户权限：引一次 su 授权框，结果直接 toast，然后刷新状态。
    box.addEventListener('click', (e) => {
      const r = e.target.closest('[data-asset-root]');
      if (!r || r.disabled) return;
      let reply = '';
      try {
        reply = shell().requestRootPermission ? shell().requestRootPermission() : '当前版本不支持申请 root';
      } catch (error) {
        reply = `申请失败：${error.message}`;
      }
      if (status) status.textContent = reply;
      refresh();
    });

    // 提权通道切换：写进壳 → 重画整块 → 重新接线（否则第二次点就没反应）
    box.addEventListener('click', (e) => {
      const c = e.target.closest('[data-channel]');
      if (!c || c.disabled) return;
      const want = c.dataset.channel;
      try {
        shell().selectExtractChannel ? shell().selectExtractChannel(want) : shell().selectArkChannel?.(want);
      } catch (error) {
        if (status) status.textContent = `切换失败：${error.message}`;
        return;
      }
      redraw(box);
      if (status) status.textContent = want === 'root' ? '已切到 ROOT 通道' : '已切到 Shizuku 通道';
    });

    // 包体切换：写进壳 → 重画整块 → 重新接线（否则第二次点就没反应）
    box.addEventListener('click', (e) => {
      const f = e.target.closest('[data-flavor]');
      if (!f || f.disabled) return;
      try {
        shell().selectArkFlavor(f.dataset.flavor);
      } catch (error) {
        if (status) status.textContent = `切换失败：${error.message}`;
        return;
      }
      redraw(box);
      if (ctlAgain()) ctlAgain().textContent = `已切换到 ${f.querySelector('b')?.textContent || f.dataset.flavor}`;
    });

    refresh();
  }

  /**
   * 整块重画并重新接线。
   *
   * 通道 / 包体一改，徽章、文案、按钮集合全都要换（例如切到 root 会多出
   * 「申请超级用户权限」按钮），逐字段打补丁比重画更容易漏，索性整块替换。
   * 代价是监听器必须重新挂 —— 所以这里一定跟着 wire()。
   */
  function redraw(box) {
    const host = box.parentElement;
    if (!host) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = assetSectionHtml(readAssetState());
    const fresh = tmp.querySelector('.settings__assets');
    if (!fresh) return;
    box.replaceWith(fresh);
    wire();
  }

  function ctlAgain() { return dialog.querySelector('[role="status"]'); }

  wire();

  // 提取是后台线程跑的，每秒问一次；对话框关掉就停。
  timer = setInterval(() => {
    if (!dialog.isConnected || !dialog.open) {
      clearInterval(timer);
      return;
    }
    const box = dialog.querySelector('.settings__assets');
    if (!box) { clearInterval(timer); return; }
    // 只刷数字，不重画（刷新走的是节点上的函数，这里直接读一次状态写进去）
    const st = readAssetState();
    const stateEl = box.querySelector('[data-asset-state]');
    const sizeEl = box.querySelector('[data-asset-size]');
    const btn = box.querySelector('[data-asset-extract]');
    if (stateEl) stateEl.textContent = statusLine(st);
    if (sizeEl) sizeEl.textContent = fmtBytes(st.bytes);
    if (btn) {
      btn.disabled = st.running;
      btn.textContent = st.running ? '正在提取…' : (st.ready ? '重新提取' : '开始提取');
    }
    paintProgress(st);
  }, 700);

  return () => clearInterval(timer);
}

/* ---- 壳里的提示 / 授权教程：由网页画，不用原生弹窗 ---------------------------------------------
   原生 AlertDialog 套的是 Theme.Black.NoTitleBar.Fullscreen，在 Android 12+ 上会退化成
   老式方框，观感像安卓 2.3，跟整体终端风完全不搭。所以壳把这两件事交给网页：
     window.__arksimToast(text)        一条终端风提示
     window.__arksimShowShizukuHelp()  Shizuku 授权教程弹层
   ---- */

function overlay(html) {
  const mask = document.createElement('div');
  mask.className = 'arksim-overlay';
  mask.innerHTML = `<div class="arksim-overlay__box">${html}</div>`;
  document.body.append(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-arksim-close]')) close();
  });
  return close;
}

export function showToast(text) {
  if (!text) return;
  const t = document.createElement('div');
  t.className = 'arksim-toast';
  t.textContent = String(text);
  document.body.append(t);
  setTimeout(() => { t.classList.add('is-out'); }, 2600);
  setTimeout(() => t.remove(), 3200);
}

export function showShizukuHelp() {
  const st = readAssetState();
  const flavor = (st.flavors || []).find((f) => f.id === st.currentFlavor);
  const path = flavor?.path || '/storage/emulated/0/Android/data/com.hypergryph.arknights/files/Bundles';
  const isRoot = st.channel === 'root';
  const head = isRoot ? 'ROOT / HOW TO' : 'SHIZUKU / HOW TO';
  const title = isRoot ? '读取方舟资源 · 需要超级用户权限' : '读取方舟资源 · 需要 Shizuku 授权';
  const why = isRoot
    ? '普通应用（包括本应用，即使拿到「所有文件访问权限」）都进不去，只有 root 能读。'
      + '所以走 <b>su</b> 拿 uid 0 —— 全程<b>只读</b>，不改动方舟任何文件，提取出来的东西只写在本应用自己的目录里。'
    : '普通应用（包括本应用，即使拿到「所有文件访问权限」）都进不去，只有 shell 身份能读。'
      + '所以借 Shizuku 拿一个 shell 身份 —— 全程<b>只读</b>，不改动方舟任何文件，提取出来的东西只写在本应用自己的目录里。';
  const steps = isRoot
    ? `<li>确认手机已经 root（Magisk / KernelSU / APatch 等任一方案），并且 root 管理器在正常工作。</li>
       <li>在设置里把提权通道切到「ROOT（超级用户）」。</li>
       <li>点「申请超级用户权限」，root 管理器会弹框，选<b>允许</b>（有些方案默认记住授权，之后不再弹）。</li>
       <li>回到「开始提取」，等进度走完。</li>`
    : `<li>安装并打开 <a href="https://shizuku.rikka.app/" target="_blank" rel="noopener">Shizuku</a>
          （开源免费，无需 root）。</li>
       <li>按 Shizuku 里的提示启动它的服务：用「无线调试」配对启动即可。</li>
       <li>回到本应用，点「开始提取」。应用内会弹 Shizuku 的授权框，选<b>允许</b>。</li>
       <li>授权通过后再点一次「开始提取」，等进度走完。</li>`;
  const notes = isRoot
    ? `<li>root 授权被拒之后，要去 root 管理器的「超级用户」列表里把本应用改成允许。</li>
       <li>部分系统（尤其带开机校验的 ROM）重启后 su 需要重新授权一次。</li>
       <li>没 root 的手机请切回 Shizuku 通道，两条通道读出来的内容完全一样。</li>
       <li>资源读不到时，先确认游戏里已经把「完整资源包」下载完。</li>`
    : `<li>Shizuku 服务重启后，本应用需要重新授权一次。</li>
       <li>手机重启后，Shizuku 需要重新启动一次。</li>
       <li>如果之前拒绝过授权，系统不会再弹框 —— 要回 Shizuku App 里手动改。</li>
       <li>资源读不到时，先确认游戏里已经把「完整资源包」下载完。</li>`;
  overlay(`
    <header class="arksim-overlay__head">
      <span class="menu__eyebrow">${head}</span>
      <button type="button" class="arksim-overlay__close" data-arksim-close aria-label="关闭">×</button>
    </header>
    <h2>${title}</h2>
    <p class="arksim-overlay__lead">要读的是这个目录：</p>
    <code class="arksim-overlay__path">${escapeHtml(path)}</code>
    <p>它属于《明日方舟》自己，${why}</p>
    <h3>步骤</h3>
    <ol class="arksim-overlay__steps">${steps}</ol>
    <h3>几个要留意的点</h3>
    <ul class="arksim-overlay__list">${notes}</ul>
    <p class="arksim-overlay__note">没走通也不影响玩：只是官方美术换成替代素材，玩法与数值完全不受影响。</p>
    <div class="arksim-overlay__foot">
      <button type="button" class="arksim-overlay__btn" data-arksim-close>知道了</button>
    </div>
  `);
}

// 壳里会按这两个名字调。
// 注意：asset-pack.js 只在「设置对话框」里被 import，页面首次加载时可能还没执行到，
// 所以 __arksimToast 的兜底版在页面里先挂了一份（见各 studio 页面的内联脚本），
// 这里再覆盖成带样式的真实现。__arksimShowShizukuHelp 则只在这里提供 ——
// 壳调它的时候用户一定在设置页，模块已经加载过了。
if (typeof globalThis !== 'undefined') {
  globalThis.__arksimToast = (t) => showToast(t);
  globalThis.__arksimShowShizukuHelp = () => showShizukuHelp();
}
