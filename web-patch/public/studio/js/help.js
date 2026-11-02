// public/studio/js/help.js — 教程与帮助（/studio/help.html）
//
// 内容集中在一个数组里，页面与「首次进入引导」共用同一份文案，
// 避免两处写成不一样的话。每条都是 { id, title, items[] }，items 里
// 是 { text } 或 { text, list[] } 这种小结构。

export const HELP_SECTIONS = [
  {
    id: 'first',
    title: '01 首次上手',
    intro: '第一次打开时，主菜单会让你先走一遍下面这几步。之后可以随时在「全局设置 → 教程与帮助」回到本页。',
    items: [
      { text: '主菜单有四块：自由沙盒、游玩自制关卡、关卡制作器、干员数值调整。先推荐从「自由沙盒」开始。' },
      { text: '自由沙盒里点「＋ 新建空白沙盒」就有一张 8 × 17 的空战场，随便放干员、刷敌人试技能。' },
      { text: '本地存档默认有 <b>10 个槽位</b>，在存档管理里都能自己改名字（最多 40 字）。' },
      { text: '想省点力气：规格随时可以在右上角「⚙ 全局设置」里改，包括战斗界面的屏幕方向。' },
    ],
  },
  {
    id: 'sandbox',
    title: '02 自由沙盒',
    intro: '一张战场、一组手牌，什么都不限制：不耗费用也能强行开技能，重复放同一个干员也不会被拦。',
    items: [
      { text: '放手牌上的干员：先点手牌，再点格子，最后拖动或点选朝向。', list: ['拖动时格子会高亮合法位置', '「加入手牌」里的牌库可以按职业筛选、按名字搜索', '点卡片右上角的 × 把干员移出手牌'] },
      { text: '敌人与地形：左侧竖排的「敌人」「地形」按钮进入对应编辑状态。', list: ['敌人可以指定出生点、路线与数量', '地形刷子支持笔刷大小与地形类型切换'] },
      { text: '存档：右上「管理存档」、还有「快存」。快存会写进当前绑定的槽位，没绑定就用第一个空槽。' },
      { text: '手机上的手势：<b>两指张合</b>可以缩放镜头，<b>两指拖动</b>可以平移。单指仍然只做选择与放置。' },
    ],
  },
  {
    id: 'level',
    title: '03 关卡制作',
    intro: '做一张能保存、能分享、能直接试玩的关卡。关卡以 JSON 存在本机 content/levels，不进应用缓存。',
    items: [
      { text: '先画地形，再摆敌人路线与出生时间，最后试玩。中间随时可以保存。' },
      { text: '保存时文件名可以不重复：同名但 `id` 不同的关卡会被拒绝，避免覆盖别人的作品。' },
      { text: '做好的关卡可以直接在「游玩自制关卡」里选到，也可以导出 JSON 分享。' },
    ],
  },
  {
    id: 'operators',
    title: '04 干员数值',
    intro: '改的是「覆盖表」，<b>官方原表一个字节都不动</b>。想还原随时按「还原这位干员」或「全部还原」。',
    items: [
      { text: '可以改的项：生命上限、攻击、防御、法抗、部署费用、阻挡数、攻击间隔、攻速、再部署、技力回复、每秒回血、移动速度、嘲讽等级、重量等级。' },
      { text: '还能改 <b>模组</b>：模组等级、模组自带的属性加成，以及模组替换掉的职业特性。', list: ['每个干员可能有 0～2 个模组，不同职业的模组不一样', '模组里「追加/加强的天赋」也能单独改'] },
      { text: '还能改 <b>职业特性</b> 与 <b>天赋数值</b>：比如「攻击时额外回复几点技力」这类数字。' },
      { text: '筛选：可以按职业、星级、是否有模组、是否已改过过滤，找起来快很多。' },
      { text: '改过的干员进沙盒 / 作战时会弹一条提示，说明当前用的是改后数值。这条提示可以在设置里关掉。' },
    ],
  },
  {
    id: 'assets',
    title: '05 读取方舟资源',
    intro: '棋盘贴图、干员立绘、敌人模型这些官方美术，只能从你手机上的《明日方舟》里读，读的时候需要 Shizuku。',
    items: [
      { text: '为什么：方舟的素材放在它自己的目录里，别的应用（包括本应用、就算给了「所有文件访问权限」）都读不到，只有 shell 身份能进。' },
      { text: '怎么做：装 Shizuku → 按它提示启动服务（无线调试即可，不用 root）→ 回本应用点「开始提取」→ 弹授权框时选允许。', list: ['Shizuku 服务重启后需要重新授权', '手机重启后要重新启动 Shizuku', '全程只读，不改动方舟任何文件', '提取结果只写在本应用自己的目录里'] },
      { text: '没走通也能玩：只是官方美术改用替代素材，玩法与数值完全不受影响。' },
      { text: '游戏更新后：本应用会重新读一次方舟的数据表，<b>新出的干员会自动出现在列表里</b>。' },
    ],
  },
  {
    id: 'skin',
    title: '06 皮肤与 2D 小人',
    intro: '干员的 2D 战斗小人是 Spine 骨骼动画，每个干员的 bundle 里带着好几套皮肤（默认、epoque、winter、联动等）。',
    items: [
      { text: '读资源时会把小人与皮肤一起读出来，之后在干员详情里就能切换看见。' },
      { text: '切换只影响显示，不影响数值与技能判定。' },
    ],
  },
  {
    id: 'mobile',
    title: '07 手机操作',
    intro: '本版是给手机 / 平板做的，界面会自己避开挖孔与手势条，没有黑边。',
    items: [
      { text: '布局：横屏手机、竖屏手机、平板各有一套尺寸，切换方向会自动重排。' },
      { text: '手势：两指缩放 / 平移战场；沙盒与编辑器都支持。' },
      { text: '存档位在手机上排成两列，滑一下就到底。' },
    ],
  },
  {
    id: 'faq',
    title: '08 常见问题',
    items: [
      { text: '问：打不开 / 黑屏？', list: ['确认装的是最新一版；进不去时屏幕会直接显示原因（比如本地服务没起来）', '实在不行把应用数据清掉重进一次'] },
      { text: '问：资源读不出来？', list: ['先确认 Shizuku 服务在跑、并且授权了本应用', '确认《明日方舟》已安装且资源已下载完（游戏里要下完整资源包）'] },
      { text: '问：改了数值没生效？', list: ['回主菜单再进一次沙盒（数值在进页面时读取）', '确认改的是同一个干员 id（同名不同形态是两个条目）'] },
      { text: '问：存档会丢吗？', list: ['存档保存在应用里，清除应用数据会一起删掉', '重要的关卡建议导出 JSON 留一份'] },
    ],
  },
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 一条 item → HTML（text 里允许少量 <b>，其余转义）。 */
function itemHtml(item) {
  const text = String(item.text || '').replace(/<b>/g, '\u0001').replace(/<\/b>/g, '\u0002');
  const safe = esc(text).replace(/\u0001/g, '<b>').replace(/\u0002/g, '</b>');
  const list = Array.isArray(item.list) && item.list.length
    ? `<ul>${item.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '';
  return `<li>${safe}${list}</li>`;
}

export function renderHelp(mount) {
  const html = HELP_SECTIONS.map((sec) => `
    <article class="help__sec" id="${esc(sec.id)}">
      <h2>${esc(sec.title)}</h2>
      ${sec.intro ? `<p class="help__intro">${esc(sec.intro).replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')}</p>` : ''}
      <ul class="help__items">${sec.items.map(itemHtml).join('')}</ul>
    </article>`).join('');
  mount.innerHTML = html;
}

/** 页面初始化。 */
export function bootHelp() {
  const mount = document.getElementById('help-body');
  if (!mount) return;
  renderHelp(mount);

  // 目录点击：平滑滚到对应小节，并把高亮同步过去
  const toc = document.querySelector('.help__toc');
  toc?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-toc]');
    if (!a) return;
    e.preventDefault();
    const sec = document.getElementById(a.dataset.toc);
    if (!sec) return;
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    for (const el of toc.querySelectorAll('[data-toc]')) el.classList.toggle('is-on', el === a);
  });

  // 滚动时高亮当前小节
  const sections = [...mount.querySelectorAll('.help__sec')];
  if (sections.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const id = en.target.id;
        for (const el of toc?.querySelectorAll('[data-toc]') || []) {
          el.classList.toggle('is-on', el.dataset.toc === id);
        }
      }
    }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
    for (const s of sections) io.observe(s);
  }
}

bootHelp();
