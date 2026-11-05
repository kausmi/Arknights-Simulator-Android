import { esc, clamp01 } from './html.js';
import { iconStroke, rangeGridIcon } from './icons.js';
import { portrait, portraitFrame, skillIcon, professionIcon, rarityColor } from '../asset-urls.js';

/* ==========================================================================================
 * 点击干员 / 敌人弹出的详情面板。
 *
 * 版式参照 Stronghold-Protocol 的 ChessDetail（.ref/sp/public/js/ui/detailPanel.js）：
 *     head（立绘 + 星级 + 名字 + 英文名 + 职业/子职业/位置 + 血条）
 *   → stats（八格：生命上限 / 攻击 / 防御 / 法抗 / 攻击间隔 / 阻挡数 / 部署费用 / 再部署）
 *   → 攻击范围图
 *   → 分页正文（技能 / 特性 / 天赋 / 模组）
 *
 * 两条必须守住的东西（改了就会静默坏掉，而且不报错）：
 *   1. `.dt__basicbtns` 在渲染末尾会被搬进 `refs.selectionActions`（固定定位浮层），
 *      那里承载「技能 / 范围 / 撤退」三个贴地面的按键。结构一旦变形，按键整体消失。
 *   2. 每帧更新只改 `[data-k="…"]` 节点的数字，不重建 DOM。所以 data-k 名字是契约，
 *      改一个就要同步改下面 updateValues() 里的 q('…')。
 *
 * 单位约定：本项目 1rem 在手机横屏只有 33px，尺寸与字号一律用 px，不用 rem。
 * ========================================================================================== */

function fitPortrait(refs, charId) {
  refs._portraitObserver?.disconnect();
  const host = refs.detail.querySelector('.dt__portrait');
  const image = host?.querySelector('img');
  if (!host || !image) return;
  const frame = portraitFrame(charId);
  if (!frame) return;
  const fit = () => {
    const [left, top, width, height] = frame.bounds;
    const scale = Math.min(host.clientWidth / width, host.clientHeight / height);
    image.style.width = `${frame.width * scale}px`;
    image.style.height = `${frame.height * scale}px`;
    image.style.left = `${(host.clientWidth - width * scale) / 2 - left * scale}px`;
    image.style.top = `${-top * scale}px`;
  };
  host.classList.add('is-framed');
  refs._portraitObserver = new ResizeObserver(fit);
  refs._portraitObserver.observe(host);
  fit();
}

function description(text, plain = '') {
  const source = /\{[^}]+\}/.test(String(text || '')) ? plain : text || plain;
  let depth = 0;
  const result = String(source || '').split(/(<[@$][^>]+>|<\/>)/g).map((part) => {
    if (part === '</>') { if (!depth) return ''; depth--; return '</span>'; }
    if (/^<[@$]/.test(part)) {
      depth++;
      const kind = /ba\.rem|ba\.warning/.test(part) ? 'note' : /ba\.vup|ba\.kw|^<\$/.test(part) ? 'value' : 'effect';
      return `<span class="dt__text-${kind}">`;
    }
    return esc(part);
  }).join('');
  return result + '</span>'.repeat(depth);
}

/** 攻击范围图：格子 12px，自身格子上色。 */
function rangeDiagram(grid = []) {
  const cells = [[0, 0], ...grid].filter((p) => Array.isArray(p) && p.length >= 2);
  if (!cells.length) return '';
  const rows = cells.map((p) => p[0]), cols = cells.map((p) => p[1]);
  const r0 = Math.min(...rows), r1 = Math.max(...rows), c0 = Math.min(...cols), c1 = Math.max(...cols);
  const size = 12;
  const tiles = grid.map(([r, c]) => `<rect x="${(c - c0) * size + 1}" y="${(r1 - r) * size + 1}" width="10" height="10" fill="currentColor"/>`).join('');
  return `<svg viewBox="0 0 ${(c1 - c0 + 1) * size} ${(r1 - r0 + 1) * size}" aria-hidden="true">${tiles}<rect x="${-c0 * size + 1}" y="${r1 * size + 1}" width="10" height="10" fill="#e5912a" stroke="#ffd58b" stroke-width="1"/></svg>`;
}

/* ---- 分页 ------------------------------------------------------------------------------- */

const detailTabOf = new Map();
const TABS = [
  ['skill', '技能'],
  ['trait', '特性'],
  ['talent', '天赋'],
  ['module', '模组'],
];

