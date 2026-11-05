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
      { text: '主菜单有四块：自由沙盒、游玩自制关卡、关卡制作器、干员详情。先推荐从「自由沙盒」开始。' },
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
    title: '04 干员详情',
    intro: '这一页每位干员都能看能改：左列选人，右侧是他的完整档案。改的是「覆盖表」，<b>官方原表一个字节都不动</b>，随时可以还原。',
    items: [
      { text: '左侧列表带<b>头像</b>和<b>子职业图标</b>，一眼能认出是谁；上面可以按名字搜、按职业 / 子职业 / 星级 / 有没有模组筛，也可以只看改过的。' },
      { text: '右侧抬头是<b>立绘 + 关键数值</b>（费用 / 生命 / 攻击 / 防御 / 阻挡），下面是五块内容，每块右上角都能<b>只还原这一块</b>。' },
      { text: '⓪ <b>携带与潜能</b>：选潜能 1～6 档、换携带的技能、换装哪个模组、换立绘或皮肤。', list: [
        '潜能不能统一按百分比算 —— 每个干员的潜能给的东西都不一样（有的降部署费用、有的降再部署、有的加攻击）。这里用的是官方每人的差异表，选完下面会实时显示折算后的数值。',
        '换技能、换模组、换立绘都是<b>真的会生效</b>：沙盒手牌、战斗中的技能都跟着变。',
        '立绘 / 皮肤：默认只有精一 / 精二两张，其余要走 skinpack 现场解包（点「解这个干员的皮肤」，1～2 秒）。',
      ] },
      { text: '① <b>基础数值</b>：生命上限、攻击、防御、法抗、部署费用、阻挡数、攻击间隔、攻速、再部署、技力回复、每秒回血、移动速度、嘲讽等级、重量等级。', list: [
        '每个输入框下面写着<b>原值</b>，改过之后会立刻显示<b>改后生效值</b>，不用自己心算。',
      ] },
      { text: '② <b>职业特性</b> 与 ③ <b>天赋</b>：比如「攻击时额外回复几点技力」「攻击力提升多少」这类数字都能改。' },
      { text: '④ <b>模组</b>：模组等级、模组自带的属性加成、模组替换掉的职业特性，以及模组「追加 / 加强的天赋」。', list: ['每个干员可能有 0～2 个模组，不同职业的模组不一样', '没装模组的干员，属性回到无模组基础值'] },
      { text: '改完点「保存改动」。想撤销：「还原这位干员的全部」，或者页顶「还原改动」里按类别只还原某一类（只潜能 / 只数值 / 只天赋…）。' },
      { text: '改过的干员进沙盒 / 作战时会在顶部挂一条提示，说明当前用的是改后数值。这条提示可以在设置里关掉。' },
      { text: '＋ <b>新建自定义干员</b>（实验功能）：能设名字、职业、<b>子职业</b>、星级、技能，攻击范围可以「沿用子职业默认」、选模板，或者自己在一个 7×5 格子上画。' },
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
      { text: '游戏更新后：本应用会重新读一次方舟的数据表，<b>新出的干员会自动出现在列表里</b>；打开应用时如果发现方舟资源版本变了，也会提示你重新提取。' },
      { text: '提取时有<b>进度条和预计剩余时间</b>，按阶段显示（棋盘贴图 → 干员名单 → 立绘 → 写盘），不用干等。' },
    ],
  },
  {
    id: 'skin',
    title: '06 皮肤与 2D 小人',
    intro: '干员的 2D 战斗小人是 Spine 骨骼动画，每个干员的 bundle 里带着好几套皮肤（默认、epoque、winter、联动等）。',
    items: [
      { text: '皮肤不会在「读取资源」时全量解（全量要十几分钟、一百多 MB），而是<b>按需解</b>：在「干员详情 → 立绘 / 皮肤」里点「解这个干员的皮肤」，一两秒就出来。' },
      { text: '解出来的皮肤会进下拉框，选中后手牌头像、战斗前详情里的立绘都会换成那一套。' },
      { text: '切换只影响显示，不影响数值与技能判定。' },
      { text: '新干员（比如刚出的那几位）本机 skinpack 里暂时没有皮肤，下拉就只会有精一 / 精二两张。' },
    ],
  },
  {
    id: 'mobile',
    title: '07 手机操作',
    intro: '本版是给手机 / 平板做的，界面会自己避开挖孔与手势条，没有黑边。',
    items: [
      { text: '布局：手机横屏、手机竖屏、平板、大屏各有一套尺寸，切换方向会自动重排。', list: ['手机上控件尺寸用像素而不是 rem，字不会缩到看不见', '横屏时主页三张卡并排，竖屏时单列'] },
      { text: '手势：两指缩放 / 平移战场；沙盒与编辑器都支持。单指仍然只做选择与放置。' },
      { text: '存档位在手机上排成两列，滑一下就到底。' },
      { text: '面板打开、页面切换都有短促的淡入过渡；系统开了「减少动态效果」时会整体关掉。' },
      { text: '「加入手牌」里职业筛选是<b>一横排可左右滑</b>的按钮，牌库格子按屏幕宽度自动排，头像和名字都看得清。' },
    ],
  },
  {
    id: 'faq',
    title: '08 常见问题',
    items: [
      { text: '问：打不开 / 黑屏？', list: ['确认装的是最新一版；进不去时屏幕会直接显示原因（比如本地服务没起来）', '实在不行把应用数据清掉重进一次'] },
      { text: '问：资源读不出来？', list: ['先确认 Shizuku 服务在跑、并且授权了本应用', '确认《明日方舟》已安装且资源已下载完（游戏里要下完整资源包）'] },
      { text: '问：改了数值没生效？', list: ['回主菜单再进一次沙盒（数值在进页面时读取）', '确认改的是同一个干员 id（同名不同形态是两个条目）', '确认点过「保存改动」，只填数字不保存是不生效的'] },
      { text: '问：换了技能 / 模组 / 立绘没变化？', list: ['同样要先点「保存改动」', '换的是「这位干员身上带的」，沙盒里要重新加一次手牌才会读到新的携带'] },
      { text: '问：干员头像或技能图标是灰的？', list: ['没有提取过方舟资源，或这位干员的图在本地资源里没有', '去设置里重新提取一次资源'] },
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
