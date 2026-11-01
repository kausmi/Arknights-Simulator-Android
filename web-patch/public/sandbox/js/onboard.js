// public/sandbox/js/ui/onboard.js — 首次进入的引导。
//
// 只做一件事：第一次打开主菜单时，用几屏卡片把「这是什么、怎么开始、哪里改数值、
// 哪里看完整教程」讲清楚，然后记一个标记不再出现。
//
// 为什么放在网页而不是壳里：网页知道用户当前在哪个页面、要跳哪去；壳只管窗口。
// 标记放 localStorage（清网站数据会重新出现一次，可接受）。

const SEEN_KEY = 'arksim-onboarding-seen-v1';

/** 引导的几屏。每屏 { eyebrow, title, body, list?, action? } */
const STEPS = [
  {
    eyebrow: 'STEP 01 / WELCOME',
    title: '这是《明日方舟》的非官方单机沙盒',
    body: '自由摆放干员、刷敌人、画地形，测技能与伤害；也能自己做关卡、改干员数值。全部在本机跑，不联网。',
    list: [
      '四个入口：自由沙盒 · 游玩自制关卡 · 关卡制作器 · 干员数值调整',
      '首次启动需要先解开本机资源，之后秒开',
    ],
  },
  {
    eyebrow: 'STEP 02 / SANDBOX',
    title: '从自由沙盒开始最快',
    body: '点「＋ 新建空白沙盒」就有一张 8 × 17 的空战场。点手牌放干员，左侧按钮刷敌人与地形。',
    list: [
      '本地存档 10 个槽位，每个都能自己改名字',
      '手机上两指张合可缩放镜头，两指拖动可平移',
    ],
  },
  {
    eyebrow: 'STEP 03 / TUNING',
    title: '数值、模组、特性都能改',
    body: '「干员数值调整」里可以改生命、攻击、防御、费用等，也能改模组等级与模组追加的天赋、职业特性。',
    list: [
      '改的是覆盖表，官方数据不动，随时一键还原',
      '改过的干员进沙盒会在顶部挂一条提示（可在设置里关掉）',
    ],
  },
  {
    eyebrow: 'STEP 04 / ASSETS',
    title: '官方美术要从你手机上的方舟读',
    body: '棋盘贴图、立绘、敌人模型这些素材在方舟自己的目录里，需要 Shizuku 借 shell 身份直读，全程只读不改。',
    list: [
      '不顺也没关系：只是换成替代素材，玩法完全不受影响',
      '读不到时游戏照样能玩',
    ],
  },
  {
    eyebrow: 'STEP 05 / MANUAL',
    title: '余下的细节都在「教程与帮助」里',
    body: '关卡怎么做、皮肤怎么切、常见问题怎么排，都在同一页。设置里随时能打开。',
    action: '打开教程与帮助',
  },
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 是否该显示引导。 */
export function shouldOnboard() {
  try {
    return globalThis.localStorage?.getItem(SEEN_KEY) !== 'seen';
  } catch {
    return false;      // 存储不可用就别弹了，免得每次烦人
  }
}

export function markOnboardSeen() {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, 'seen');
  } catch { /* 忽略 */ }
}

/**
 * 弹出引导。
 * @param {{ onDone?: () => void }} [opts]
 */
export function showOnboarding({ onDone } = {}) {
  const mask = document.createElement('div');
  mask.className = 'onboard';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-labelledby', 'onboard-title');

  let index = 0;

  const render = () => {
    const step = STEPS[index];
    const last = index === STEPS.length - 1;
    mask.innerHTML = `
      <div class="onboard__box">
        <header class="onboard__head">
          <span class="onboard__eyebrow">${esc(step.eyebrow)}</span>
          <span class="onboard__dots">${STEPS.map((_, i) => `<i class="${i === index ? 'is-on' : ''}"></i>`).join('')}</span>
        </header>
        <h2 id="onboard-title">${esc(step.title)}</h2>
        <p class="onboard__body">${esc(step.body)}</p>
        ${step.list ? `<ul class="onboard__list">${step.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <div class="onboard__actions">
          <button type="button" class="onboard__skip" data-onboard="skip">跳过</button>
          <span class="onboard__step">${index + 1} / ${STEPS.length}</span>
          ${last
            ? `<button type="button" class="onboard__next is-primary" data-onboard="help">${esc(step.action || '打开教程')}</button>`
            : '<button type="button" class="onboard__next is-primary" data-onboard="next">下一步 →</button>'}
        </div>
        ${last ? '<button type="button" class="onboard__done" data-onboard="finish">直接开始用 →</button>' : ''}
      </div>`;
  };

  const close = () => {
    markOnboardSeen();
    mask.remove();
    onDone?.();
  };

  mask.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-onboard]');
    if (!btn) {
      if (e.target === mask) close();
      return;
    }
    const act = btn.dataset.onboard;
    if (act === 'skip' || act === 'finish') { close(); return; }
    if (act === 'next') { index = Math.min(STEPS.length - 1, index + 1); render(); return; }
    if (act === 'help') { close(); location.href = '/studio/help.html'; }
  });

  // Esc 也算跳过，别让引导卡住人
  mask.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  render();
  document.body.append(mask);
  mask.querySelector('.onboard__next')?.focus?.();
  return mask;
}