function tabsOf(u) {
  // 模组页只在真有模组数据时出现（绝大多数敌人/召唤物没有）
  return TABS.filter(([id]) => id !== 'module' || (Array.isArray(u.modules) && u.modules.length));
}

function detailTab(u) {
  const key = String(u.uid ?? '');
  const t = detailTabOf.get(key);
  const avail = tabsOf(u).map(([id]) => id);
  if (t && avail.includes(t)) return t;
  // 没手动切过：有技能就给技能页，否则给特性页（防止技能页全空）
  return (u.skillInfo || u.skill) && avail.includes('skill') ? 'skill' : 'trait';
}
export function setDetailTab(uid, tab) {
  detailTabOf.set(String(uid), tab);
}

/* ---- 各分页正文 ------------------------------------------------------------------------- */

const RECOVERY_CN = {
  INCREASE_WITH_TIME: '自动回复', time: '自动回复',
  INCREASE_WHEN_ATTACK: '攻击回复', attack: '攻击回复',
  INCREASE_WHEN_TAKEN_DAMAGE: '受击回复', hurt: '受击回复', hit: '受击回复',
};

function skillBlock(u, skillInfo) {
  if (!skillInfo) return `<p class="dt__seg-p dt__seg-p--empty">—</p>`;
  const sk = u.skill;
  const meta = [];
  const recovery = RECOVERY_CN[sk?.spType || skillInfo.spType];
  if (skillInfo.passive) meta.push('<i class="dt__meta--trigger">被动</i>');
  else {
    if (recovery) meta.push(`<i class="dt__meta--recovery">${recovery}</i>`);
    meta.push(`<i class="dt__meta--trigger">${(sk?.auto ?? skillInfo.auto) ? '自动触发' : '手动触发'}</i>`);
  }
  const duration = skillInfo.duration;
  if (Number.isFinite(duration) && duration > 0) meta.push(`<i class="dt__meta--duration">◷ ${duration}秒</i>`);
  else if (duration < 0 || duration === Infinity) meta.push('<i class="dt__meta--duration">持续时间无限</i>');
  const skId = skillInfo.skillId || sk?.skillId;
  const skImg = skillIcon(skId);
  return `<div class="dt__seg dt__skill-info">
    ${skImg ? `<img class="dt__description-icon" src="${esc(skImg)}" alt="" />` : ''}
    <div class="dt__skill-copy">
    <div class="dt__seg-h"><b>${esc(skillInfo.name || '—')}</b></div>
    <div class="dt__seg-meta">${meta.join('')}</div>
    <p class="dt__seg-p">${description(skillInfo.richDesc, skillInfo.desc)}</p>
    </div>
  </div>`;
}

function talentList(u, talents) {
  if (!talents.length) return `<p class="dt__seg-p dt__seg-p--empty">—</p>`;
  return talents.map((t) => `<div class="dt__seg">
      <div class="dt__seg-h"><b>${esc(t.name)}</b><i class="dt__seg-k">${['第一天赋', '第二天赋', '第三天赋'][t.index] || `天赋 ${t.index + 1}`}</i></div>
      <p class="dt__seg-p">${description(t.richDesc, t.desc)}</p>
    </div>`).join('');
}

/**
 * 是不是特限模组（特限证章）。
 *
 * 判据两头取或：① 数据里从官方 uniequip_table 抄来的 `isSpecial`；② 类型前缀落在 ISW / RA / SO 三族
 * （官方 equipTypeInfos 里 A、B 两个 typeName2 的 isSpecial = true，1~3 级证章都挂在这三族下）。
 *
 * 为什么不在 sandbox 里 import studio/js/tables.js：这两个目录是两套独立的前端，
 * 沙盒页不该为了一个三行判断去拉整个中文对照表。studio 侧同名的 isSpecialModule 与本函数结果一致。
 */
function isSpecialModule(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.isSpecial === true) return true;
  const pre = /^([A-Z]{2,4})/.exec(String(m.typeName || ''));
  return !!pre && ['ISW', 'RA', 'SO'].includes(pre[1]);
}

