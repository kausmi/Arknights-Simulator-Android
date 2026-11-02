// public/sandbox/js/ui/asset-hint.js — 「该更新方舟资源了」的提醒条。
//
// 两种时候要提醒：
//   1. 首次进入（从没提取过）—— 不提醒的话用户会以为游戏本来就这么灰
//   2. 方舟热更之后（资源目录指纹变了）—— 新干员的立绘 / 新地图贴图得重新解才看得到
//
// 判据全在壳里算（`AndroidShell.assetUpdateHint()`）：它知道 Shizuku 通道通不通、
// 上次提取记下的指纹是多少、当前方舟目录的指纹是多少。网页只负责画与点。
//
// 「稍后再说」不是关掉提醒，而是记住「这一次的指纹」，同一个游戏版本不再烦人；
// 下一次方舟更新，指纹一变又会提醒 —— 这正是「资源版本更新后提醒」想要的效果。

const shell = () => globalThis.AndroidShell;

function hasShell() {
  const s = shell();
  return !!(s && typeof s.assetUpdateHint === 'function');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readHint() {
  if (!hasShell()) return null;
  try {
    const h = JSON.parse(shell().assetUpdateHint() || '{}');
    if (!h || !h.need || h.snoozed) return null;
    return {
      reason: String(h.reason || ''),
      ready: !!h.ready,
      bytes: Number(h.bytes) || 0,
    };
  } catch {
    return null;
  }
}

const COPY = {
  first: {
    eyebrow: 'LOCAL ASSETS / 首次',
    title: '还没解开手机上的方舟资源',
    body: '棋盘贴图、干员立绘、敌人模型这些官方美术在《明日方舟》自己的目录里，'
      + '要借 Shizuku 用 shell 身份直读一次。全程只读，不改动游戏文件，解出来的图只存在本应用的私有目录。',
    primary: '现在就去解',
  },
  updated: {
    eyebrow: 'LOCAL ASSETS / 版本变化',
    title: '《明日方舟》更新了，本地美术可能过期',
    body: '检测到方舟的资源包变了 —— 新干员的立绘、新地图的贴图都得重新解一次才会出现。'
      + '不更新也能玩，只是新内容会显示成替代素材。',
    primary: '重新解一次',
  },
};

/**
 * 检查并在需要时弹出提醒条。
 *
 * @param {{ delay?: number, onGo?: () => void }} [opts]
 * @returns {HTMLElement|null} 弹出的节点（没弹就 null）
 */
export function maybeShowAssetHint({ delay = 2600, onGo } = {}) {
  const info = readHint();
  if (!info) return null;
  const copy = COPY[info.reason] || COPY.first;

  const mask = document.createElement('div');
  mask.className = 'arksim-overlay asset-hint';
  mask.innerHTML = `<div class="arksim-overlay__box asset-hint__box">
    <p class="asset-hint__eyebrow">${esc(copy.eyebrow)}</p>
    <h2 class="asset-hint__title">${esc(copy.title)}</h2>
    <p class="asset-hint__body">${esc(copy.body)}</p>
    <div class="asset-hint__actions">
      <button type="button" class="menu__button menu__button--primary" data-hint="go">${esc(copy.primary)}</button>
      <button type="button" class="menu__button" data-hint="later">稍后再说</button>
    </div>
    <p class="asset-hint__note">「稍后再说」只对这一次生效，方舟下次更新还会再提醒。</p>
  </div>`;

  const close = () => mask.remove();

  mask.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-hint]');
    if (!btn) {
      if (e.target === mask) close();
      return;
    }
    if (btn.dataset.hint === 'later') {
      try {
        if (typeof shell().suppressAssetHint === 'function') shell().suppressAssetHint();
      } catch { /* 记不住也没什么，下次再弹一次而已 */ }
      close();
      return;
    }
    // 「现在就去解」：直接起提取（壳会弹 Shizuku 授权框），然后把人送到设置页看进度
    let reply = '';
    try {
      reply = shell().extractAssets();
    } catch (error) {
      reply = `调用失败：${error.message}`;
    }
    close();
    if (typeof window.__arksimToast === 'function') {
      window.__arksimToast(reply || '已开始提取，进度在「设置 → 方舟本地资源」里看');
    }
    onGo?.();
  });

  mask.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  document.body.append(mask);
  // 首次进入时引导层也在弹，两层叠一起很吵 —— 等引导关掉再露头
  if (document.querySelector('.onboard')) {
    const wait = setInterval(() => {
      if (!document.querySelector('.onboard')) {
        clearInterval(wait);
        if (!mask.isConnected) document.body.append(mask);
      }
    }, 400);
    // 引导看很久也不会无限等，30 秒后直接上
    setTimeout(() => {
      clearInterval(wait);
      if (!mask.isConnected) document.body.append(mask);
    }, 30000);
  }

  return mask;
}

/** 带延时启动（主页入场动画跑完再弹，别盖住动画）。 */
export function scheduleAssetHint(opts = {}) {
  const delay = Number(opts.delay) || 2600;
  if (!hasShell()) return null;
  return setTimeout(() => maybeShowAssetHint(opts), delay);
}