/** 模组块：属性加成 + 特性更新 + 天赋更新，携带中的那个高亮。 */
function moduleBlock(m, current) {
  const on = current && m.uniEquipId && current.id === m.uniEquipId;
  const attrs = Object.entries(m.attr || {})
    .filter(([, v]) => Number.isFinite(Number(v)) && Number(v) !== 0)
    .map(([k, v]) => {
      const cn = { maxHp: '生命上限', atk: '攻击力', def: '防御力', res: '法术抗性', aspd: '攻击速度', blockCnt: '阻挡数' }[k] || k;
      return `${cn} ${Number(v) > 0 ? '+' : ''}${v}`;
    });
  const talentBits = (m.talentChanges || []).map((t) => `<div class="dt__mod-talent">
      <b>${esc(t.name || '')}</b>
      <p class="dt__seg-p">${description(t.descRaw || t.desc, t.desc)}</p>
    </div>`).join('');
  const traitDesc = m.traitOverride?.moduleDescRaw || m.traitOverride?.moduleDesc || '';
  const special = isSpecialModule(m);
  return `<div class="dt__mod${on ? ' is-on' : ''}${special ? ' is-special' : ''}">
    <div class="dt__mod-head">
      <span class="dt__mod-type">${esc(m.typeName || '')}</span>
      <b class="dt__mod-name">${esc(m.name || '')}</b>
      <span class="dt__mod-lv">${m.level ? `Lv${esc(m.level)}` : ''}</span>
      ${special ? `<i class="dt__mod-special" title="${esc(m.specialDesc || '适配限定模式')}">特限</i>` : ''}
      ${on ? '<i class="dt__mod-on">携带中</i>' : ''}
      ${m.isDefault ? '<i class="dt__mod-def">默认</i>' : ''}
    </div>
    ${attrs.length ? `<div class="dt__mod-attrs">${attrs.map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
    ${traitDesc ? `<div class="dt__mod-sub">特性追加${special ? '（本模拟器不限模式，全天候生效）' : ''}</div>`
      + `<p class="dt__seg-p">${description(m.traitOverride?.moduleDescRaw || traitDesc, traitDesc)}</p>` : ''}
    ${talentBits ? `<div class="dt__mod-sub">天赋更新</div>${talentBits}` : ''}
  </div>`;
}

function modulePage(u) {
  const modules = Array.isArray(u.modules) ? u.modules : [];
  if (!modules.length) return `<p class="dt__seg-p dt__seg-p--empty">—</p>`;
  const current = u.module || null;
  return modules.map((m) => moduleBlock(m, current)).join('');
}

function detailTabBody(u, tab, talents, skillInfo, traitDesc) {
  if (tab === 'trait') {
    // 正常情况下一定拿得到（unitVM/handVM 都会从棋子记录里取 trait）。
    // 真拿不到时不要写「没有特性说明」这种话 —— 那是我们取值失败，不是干员没有特性。
    return `<p class="dt__seg-p${traitDesc ? '' : ' dt__seg-p--empty'}">${description(u.traitRich, traitDesc || '—')}</p>`;
  }
  if (tab === 'talent') return talentList(u, talents);
  if (tab === 'module') return modulePage(u);
  return skillBlock(u, skillInfo);
}

/* ---- 敌人专属行 ------------------------------------------------------------------------- */

function enemyExtraRow(x) {
  const items = [];
  if (Number.isFinite(x.moveSpeed)) items.push(`移速 ${x.moveSpeed}`);
  if (Number.isFinite(x.massLevel)) items.push(`重量 ${x.massLevel}`);
  if (x.isFly) items.push('飞行');
  const dmgCn = { phys: '物理', arts: '法术', true: '真实', none: '无' }[x.dmgType] || x.dmgType;
  if (dmgCn) items.push(`${dmgCn}伤害`);
  const imm = x.immunities || {};
  const immCn = { stun: '眩晕', silence: '沉默', sleep: '睡眠', frozen: '冻结', levitate: '浮空' };
  const immunes = Object.entries(imm).filter(([, v]) => v).map(([k]) => immCn[k] || k);
  if (immunes.length) items.push(`免疫 ${immunes.join('/')}`);
  if (!items.length) return '';
  return `<div class="dt__enemyinfo">${items.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`;
}

/* ---- 渲染 ------------------------------------------------------------------------------- */

const POS_CN = { MELEE: '近战位', RANGED: '远程位' };
const PROF_CN = {
  WARRIOR: '近卫', SNIPER: '狙击', TANK: '重装', MEDIC: '医疗',
  SUPPORT: '辅助', CASTER: '术师', SPECIAL: '特种', PIONEER: '先锋',
};

function starsOf(rarity) {
  const n = Math.max(0, Math.min(6, Number(rarity) || 0));
  return n ? '★'.repeat(n) : '';
}

export function renderDetail(refs, u) {
  if (!u) {
    if (refs._detailUid != null) {
      refs._portraitObserver?.disconnect();
      refs._detailUid = null;
      refs.detail.classList.remove('is-on');
      refs.detail.innerHTML = '';
      refs.selectionActions.innerHTML = '';
      refs.selectionActions.hidden = true;
    }
    return;
  }
  refs.detail.classList.add('is-on');
  refs.detail.classList.toggle('has-custom-actions', !!u.alt);
  // 手牌选中没有撤退键：让左栏占满（见 detail-redesign.css）
  refs.detail.classList.toggle('is-hand', !!u.hand);
  refs.detail.classList.toggle('is-token', !!u.tokenId);
  refs.detail.classList.toggle('is-enemy', !!u.enemy);

  // chessId 也必须进 key：阿米娅换形态是换 chessId，uid 不变、技能可能同名，
  // 不带 chessId 的话面板会一直显示旧形态的星级/职业/范围。
  const detailKey = `${u.uid}:${u.chessId || ''}:${u.personaIndex ?? ''}:${u.skill?.skillId || u.skillInfo?.skillId || ''}`;
  if (refs._detailUid !== detailKey) {
    refs._detailUid = detailKey;
    const sk = u.skill;
    const skIcon = sk ? skillIcon(sk.skillId) : null;
    const talents = Array.isArray(u.talents) ? u.talents : [];
    const skillInfo = u.skillInfo || null;
    // 特性文案由 unitVM / handVM 提供（棋子记录的 trait.desc）。漏取会直接 ReferenceError
    // 把整个 syncHud 打断，表现是「时间不走、面板不显示」——上一版就栽在这里。
    const traitDesc = String(u.traitDesc || '');
    const tab = detailTab(u);
    const body = detailTabBody(u, tab, talents, skillInfo, traitDesc);
    const profLarge = professionIcon(u.profession, 'large') || professionIcon(u.profession);
    const tabs = tabsOf(u);
    const stars = starsOf(u.rarity);
    const profCn = PROF_CN[u.profession] || '';
    const subCn = u.subProfessionName || (u.tokenId || u.enemy ? u.prof : '');
    const posCn = POS_CN[u.position] || '';
    const eliteCn = Number(u.tier) >= 2 ? `精${Math.min(2, Number(u.tier) - 1)}` : '';
    const costText = u.cost > 0 ? String(u.cost) : '—';
    const respawnText = u.respawnTime > 0 ? `${u.respawnTime}s` : '—';
    const aspdText = Number.isFinite(u.attackInterval) ? `${u.attackInterval}s` : '—';

    refs.detail.innerHTML = `
  <div class="dt__portrait"><img src="${esc(portrait(u.charId))}" alt="${esc(u.name)}" /></div>
  <div class="dt__basic">
    <div class="dt__head">
      <div class="dt__headtext">
        <div class="dt__stars" style="--dt-rarity:${esc(rarityColor(u.rarity))}">${esc(stars)}${eliteCn ? `<i class="dt__elite">${esc(eliteCn)}</i>` : ''}</div>
        <div class="dt__nameline">
          ${profLarge ? `<img class="dt__profession" src="${esc(profLarge)}" alt="${esc(profCn)}" />` : ''}
          <div class="dt__name">${esc(u.name)}</div>
        </div>
        ${u.appellation ? `<div class="dt__en">${esc(u.appellation)}</div>` : ''}
        <div class="dt__classline">
          ${profCn ? `<span class="dt__cls">${esc(profCn)}</span>` : ''}
          ${subCn ? `<i class="dt__sepd"></i><span class="dt__sub">${esc(subCn)}</span>` : ''}
          ${posCn ? `<span class="dt__pos">${esc(posCn)}</span>` : ''}
          ${u.level ? `<span class="dt__level"><small>LV</small>${esc(u.level)}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="dt__hp"><i data-k="hpfill"></i><span class="dt__hp-label">生命</span><b data-k="hptext"></b></div>
    ${u.enemyExtra ? enemyExtraRow(u.enemyExtra) : ''}
    ${u.hand ? '' : `<div class="dt__basicbtns">
      <button class="dt__skill" data-act="unit-skill" title="${sk ? esc(sk.name) : '无技能'}">
        ${skIcon ? `<img src="${esc(skIcon)}" alt="" />` : `<i class="ph">S${(sk?.index ?? 0) + 1}</i>`}
        <i class="dt__charge" data-k="charge"></i>
        <i class="dt__dur" data-k="dur" style="width:0;display:none"></i>
        <span class="dt__sp" data-k="sp"></span>
      </button>
      <button class="dt__range${u.rangeMode === 'skill' ? ' is-on' : ''}" data-act="unit-range"
              title="${u.rangeMode === 'skill' ? '当前：技能范围（点击切回攻击范围）' : '当前：攻击范围（点击查看技能范围）'}"
              aria-pressed="${u.rangeMode === 'skill' ? 'true' : 'false'}">
        ${rangeGridIcon()}
      </button>
      <button class="dt__retreat" data-act="retreat" title="撤退">
        ${iconStroke('leave')}<span>撤退</span>
      </button>
    </div>`}
  </div>
  <div class="dt__right">
    <div class="dt__grid">
      <div class="dt__stat"><i>生命上限</i><b data-k="hpbase">0</b></div>
      <div class="dt__stat"><i>攻击</i><b data-k="atk">0</b></div>
      <div class="dt__stat"><i>防御</i><b data-k="def">0</b></div>
      <div class="dt__stat"><i>法术抗性</i><b data-k="res">0</b></div>
      <div class="dt__stat"><i>攻击间隔</i><b data-k="aspd">${esc(aspdText)}</b></div>
      <div class="dt__stat"><i>阻挡数</i><b data-k="block">0</b></div>
      <div class="dt__stat"><i>部署费用</i><b data-k="cost">${esc(costText)}</b></div>
      <div class="dt__stat"><i>再部署</i><b data-k="respawn">${esc(respawnText)}</b></div>
    </div>
    ${u.persona ? `<div class="dt__persona" role="group" aria-label="形态切换">
      ${u.persona.list.map((p) => `<button class="dt__pbtn${p.id === u.chessId ? ' is-on' : ''}" data-act="unit-persona"
        data-id="${esc(p.id)}" title="切换到 ${esc(p.name)}${p.profession ? `（${esc(p.profession)}）` : ''}"
        aria-pressed="${p.id === u.chessId ? 'true' : 'false'}">${esc(p.name)}</button>`).join('')}
      <small class="dt__pnote">${u.hand ? '换形态后部署即生效' : '换形态会原地重新部署'}</small>
    </div>` : ''}
    <div class="dt__tabs" role="tablist">
      ${tabs.map(([id, label]) => `<button class="dt__tab${tab === id ? ' is-on' : ''}" data-act="dt-tab" data-dt="${id}" role="tab">${label}</button>`).join('')}
      ${u.chessId ? `<a class="dt__edit" href="/studio/operators.html?id=${encodeURIComponent(u.chessId)}"
        title="到「干员详情」页调这位干员的数值、技能、天赋、模组">编辑此干员</a>` : ''}
    </div>
    <div class="dt__info">${body}</div>
    ${u.hand
      ? `<div class="dt__range-preview" title="攻击范围">
      <span data-k="range-preview">${rangeDiagram(u.rangeGrid)}</span><small data-k="range-label">攻击范围</small>
    </div>`
      : `<button class="dt__range-preview" data-act="unit-range" title="攻击范围与技能范围">
      <span data-k="range-preview">${rangeDiagram(u.rangeGrid)}</span><small data-k="range-label">${u.rangeMode === 'skill' ? '技能范围' : '攻击范围'}</small>
    </button>`}
  </div>
  ${u.alt ? `<div class="dt__actions"><button class="dt__alt" data-act="unit-alt" data-k="alt">
    <span data-k="alt-text">${esc(u.alt)}</span><i class="dt__cd" data-k="alt-cd" style="display:none"></i>
  </button>
  <button class="dt__alt" data-act="unit-equipment" data-k="equip">${esc(u.equipment)}</button></div>` : ''}`;
    fitPortrait(refs, u.charId);
    refs.selectionActions.replaceChildren();
    const controls = refs.detail.querySelector('.dt__basicbtns');
    if (controls) refs.selectionActions.append(controls);
    refs.selectionActions.hidden = !!u.hand;
    refs.detail.classList.remove('is-bump');
    void refs.detail.offsetWidth;
    refs.detail.classList.add('is-bump');
  }

  updateValues(refs, u);
}

/** 每帧只改数字。data-k 名字与 renderDetail 里的模板是一份契约，改一处必须同步另一处。 */
function updateValues(refs, u) {
  const q = (k) => refs.detail.querySelector(`[data-k="${k}"]`) || refs.selectionActions.querySelector(`[data-k="${k}"]`);
  const hpFill = q('hpfill');
  if (hpFill) hpFill.style.width = `${clamp01(u.hp / Math.max(1, u.maxHp)) * 100}%`;
  const hpText = q('hptext');
  // 血条上写「当前 / 上限」：手牌还没落地时是 0/0，落地后才是真实血量
  if (hpText) hpText.textContent = u.maxHp > 0 ? `${Math.round(u.hp)} / ${Math.round(u.maxHp)}` : '待部署';
  const hpBase = q('hpbase');
  if (hpBase) hpBase.textContent = u.maxHp > 0 ? String(Math.round(u.maxHp)) : '—';
  const atkEl = q('atk'); if (atkEl) atkEl.textContent = Math.round(u.atk);
  const defEl = q('def'); if (defEl) defEl.textContent = Math.round(u.def);
  const resEl = q('res'); if (resEl) resEl.textContent = Math.round(u.res);
  // 阻挡数：上一版重排时漏了这一个，导致面板上永远是 0
  const blockEl = q('block'); if (blockEl) blockEl.textContent = Math.round(u.block ?? 0);

  const btn = refs.selectionActions.querySelector('.dt__skill');
  const charge = q('charge');
  const dur = q('dur');
  const sp = q('sp');
  const sk = u.skill;
  if (!sk) {
    if (charge) charge.style.height = '0';
    if (dur) dur.style.display = 'none';
    if (sp) sp.textContent = '—';
    btn?.classList.remove('is-ready');
  } else if (btn) {
    // 任意一层已经可用时撤掉蒙版；继续积累后续层数不覆盖技能图标。
    charge.style.height = sk.active || sk.ready ? '0' : `${clamp01(sk.frac) * 100}%`;
    charge.hidden = !!sk.active || !!sk.ready;
    btn.classList.toggle('is-ready', !!sk.ready && !sk.active);
    if (sk.active && sk.dur > 0 && Number.isFinite(sk.dur)) {
      dur.style.display = 'block';
      dur.style.width = `${clamp01(sk.left / sk.dur) * 100}%`;
    } else {
      dur.style.display = 'none';
    }
    sp.textContent = sk.active ? sk.ammoMax > 0 ? `弹药 ${sk.ammoLeft}/${sk.ammoMax}`
      : Number.isFinite(sk.left) && sk.dur > 0 ? `${sk.left.toFixed(1)}s` : '持续生效'
      : sk.ready ? `READY${sk.maxCharges > 1 ? ` ${sk.charges}` : ''}` : `${Math.floor(sk.sp)}/${sk.cost}`;
  }
  const range = refs.selectionActions.querySelector('.dt__range');
  if (range) {
    range.classList.toggle('is-on', u.rangeMode === 'skill');
    range.setAttribute('aria-pressed', String(u.rangeMode === 'skill'));
    range.title = u.rangeMode === 'skill' ? '当前技能范围，点击查看攻击范围' : '当前攻击范围，点击查看技能范围';
  }
  const rangeSig = JSON.stringify(u.rangeGrid);
  if (refs._detailRange !== rangeSig || refs._detailRangeUid !== u.uid) {
    const preview = q('range-preview');
    if (preview) preview.innerHTML = rangeDiagram(u.rangeGrid);
    refs._detailRange = rangeSig; refs._detailRangeUid = u.uid;
  }
  const rangeLabel = q('range-label');
  if (rangeLabel) rangeLabel.textContent = u.rangeMode === 'skill' ? '技能范围' : '攻击范围';

  // 面具切换冷却：按钮上直接压一层倒计时，剩几秒写得清清楚楚（原来完全没有反馈，
  // 玩家点了没反应只能猜「是不是费不够/是不是坏了」）。同时把面具名与费用改成实时值。
  const altBtn = q('alt');
  if (altBtn) {
    const cd = Math.max(0, Number(u.altCd) || 0);
    const altText = q('alt-text');
    const altCd = q('alt-cd');
    if (altText && u.alt && altText.textContent !== u.alt) altText.textContent = u.alt;
    altBtn.classList.toggle('is-cooling', cd > 0);
    altBtn.classList.toggle('is-poor', !!u.altPoor);
    if (altCd) {
      if (cd > 0) { altCd.style.display = 'block'; altCd.textContent = `${cd.toFixed(1)}s`; }
      else altCd.style.display = 'none';
    }
    altBtn.title = cd > 0 ? `面具切换冷却中，还剩 ${cd.toFixed(1)} 秒`
      : u.altPoor ? '部署费用不足 10 点'
      : '消耗 10 点部署费用，切换人格面具（切换后 5 秒冷却）';
  }
}
