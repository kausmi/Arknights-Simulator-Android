// public/studio/js/operators.js — 干员详情（/studio/operators.html）
//
// 五类可改的东西，各自独立存在、独立还原：
//   ⓪ loadout  携带（潜能 / 技能 / 模组 / 立绘）
//   ① stats    基础数值（生命/攻击/防御/费用…）
//   ② trait    职业特性（trait.bb 里的键值）
//   ③ talents  天赋（每个天赋的 bb 键值）
//   ④ modules  模组（等级、属性加成、模组替换的特性、模组追加/加强的天赋）
//
// 接口：
//   GET    /api/operators                  原表 + 覆盖（edited）+ 类别清单
//   POST   /api/operators/<id>/<category>  写某一类
//   DELETE /api/operators/<id>/<category>  只还原某一类
//   DELETE /api/operators/<id>             还原这位干员的全部
//   DELETE /api/operators/ALL/<category>   还原所有干员的某一类
//   DELETE /api/operators/ALL              全部还原
//
// 原则：原值永远是官方数字，现值是叠了覆盖后真正生效的数字；两者不同即「已改」。

const PROFESSIONS = PROFESSION_CN;
const RARITY_LABEL = (r) => '★'.repeat(Math.max(1, Math.min(6, Number(r) || 1)));

/**
 * 基础数值的可编辑字段。
 *
 * 这里**没有**「潜能」—— 潜能不是「把某个数字改掉」，而是按官方每人的 potDown 差异表折算
 * 一整套 stats / statsBase。它放在「携带与潜能」那一块，选 1~6 档就实时算出结果。
 * 以前这里有个 `potRank` 输入框，填了只会往覆盖表里写一个没人读的 `stats.potRank`，
 * 下面还煞有介事地按「每级潜能 +2%」显示折算值 —— 那是编的，官方每个干员给的东西完全不同。
 */
const STAT_FIELDS = [
  ['maxHp', '生命上限'], ['atk', '攻击'], ['def', '防御'], ['res', '法抗'],
  ['cost', '部署费用'], ['blockCnt', '阻挡数'], ['bat', '攻击间隔'], ['aspd', '攻速'],
  ['respawnTime', '再部署'], ['spRecovery', '技力回复'], ['hpRecoveryPerSec', '每秒回血'],
  ['moveSpeed', '移动速度'], ['tauntLevel', '嘲讽等级'], ['massLevel', '重量等级'],
];

/** 模组属性可编辑字段。 */
const MODULE_ATTR_FIELDS = ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'aspd', 'respawnTime'];

const CATEGORY_LABEL = { loadout: '携带与潜能', stats: '基础数值', trait: '职业特性', talents: '天赋', modules: '模组', skills: '技能数值' };
const CATEGORY_ORDER = ['loadout', 'stats', 'trait', 'talents', 'modules', 'skills'];

import { renderCustomEditor, renderCustomList } from './custom-operator.js';
// 潜能必须按官方每人的 potDown 表折算 —— 每个干员「潜能给什么」都不一样
// （有的降费用、有的降再部署、有的加攻），统一按 +2% 算必错。
import { atRank, hasPotentialData, POTENTIAL_MAX } from '../../../shared/potential.js';
import {
  modulePrefix,
  PROFESSION_CN, SUB_PROFESSION_CN, subProfessionCn, professionCn, moduleTypeCn, skillKeyCn, isSpecialModule,
} from './tables.js';

const el = (id) => document.getElementById(id);
const listEl = el('ops-list');
const detailEl = el('ops-detail');
// 详情面板被拎成整页时要记住它原来挂在哪儿，返回时放回去。
const detailHost = detailEl ? detailEl.parentElement : null;
const searchEl = el('ops-search');
const onlyEl = el('ops-only-edited');
const countEl = el('ops-count');
const resetAllEl = el('ops-reset-all');
const revertBarEl = el('ops-revert');
const profEl = el('ops-prof');
const rarityEl = el('ops-rarity');
const moduleEl = el('ops-module');
const subProfEl = el('ops-subprof');
const proftabsEl = el('ops-proftabs');
const subpopEl = el('ops-subpop');
const subpopBodyEl = el('ops-subpop-body');
const subpopTitleEl = el('ops-subpop-title');
const subpopCloseEl = el('ops-subpop-close');
const submaskEl = el('ops-submask');
// 弹层与遮罩都挂到 body 末尾：它们用的是 position:fixed，
// 只要任何一个祖先带 transform/filter/perspective，fixed 就会退化成相对那个祖先定位。
// 挂到 body 上就不用管上游有没有这种样式了。
if (subpopEl && subpopEl.parentElement !== document.body) document.body.append(subpopEl);
if (submaskEl && submaskEl.parentElement !== document.body) document.body.append(submaskEl);

let native = {};      // 官方原表
let edited = {};      // 覆盖表
let skinsByChar = {}; // charId -> [{id,name,art,artB}]（来自解包出来的 data/local-skins.json）
// 头像 / 立绘 / 子职业图标：来自 data/assets.json 的登记表。
// 本页原先一个图都没有，259 位干员排成一行行纯文字，手机上根本认不出是谁。
let artIndex = { chars: {}, sub: {} };
// 同一 charId 在数据里有多个条目：chess.json 的 `_a`（未升级）与 `_b`（升级态），
// 再加上 aue / 牌库里的同一位干员。三张表合并后 620 条里有 127 组是同一个人的两个形态，
// 列表上就是两行一模一样的「隐现」—— 谁也分不清该改哪一条。
// 这里按 charId 分组，列表每人只出现一次，形态在详情页顶部切换。
let groups = new Map();   // charId -> [id, id...]（保持合并顺序 = 优先级从低到高）
let entries = [];         // 列表要显示的「代表 id」数组
let selected = null;
let keyword = '';
let onlyEdited = false;
let filterProf = '';
let filterRarity = '0';
let filterModule = 'any';
let filterSub = '';

/** 列表里的这一行是否代表当前选中的那一条（可能是同组里的另一个形态）。 */
function isSelectedRow(rowId) {
  if (rowId === selected) return true;
  const g = groups.get((native[rowId] || {}).charId || rowId);
  return Array.isArray(g) && g.includes(selected);
}

const hasEdits = (id) => {
  const e = edited[id];
  if (!e) return false;
  return CATEGORY_ORDER.some((c) => e[c] && Object.keys(e[c]).length);
};
const editedCats = (id) => {
  const e = edited[id] || {};
  return CATEGORY_ORDER.filter((c) => e[c] && Object.keys(e[c]).length);
};

const num = (v, fallback = '—') => (typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback);

/**
 * 数值输入的钳制：不允许负数、最多两位小数。
 *
 * 为什么不能只靠 <input min="0" step="0.01">：手机软键盘（尤其系统数字面板）
 * 会绕过 min/step 直接把 -5 或 1.23456 写进 value，浏览器的约束只在提交表单时检查。
 * 所以 JS 侧必须自己再收一遍，保存时也再收一遍 —— 双保险。
 */
function clampNum(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(Math.max(0, v) * 100) / 100;
}

/** 允许负数的两位小数：技能 duration 的 -1 = 持续时间无限，钳到 0 会毁掉这个技能。 */
function round2n(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `请求失败（${res.status}）`);
  return body;
}

async function loadAll() {
  const data = await api('/api/operators');
  native = (data && data.operators) || {};
  edited = (data && data.edited) || {};
  await loadSkins();
  await loadArt();
  fillSubProfessions();
  buildGroups();
}

/**
 * 按 charId 分组，决定列表上每位干员用哪个 id 当代表。
 *
 * 挑选规则：同一个人的 `_b`（升级态，满配数值）优先；没有 `_b` 就取组内最后一个
 * —— 合并顺序是 chess → 牌库 → aue，后面的优先级更高，与实际游玩用的那份一致。
 */
function buildGroups() {
  groups = new Map();
  const order = [];
  for (const id of Object.keys(native)) {
    const rec = native[id] || {};
    const key = rec.charId || id;      // 没有 charId 的（自设 / diy）各自独立
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(id);
  }
  entries = order.map((key) => {
    const ids = groups.get(key);
    return ids.find((i) => /_b$/.test(i)) || ids[ids.length - 1];
  });
}

/**
 * 读解包出来的皮肤索引。
 *
 * 官方表（chess.json / assets.json）里**没有**皮肤字段，皮肤只能从本机 skinpack 解，
 * 索引落在 data/local-skins.json。没解过就是空的 —— 这时详情页显示「去解这个干员的皮肤」。
 */
async function loadSkins() {
  try {
    const res = await fetch('/data/local-skins.json', { cache: 'no-store' });
    if (!res.ok) { skinsByChar = {}; return; }
    const body = await res.json();
    skinsByChar = (body && body.chars) || {};
  } catch {
    skinsByChar = {};
  }
}

/**
 * 读资源登记表（头像 / 立绘 / 子职业图标）。
 *
 * data/assets.json 有 2.5MB，但它只是「charId → 四个图片路径」的字符串表，
 * 解析后常驻内存没有任何压力；断网或没提取过资源时整表为空，页面上就退回纯文字。
 */
let artLoaded = false;
async function loadArt(force = false) {
  // assets.json 有 2.5MB，saveCurrent / revert 之后都会再走一遍 loadAll，
  // 不缓存的话每存一次就重下一遍。内容在应用生命周期内不会变，加载一次就够。
  if (artLoaded && !force) return;
  try {
    const res = await fetch('/data/assets.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('no assets');
    const body = await res.json();
    artIndex = {
      chars: (body && body.chars) || {},
      sub: (body && body.prof && body.prof.sub) || {},
    };
    artLoaded = true;
  } catch {
    artIndex = { chars: {}, sub: {} };
  }
}

/** charId → 头像 URL；精二优先。拿不到返回空串（调用方画占位）。 */
function avatarOf(charId, e2 = false) {
  const c = charId && artIndex.chars[charId];
  if (!c) return '';
  return (e2 && c.avatarE2) || c.avatar || '';
}

/**
 * 把详情面板拎成一个真正独立的整页。
 *
 * 为什么不用纯 CSS：这个页面（operators.css / menu.css / theme.css）里有二十多条
 * 带 `!important` 的高特异性规则压着 .ops__detail 与 .ops__hero，写多少条 CSS
 * 都可能被其中一条打断 —— 实机上表现就是「右半边永远是白的、页面滚不动」。
 * 这里直接给元素写 **inline !important**，行内声明优先于任何样式表，一次性绕开。
 */
function enterDetailPage() {
  const st = detailEl.style;
  const set = (k, v) => st.setProperty(k, v, 'important');
  set('position', 'fixed');
  set('inset', '0');
  set('left', '0');
  set('top', '0');
  set('width', '100vw');
  set('max-width', '100vw');
  set('height', '100vh');
  set('max-height', 'none');
  set('margin', '0');
  set('padding', '0');
  set('overflow-x', 'hidden');
  set('overflow-y', 'auto');
  set('-webkit-overflow-scrolling', 'touch');
  set('touch-action', 'pan-y');
  set('overscroll-behavior', 'contain');
  set('background', '#0e1216');
  set('z-index', '60');
  set('border', '0');
  set('border-radius', '0');
  set('color-scheme', 'dark');
  if (location.search.includes('probe')) {
    set('outline', '3px solid #00f');
    const h = detailEl.querySelector('.ops__hero'); if (h) h.style.setProperty('outline','3px solid #f00','important');
    const a = detailEl.querySelector('.ops__hero-art'); if (a) a.style.setProperty('outline','3px solid #0f0','important');
    const t = detailEl.querySelector('.ops__hero-text'); if (t) t.style.setProperty('outline','3px solid #ff0','important');
  }
  // 从原来的父级里摘出来挂到 body 上：父级是 grid 的一栏，宽度会被挤掉。
  if (detailEl.parentElement !== document.body) document.body.append(detailEl);
  document.documentElement.style.setProperty('overflow', 'hidden', 'important');
}

/**
 * 抬头（hero）的版式：横屏一套、竖屏一套。
 *
 * 为什么必须写在 JS 里而不是 CSS：.ops__hero-text 的 max-width / background / padding
 * 是以 inline `!important` 写进去的（为了压过样式表里二十多条高特异性规则），
 * 而行内 !important 的优先级高于任何样式表规则 —— CSS 里再怎么写都改不动它。
 * 所以横竖屏两套值只能在这里按方向分别写，并在方向变化时重写一次。
 */
function applyHeroLayout(heroEl) {
  const h = heroEl || detailEl?.querySelector('.ops__hero');
  const t = h && h.querySelector('.ops__hero-text');
  if (!t) return;
  const land = window.matchMedia('(orientation: landscape)').matches;
  t.style.setProperty('position', 'absolute', 'important');
  t.style.setProperty('left', '0', 'important');
  t.style.setProperty('bottom', '0', 'important');
  if (land) {
    // 横屏：信息条整宽压底，一行放名字+职业+数值，立绘只在上半部露头
    t.style.setProperty('max-width', '100%', 'important');
    t.style.setProperty('padding', '10px 16px 12px', 'important');
    t.style.setProperty('background', 'linear-gradient(0deg, rgb(4 7 10 / 96%) 0%, rgb(4 7 10 / 82%) 58%, rgb(4 7 10 / 0%) 100%)', 'important');
  } else {
    t.style.setProperty('max-width', 'min(58%, 660px)', 'important');
    t.style.setProperty('padding', '14px 30px 14px 16px', 'important');
    t.style.setProperty('background', 'linear-gradient(96deg, rgb(4 7 10 / 95%) 0%, rgb(4 7 10 / 84%) 62%, rgb(4 7 10 / 0%) 100%)', 'important');
  }
}

// 转屏时重写一次（renderDetail 只在数据变化时跑，转屏不会触发它）
try {
  const mq = window.matchMedia('(orientation: landscape)');
  const onOrient = () => applyHeroLayout();
  if (mq.addEventListener) mq.addEventListener('change', onOrient);
  else if (mq.addListener) mq.addListener(onOrient);
} catch {}

/** 退出整页详情：把面板放回原来那一栏，清掉行内样式。 */
function exitDetailPage() {
  document.body.classList.remove('ops-editing');
  detailEl.removeAttribute('style');
  if (detailHost && detailEl.parentElement !== detailHost) detailHost.append(detailEl);
}

/**
 * 进入「数据编辑页」/ 回到「详情页」。
 *
 * 手机横屏时详情页要同时干两件事：读（看名字、立绘、数值、技能）和改（一堆输入框）。
 * 挤在一页里结果是两边都难用 —— 输入框把版面撑得又长又碎，字号还被压小。
 * 所以横屏拆成两页：详情页只读（输入框收起，只留「原值」），编辑页才放输入框。
 * 竖屏不动：竖屏本来就一页滚到底，输入框分开反而要多点一次。
 *
 * 状态挂在 body 的 `ops-editing` 类上，纯 CSS 切换，不重建 DOM（重建会丢未保存的输入）。
 */
function enterEditing() {
  document.body.classList.add('ops-editing');
  if (detailEl) detailEl.scrollTop = 0;
  try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
}

function leaveEditing() {
  document.body.classList.remove('ops-editing');
  if (detailEl) detailEl.scrollTop = 0;
  try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
}

/** charId → 立绘 URL（精二全身）。 */
function illustOf(charId) {
  const c = charId && artIndex.chars[charId];
  return (c && (c.illust || c.portraitE2 || c.portrait)) || '';
}

/** subProfessionId → 子职业图标 URL。 */
function subIconOf(subId) {
  return (subId && artIndex.sub[subId]) || '';
}

/** 把数据里出现过的子职业填进筛选下拉（按职业分组，用中文名显示）。 */
function fillSubProfessions() {
  if (!subProfEl) return;
  const seen = new Map();      // subId -> profession
  for (const rec of Object.values(native)) {
    const id = rec?.subProfessionId;
    if (id && !seen.has(id)) seen.set(id, rec.profession || '');
  }
  const byProf = {};          // 注意别叫 groups：模块级已有一个 groups（charId 分组表）
  for (const [id, prof] of seen) {
    (byProf[prof] = byProf[prof] || []).push(id);
  }
  const keep = filterSub;
  const parts = ['<option value="">全部子职业</option>'];
  for (const prof of Object.keys(PROFESSIONS)) {
    const ids = byProf[prof];
    if (!ids || !ids.length) continue;
    const opts = ids
      .sort((a, b) => subProfessionCn(a).localeCompare(subProfessionCn(b), 'zh-Hans-CN'))
      .map((id) => `<option value="${esc(id)}"${id === keep ? ' selected' : ''}>${esc(subProfessionCn(id))}</option>`)
      .join('');
    parts.push(`<optgroup label="${esc(professionCn(prof))}">${opts}</optgroup>`);
  }
  subProfEl.innerHTML = parts.join('');
}

/* ---- 职业栏 + 子职业弹层（官方干员页的入口样式） --------------------------------------------- */

// 职业 → 自绘线条图标（官方 icon 资源本机一份都没有，见 assets/prof/*.svg）
const PROF_ICON = {
  PIONEER: 'pioneer', WARRIOR: 'warrior', SNIPER: 'sniper', MEDIC: 'medic',
  CASTER: 'caster', SPECIAL: 'special', TANK: 'tank', SUPPORT: 'support',
};
const PROF_ORDER = ['PIONEER', 'WARRIOR', 'SNIPER', 'TANK', 'MEDIC', 'CASTER', 'SUPPORT', 'SPECIAL'];

const profIconUrl = (prof) => (PROF_ICON[prof] ? `/assets/prof/${PROF_ICON[prof]}.svg` : '');
const portraitOf = (charId, e2 = false) => {
  const c = charId && artIndex.chars[charId];
  return (c && ((e2 && c.portraitE2) || c.portrait)) || '';
};

/** 某职业下出现过的子职业（id + 中文名 + 人数）。 */
function subsOf(prof) {
  const m = new Map();
  for (const id of Object.keys(native)) {
    const rec = native[id] || {};
    if (rec.profession !== prof) continue;
    const sid = rec.subProfessionId || '';
    if (!sid) continue;
    const cur = m.get(sid) || { id: sid, cn: subProfessionCn(sid) || sid, n: 0 };
    cur.n += 1;
    m.set(sid, cur);
  }
  return [...m.values()].sort((a, b) => a.cn.localeCompare(b.cn, 'zh-Hans-CN'));
}

function renderProfTabs() {
  if (!proftabsEl) return;
  const all = document.createElement('button');
  all.type = 'button';
  all.className = `ops__ptab ops__ptab--all${filterProf ? '' : ' is-on'}`;
  all.dataset.prof = '';
  all.innerHTML = '<b>ALL</b>';
  all.title = '全部职业';
  const frag = document.createDocumentFragment();
  frag.append(all);
  for (const prof of PROF_ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ops__ptab${filterProf === prof ? ' is-on' : ''}`;
    b.dataset.prof = prof;
    b.title = PROFESSIONS[prof] || prof;
    b.innerHTML = `<img src="${profIconUrl(prof)}" alt=""><i>${esc(PROFESSIONS[prof] || prof)}</i>`;
    frag.append(b);
  }
  proftabsEl.replaceChildren(frag);
}

function closeSubpop() {
  if (!subpopEl) return;
  subpopEl.hidden = true;
  subpopEl.classList.remove('is-on');
  if (submaskEl) submaskEl.hidden = true;
}

/** 点职业图标：筛选该职业，并从右侧滑出它的子职业列表。 */
function openSubpop(prof) {
  if (!subpopEl || !subpopBodyEl) return;
  const subs = prof ? subsOf(prof) : [];
  if (subpopTitleEl) subpopTitleEl.textContent = prof ? `${PROFESSIONS[prof] || prof} · 子职业` : '子职业';
  const rows = [];
  rows.push(`<button type="button" class="ops__subrow${filterSub ? '' : ' is-on'}" data-sub=""><b>全部子职业</b><i>${prof ? '不分子职业' : ''}</i></button>`);
  for (const s of subs) {
    rows.push(`<button type="button" class="ops__subrow${filterSub === s.id ? ' is-on' : ''}" data-sub="${esc(s.id)}"><b>${esc(s.cn)}</b><i>${s.n} 位</i></button>`);
  }
  subpopBodyEl.innerHTML = rows.join('');
  subpopEl.hidden = false;
  subpopEl.classList.add('is-on');
  if (submaskEl) submaskEl.hidden = false;
}

/* ---- 列表 + 筛选 ------------------------------------------------------------------------------ */

function passes(id) {
  const rec = native[id] || {};
  // 同一位干员有多个形态时，筛选与「已改」都按**整组**算：
  // 改了 _a 却在 _b 那行显示「未改」、或者 _a 没有模组就认为这人没模组，都是错的。
  const groupIds = groups.get(rec.charId || id) || [id];
  if (onlyEdited && !groupIds.some(hasEdits)) return false;
  if (filterProf && rec.profession !== filterProf) return false;
  if (filterSub && rec.subProfessionId !== filterSub) return false;
  if (filterRarity !== '0' && String(rec.rarity) !== filterRarity) return false;
  if (filterModule !== 'any') {
    const has = groupIds.some((gid) => Array.isArray(native[gid]?.modules) && native[gid].modules.length > 0);
    if (filterModule === 'has' && !has) return false;
    if (filterModule === 'none' && has) return false;
  }
  if (keyword) {
    // 同一位干员可能有两个 id（_a 未升级 / _b 升级态），搜哪个都应该能搜到本人
    const groupIds = groups.get(rec.charId || id) || [id];
    const hay = `${rec.name || ''} ${id} ${rec.charId || ''} ${groupIds.join(' ')} `
      + `${PROFESSIONS[rec.profession] || ''} ${subProfessionCn(rec.subProfessionId || '')}`.toLowerCase();
    if (!hay.includes(keyword)) return false;
  }
  return true;
}

function renderList({ keepScroll = true } = {}) {
  // 点击某个干员只该高亮变化，不该把列表滚回顶部 —— 所以重建前记住位置、重建后放回去。
  const prevTop = keepScroll ? listEl.scrollTop : 0;
  if (!entries.length) buildGroups();
  const ids = entries.slice().sort((a, b) => {
    const na = native[a]?.name || '', nb = native[b]?.name || '';
    return na.localeCompare(nb, 'zh-Hans-CN') || a.localeCompare(b);
  });
  const shown = ids.filter(passes);
  const changed = entries.filter((id) => {
    const groupIds = groups.get((native[id] || {}).charId || id) || [id];
    return groupIds.some(hasEdits);
  }).length;
  countEl.textContent = `显示 ${shown.length} / ${ids.length} · 已改 ${changed}`;
  resetAllEl.disabled = changed === 0;

  const frag = document.createDocumentFragment();
  for (const id of shown) {
    const rec = native[id] || {};
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ops__item${isSelectedRow(id) ? ' is-on' : ''}`;
    btn.dataset.id = id;
    // 「已改」要按整组算：改的是 _a 而列表显示的是 _b，标记不能丢
    const groupIds = groups.get((native[id] || {}).charId || id) || [id];
    const cats = groupIds.flatMap((gid) => editedCats(gid));
    // 官方干员页的竖版卡：上半身立绘铺满方块、左下圆形等级、右上职业图标、底部黑条名字。
    // 立绘缺失时退回方头像；都缺失则留一块占位底，绝不留破图。
    const art = portraitOf(rec.charId) || avatarOf(rec.charId);
    const lv = rec.status && rec.status.level ? rec.status.level : '';
    const profSvg = profIconUrl(rec.profession);
    const stars = Math.max(1, Number(rec.rarity) || 1);
    // 版式照官方干员卡：竖长条立绘 → 顶部深色条（职业图标 + 星级）→ 左下圆形等级 → 底部名字。
    btn.innerHTML = `<span class="ops__card">`
      + (art
        ? `<img class="ops__card__art" src="${esc(art)}" alt="" loading="lazy" decoding="async">`
        : '<span class="ops__card__art ops__card__art--none" aria-hidden="true"></span>')
      + `<span class="ops__card__top">`
      + (profSvg ? `<img class="ops__card__prof" src="${profSvg}" alt="">` : '')
      + `<span class="ops__card__stars" aria-hidden="true">${'★'.repeat(stars)}</span>`
      + `</span>`
      + (lv !== '' ? `<span class="ops__card__lv">${esc(String(lv))}</span>` : '')
      + `</span>`
      + `<span class="ops__card__name">${esc(rec.name || id)}</span>`
      + (cats.length ? `<span class="ops__flag">已改</span>` : '');
    li.append(btn);
    frag.append(li);
  }
  listEl.replaceChildren(frag);
  // data/assets.json 里的 74 个子职业图标（/assets/prof/sub/*.png）本地根本没打包，
  // 全部 404 → 列表里每张卡都挂一个小破图方块。捕获阶段收 error 直接摘掉。
  if (!listEl.dataset.subErrBound) {
    listEl.dataset.subErrBound = '1';
    listEl.addEventListener('error', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('ops__item__sub')) t.remove();
    }, true);
  }
  if (keepScroll) listEl.scrollTop = prevTop;
  renderProfTabs();
  if (!shown.length) {
    const li = document.createElement('li');
    li.innerHTML = '<p class="ops__hint">没有匹配的干员。</p>';
    listEl.append(li);
  }
}

/* ---- 详情：四个类别分块 ----------------------------------------------------------------------- */

/** 一个「键=值」的小编辑器（特性 / 天赋 / 模组属性都用它）。 */
function kvGrid(pairs, origin, patch, pathPrefix) {
  const wrap = document.createElement('div');
  wrap.className = 'ops__grid';
  for (const [key, label] of pairs) {
    const o = origin?.[key];
    const p = patch?.[key];
    const cur = p !== undefined ? p : o;
    const cell = document.createElement('div');
    cell.className = 'ops__field';
    const id = 'k-' + String(pathPrefix + '.' + key).replace(/[^\w.-]/g, '_');
    // 数值项的标签：能翻成中文就翻（bucket.bb 里是 atk / duration 这类内部键）
    const shown = label === key ? skillKeyCn(key) : label;
    const dflt = '';
    const showCur = cur === undefined || cur === null ? dflt : cur;
    const showOrigin = o === undefined || o === null ? dflt : o;
    cell.innerHTML = `<label for="${esc(id)}">${esc(shown)}<i class="ops__key">${esc(key)}</i></label>`
      // min=0 + step=0.01：手机数字键盘直接给出「非负 + 两位小数」的约束，
      // 浏览器/WebView 的 number 输入框会自己拦负数与多余小数位。
      // JS 侧仍然再钳一次（软键盘与部分输入法会绕过 min/step），见 clampNum()。
      + `<input id="${esc(id)}" type="number" min="0" step="0.01" inputmode="decimal"`
      + ` data-kv="${esc(pathPrefix)}" data-key="${esc(key)}"`
      + ` value="${esc(num(showCur, dflt))}"${p !== undefined ? ' class="is-changed"' : ''}>`
      + `<span class="ops__origin">原值 ${esc(num(showOrigin, dflt))}</span>`
      + `<span class="ops__now" data-now></span>`;
    cell.dataset.origin = JSON.stringify(o === undefined ? null : o);
    wrap.append(cell);
  }
  return wrap;
}

function section(title, body, cat) {
  const box = document.createElement('section');
  box.className = 'ops__sec';
  box.dataset.cat = cat;
  const head = document.createElement('header');
  head.className = 'ops__sec-head';
  head.innerHTML = `<h3>${esc(title)}</h3>`
    + `<button type="button" class="ops__mini" data-revert-cat="${esc(cat)}">只还原${esc(title)}</button>`;
  box.append(head, body);
  return box;
}

/* ---- 携带与潜能 ------------------------------------------------------------------------------ */

/** 当前携带的技能下标（没改过就用记录里的 skill.index）。 */
function currentSkillIndex(rec, delta) {
  if (Number.isInteger(delta.skill) && delta.skill >= 0) return delta.skill;
  const s = rec && rec.skill;
  if (s && Number.isInteger(s.index)) return s.index;
  return 0;
}

/** 当前潜能（1~6）。没改过默认满潜 6 —— 与官方数据一致（chess.json 存的是满潜值）。 */
function currentPotential(rec, delta) {
  if (Number.isInteger(delta.potential) && delta.potential >= 1) return delta.potential;
  return POTENTIAL_MAX;
}

/** 当前携带的模组 id（"none" = 不装）。 */
function currentModuleId(rec, delta) {
  if (typeof delta.module === 'string') return delta.module;
  const m = rec && rec.module;
  if (m && m.active && m.id) return String(m.id);
  return 'none';
}

/**
 * 「携带与潜能」面板。
 *
 * 为什么潜能要在这里而不是塞进基础数值：官方 `potDown` 是**每一档一个完整的差量表**
 * （有的干员潜能降部署费用、有的降再部署、有的加攻击），而基础数值里那个「潜能」
 * 输入框只是个数字，改了它并不会按 potDown 折算。这里选潜能等级，右侧实时把折算后的
 * 生命/攻击/防御/费用显示出来，用户才看得见自己选了什么。
 */
function loadoutBody(rec, delta) {
  const wrap = document.createElement('div');

  // —— 潜能 ——
  const pot = currentPotential(rec, delta);
  const potBox = document.createElement('div');
  potBox.className = 'ops__loadout';
  const hasPot = hasPotentialData(rec);
  const potOpts = [];
  for (let p = 1; p <= POTENTIAL_MAX; p += 1) {
    potOpts.push(`<option value="${p}"${p === pot ? ' selected' : ''}>${p} 潜${p === POTENTIAL_MAX ? '（满潜）' : ''}</option>`);
  }
  potBox.innerHTML = `<h4>潜能激活数</h4>`
    + `<div class="ops__row">`
    + `<select data-loadout="potential" data-init="${pot}"${hasPot ? '' : ' disabled'}>${potOpts.join('')}</select>`
    + `<span class="ops__hint" data-pot-note></span>`
    + `</div>`
    + `<div class="ops__potgrid" data-pot-grid></div>`;
  wrap.append(potBox);

  // —— 携带技能 ——
  const skills = Array.isArray(rec.skills) ? rec.skills : [];
  const si = currentSkillIndex(rec, delta);
  const skillBox = document.createElement('div');
  skillBox.className = 'ops__loadout';
  skillBox.innerHTML = `<h4>携带技能</h4>`;
  if (!skills.length) {
    skillBox.insertAdjacentHTML('beforeend', '<p class="ops__hint">这个干员没有技能数据。</p>');
  } else {
    const opts = skills.map((sk, i) => `<option value="${i}"${i === si ? ' selected' : ''}>${i + 1}. ${esc(sk.name || ('技能 ' + (i + 1)))}</option>`).join('');
    skillBox.insertAdjacentHTML('beforeend', `<div class="ops__row"><select data-loadout="skill" data-init="${si}">${opts}</select></div>`
      + `<p class="ops__desc" data-skill-desc>${esc(skills[si]?.desc || '')}</p>`);
  }
  wrap.append(skillBox);

  // —— 携带模组 ——
  const modules = Array.isArray(rec.modules) ? rec.modules : [];
  const mid = currentModuleId(rec, delta);
  const modBox = document.createElement('div');
  modBox.className = 'ops__loadout';
  modBox.innerHTML = `<h4>携带模组</h4>`;
  if (!modules.length) {
    // 组内另一个形态可能带着模组数据（_a 常常没有、_b 才有）—— 指路而不是干巴巴说「没有」
    const tipId = idInGroupWith(selected, (r) => Array.isArray(r.modules) && r.modules.length);
    modBox.insertAdjacentHTML('beforeend', '<p class="ops__hint">这一条没有模组数据。'
      + (tipId ? `切到「${esc(formLabel(tipId))}」那一形态可以改它的模组。` : '')
      + (!tipId && rec.module && rec.module.name ? `（官方表里记着一个「${esc(rec.module.name)}」，但本机没有它的属性数据，只能看不能装。）` : '')
      + '</p>');
  } else {
    const opts = ['<option value="none"' + (mid === 'none' ? ' selected' : '') + '>不装模组</option>']
      .concat(modules.map((m) => {
        const id = String(m.uniEquipId || '');
        const typeCn = m.typeName ? moduleTypeCn(m.typeName) : '';
        const mark = isSpecialModule(m) ? '【特限】' : '';
        return `<option value="${esc(id)}"${id === mid ? ' selected' : ''}>${mark}${esc(m.name || id)}${typeCn ? ' · ' + esc(typeCn) : ''}</option>`;
      })).join('');
    modBox.insertAdjacentHTML('beforeend', `<div class="ops__row"><select data-loadout="module" data-init="${esc(mid)}">${opts}</select></div>`
      + `<p class="ops__hint" data-mod-note></p>`);
  }
  wrap.append(modBox);

  // —— 立绘 / 皮肤 ——
  const artBox = document.createElement('div');
  artBox.className = 'ops__loadout';
  const art = typeof delta.art === 'string' ? delta.art : (rec.artVariant || 'e0');
  const arts = [['e0', '精一立绘'], ['e2', '精二立绘']];
  const unpacked = (rec.charId && skinsByChar[rec.charId]) || [];
  unpacked.forEach((sk) => {
    if (sk && sk.id) arts.push([String(sk.id), String(sk.name || sk.id)]);
  });
  artBox.innerHTML = `<h4>立绘 / 皮肤</h4>`
    + `<div class="ops__row"><select data-loadout="art" data-init="${esc(art)}">`
    + arts.map(([v, label]) => `<option value="${esc(v)}"${v === art ? ' selected' : ''}>${esc(label)}</option>`).join('')
    + `</select></div>`
    + (arts.length > 2
      ? '<p class="ops__hint">皮肤来自本机 skinpack 的实时解包，选中的会用在手牌 / 详情立绘上。</p>'
      : '<p class="ops__hint">只有精一 / 精二两张。<button type="button" class="ops__mini" data-act="skins">解这个干员的皮肤</button>'
        + (rec.charId ? `（来自 <code>skinpack/${esc(rec.charId)}.ab</code>，约 1~2 秒）` : '') + '</p>');
  wrap.append(artBox);

  // 渲染潜能折算表（不依赖用户交互，进页面就先画一遍）
  queueMicrotask(() => paintPotential(wrap, rec, pot));
  return wrap;
}

/**
 * 天赋段的 DOM（按当前潜能折算后的那份）。
 *
 * 为什么单独拎出来：用户在「携带与潜能」里改潜能时要能当场看到天赋跟着变，
 * 所以需要在不重绘整页的前提下替换这一块。
 *
 * 官方那档「天赋效果增强」就存在天赋的 potMin / potBelow 里，
 * 选低潜能时描述与黑盒数值都要换（例：惊蛰 4 潜以下 113%（+3%）→ 110%）。
 * 所以这里用 atRank 折算后的 recPot，而「这一条被压低过」的判断看原始记录有没有 potBelow
 * —— 数据按满潜建的，拿折算后的 desc 去比永远比不出来。
 */
function talentsBody(rec, e, pot) {
  const recPot = pot >= POTENTIAL_MAX ? rec : atRank(rec, pot - 1);
  const talBody = document.createElement('div');
  const talents = Array.isArray(recPot.talents) ? recPot.talents : [];
  if (!talents.length) {
    const p = document.createElement('p');
    p.className = 'ops__hint';
    p.textContent = '这个干员没有天赋。';
    talBody.append(p);
    return talBody;
  }
  talents.forEach((t, i) => {
    const conn = document.createElement('div');
    conn.className = 'ops__talent';
    const pairs = t.bb && Object.keys(t.bb).length ? Object.entries(t.bb).map(([k]) => [k, k]) : [];
    const raw = (Array.isArray(rec.talents) && rec.talents[i]) || {};
    const lowered = !!(raw.potMin || raw.potBelow);
    const potTag = lowered
      ? `<i class="ops__pottag" title="${raw.potMin ? `满潜或 ${raw.potMin + 1} 潜起才有增强后的效果` : '满潜时效果更强'}">按 ${pot} 潜</i>`
      : '';
    conn.innerHTML = `<h4>天赋 ${i + 1}${t.name ? ' · ' + esc(t.name) : ''}${potTag}</h4>`
      + (t.desc ? `<p class="ops__desc">${esc(t.desc)}</p>` : '');
    if (pairs.length) {
      const delta = (e.talents && e.talents[i] && e.talents[i].bb) || {};
      conn.append(kvGrid(pairs, t.bb, delta, `talents.${i}.bb`));
    } else {
      const p = document.createElement('p');
      p.className = 'ops__hint';
      p.textContent = '这个天赋没有可调整的数值项。';
      conn.append(p);
    }
    talBody.append(conn);
  });
  return talBody;
}

/** 把某个记录按潜能等级折算后的主要数值画成一张小表。 */
function paintPotential(root, rec, potential) {
  const grid = root.querySelector('[data-pot-grid]');
  const note = root.querySelector('[data-pot-note]');
  if (!grid) return;
  if (!hasPotentialData(rec)) {
    grid.innerHTML = '';
    if (note) note.textContent = '这位干员没有潜能差异数据（选哪一档都一样）。';
    return;
  }
  if (note) note.textContent = `按官方潜力表逐档回放，${potential} 潜时生效值如下（数值与天赋一起折）。`;
  const base = rec;                              // 满潜（rank 5）记录
  const now = atRank(base, potential - 1);       // 目标潜能的记录
  const keys = [['maxHp', '生命'], ['atk', '攻击'], ['def', '防御'], ['res', '法抗'], ['cost', '费用'], ['respawnTime', '再部署']];
  const rows = keys.map(([k, label]) => {
    const a = base?.stats?.[k];
    const b = now?.stats?.[k];
    if (typeof a !== 'number' && typeof b !== 'number') return '';
    const diff = (typeof a === 'number' && typeof b === 'number' && a !== b);
    return `<div class="ops__potcell${diff ? ' is-diff' : ''}">`
      + `<span>${esc(label)}</span>`
      + `<b>${esc(num(b, '—'))}</b>`
      + (diff ? `<i>${b > a ? '+' : ''}${Math.round((b - a) * 100) / 100}</i>` : '')
      + `</div>`;
  }).join('');
  // 天赋变化也要列出来：很多干员的潜能档根本不改数值，只改天赋
  // （官方 potentialRanks 里「天赋效果增强」出现 300 多次）。
  // 只列数值的话，这类干员选 1 潜和 6 潜看起来一模一样，用户会以为潜能没生效。
  const baseTal = Array.isArray(base?.talents) ? base.talents : [];
  const nowTal = Array.isArray(now?.talents) ? now.talents : [];
  const talRows = baseTal.map((bt, i) => {
    const nt = nowTal[i] || {};
    const full = String(bt.desc || '');
    const cur = String(nt.desc || '');
    if (!full || full === cur) return '';
    return `<div class="ops__potcell is-diff is-talent">`
      + `<span>天赋 ${i + 1}${bt.name ? ' · ' + esc(bt.name) : ''}</span>`
      + `<b>${esc(cur)}</b>`
      + `<i>满潜：${esc(full)}</i>`
      + `</div>`;
  }).join('');
  grid.innerHTML = (rows || talRows)
    ? rows + talRows
    : '<p class="ops__hint">这份数据里没有可折的主要数值。</p>';
}

/**
 * 某条记录的同组 id（同一位干员的所有形态）。
 *
 * `loadoutBody` 之类的渲染函数是独立的、拿不到 `renderDetail` 里的局部变量，
 * 所以这类「按组查」的辅助必须是模块级的。
 */
function groupOf(id) {
  const rec = native[id] || {};
  return groups.get(rec.charId || id) || [id];
}

/** 组内第一条满足 pick 的记录，返回它的 id；找不到返回 ''。 */
function idInGroupWith(id, pick) {
  for (const gid of groupOf(id)) {
    const r = native[gid];
    if (r && pick(r)) return gid;
  }
  return '';
}

/**
 * 一条记录的「形态」短名。
 *
 * 数据里同一干员常见三组 id：
 *   chess_char_6_19_a / _b  —— a 是未升级（等级 1、技能 4 级），b 是升级态（等级 60、技能 7 级）
 *   aue_char_002_amiya      —— 模拟器自己的满配表
 * 列表里只显示本人一次，形态在这里区分。
 */
function formLabel(id) {
  if (/_b$/.test(id)) return '升级态';
  if (/_a$/.test(id)) return '未升级';
  if (id.startsWith('aue_')) return '满配表';
  if (id.startsWith('chess_')) return '沙盒表';
  return id;
}

function renderDetail() {
  if (!selected || !native[selected]) {
    detailEl.replaceChildren();
    const p = document.createElement('p');
    p.className = 'ops__hint';
    p.textContent = '从左边选一个干员。';
    detailEl.append(p);
    return;
  }
  const rec = native[selected];
  const e = edited[selected] || {};
  const cats = editedCats(selected);
  // 下面几段要按「当前选中的潜能」折算，不能永远拿满潜那份。
  // 数据是按满潜（rank 5）建的：potDown 改数值，天赋的 potMin/potBelow 改「天赋效果增强」那一档。
  // 只有小于满潜时才折算，满潜直接复用原记录（省一次深拷贝）。
  const pot = currentPotential(rec, e.loadout || {});
  const recPot = pot >= POTENTIAL_MAX ? rec : atRank(rec, pot - 1);
  // 这一页顶部那五个数字必须是「真正生效的值」，而不是原表里的值。
  // 原表（native）是没叠用户覆盖的，所以改完 atk 保存、抬头还显示旧攻击力 ——
  // 用户看到的就是「改了没有任何作用」。这里按后端 patchRecord 的同一顺序叠加：
  // 先按潜能折算 potDown，再让用户的 stats 覆盖压上去（后端也是 applyPotential 先、applyStats 后）。
  const effStats = { ...(recPot.stats || {}) };
  if (e.stats && typeof e.stats === 'object' && !Array.isArray(e.stats)) {
    for (const [k, v] of Object.entries(e.stats)) {
      if (typeof v === 'number' && Number.isFinite(v)) effStats[k] = v;
    }
  }

  detailEl.replaceChildren();

  // 进入「详情页」模式：列表让位给整页详情，返回按钮回到列表。
  // 之前详情塞在列表下方，点完不滚过去就等于没反应，用户以为是点不动。
  document.body.classList.add('ops-detail-open');
  enterDetailPage();
  if (!detailEl.querySelector('.ops__back')) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'ops__back';
    back.textContent = '← 返回干员列表';
    // 之前是 position:fixed 钉在屏幕左上，一滚动就压在正文上（用户报「挡住了」）。
    // 改成随页滚走的普通块：它在详情最顶上，滚下去自然消失。
    back.style.setProperty('position', 'static', 'important');
    back.addEventListener('click', () => {
      document.body.classList.remove('ops-detail-open');
      exitDetailPage();
      try { listEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
    });
    detailEl.append(back);
  }

  // 顶部「抬头」：一张立绘 + 名字 + 职业 · 子职业 + 星级 + 内部 id。
  // 原来只有一行纯文字标题，259 位干员全长得一样，改数值时很容易改错人。
  const subCn = subProfessionCn(rec.subProfessionId || '');
  const hero = document.createElement('div');
  hero.className = 'ops__hero';
  // 抬头背景也走 inline：CSS 里 hero 的渐变背景被 operators.css 里几条
  // 高特异性 `background: var(--o-card-2) !important` 压掉，实机表现为
  // 「只有左下角一块深色，右边整片白」。行内声明优先级高于任何样式表。
  hero.style.setProperty('background', 'radial-gradient(120% 90% at 62% 16%, #33424d 0%, #1a222a 46%, #0b0f13 100%)', 'important');
  hero.style.setProperty('position', 'relative', 'important');
  hero.style.setProperty('width', '100%', 'important');
  hero.style.setProperty('overflow', 'hidden', 'important');
  hero.style.setProperty('padding', '0', 'important');
  hero.style.setProperty('margin', '0', 'important');
  hero.style.setProperty('border', '0', 'important');
  hero.style.setProperty('border-radius', '0', 'important');
  const art = illustOf(rec.charId);
  if (location.search.includes('probe')) console.log('[probe] art=', art, 'charId=', rec.charId, 'illus=', JSON.stringify(artIndex.chars[rec.charId]));
  // 没有全身立绘就**不要**拿 128px 头像去顶：以前那样会把头像放大铺满整块，
  // 头像自带的白底就变成整片白墙（用户看到的「右边永远是白的」）。
  // 现在没有立绘就只留深色背景，信息栏照常显示。
  hero.innerHTML = `<div class="ops__hero-art">`
    + (art
      ? `<img class="ops__illust" src="${esc(art)}" alt="" decoding="async">`
      : '<span class="ops__illust ops__illust--none"></span>')
    + `</div>`
    + `<div class="ops__hero-text">`
    + `<h2>${esc(rec.name || selected)}</h2>`
    + `<div class="ops__title">`
    + `<span class="ops__prof">${esc(professionCn(rec.profession))}${subCn && subCn !== rec.profession ? ` · ${esc(subCn)}` : ''}</span>`
    + `<span class="ops__rarity">${RARITY_LABEL(rec.rarity)}</span>`
    + `</div>`
    // 职业图标：点它回到列表、筛到该职业，并从右侧滑出这个职业的子职业列表。
    // 「编辑数据」与它在同一个按钮组里 —— 横屏时这两个要并排放一行，
    // 分开放会因为都占同一个 grid 区域而互相叠住。
    + `<div class="ops__herobtns">`
    + `<button type="button" class="ops__profbtn" data-prof="${esc(rec.profession || '')}" title="看全部${esc(professionCn(rec.profession))}干员">`
    + `<img src="${profIconUrl(rec.profession)}" alt="">`
    + `<span>${esc(professionCn(rec.profession))}</span>`
    + `</button>`
    + `<button type="button" class="ops__editbtn" data-act="edit-data">编辑数据</button>`
    + `</div>`
    + `<div class="ops__chips">`
    + `<span>费用 <b>${esc(num(effStats.cost))}</b></span>`
    + `<span>生命 <b>${esc(num(effStats.maxHp))}</b></span>`
    + `<span>攻击 <b>${esc(num(effStats.atk))}</b></span>`
    + `<span>防御 <b>${esc(num(effStats.def))}</b></span>`
    + `<span>阻挡 <b>${esc(num(effStats.blockCnt))}</b></span>`
    + `</div>`
    + `<small>${esc(selected)}${rec.charId ? ` · ${esc(rec.charId)}` : ''}`
    + `${pot < POTENTIAL_MAX ? ` · 按 ${pot} 潜折算` : ''}</small>`
    + `</div>`;
  const artBox = hero.querySelector('.ops__hero-art');
  if (artBox) {
    artBox.style.setProperty('position', 'absolute', 'important');
    artBox.style.setProperty('inset', '0', 'important');
    artBox.style.setProperty('width', '100%', 'important');
    artBox.style.setProperty('height', '100%', 'important');
    artBox.style.setProperty('padding', '0', 'important');
    artBox.style.setProperty('overflow', 'hidden', 'important');
  }
  applyHeroLayout(hero);
  detailEl.append(hero);

  // 横屏时「详情」和「数据编辑」是两套版面：
  //   · 详情页：输入框全部收起，只显示原值，字号放大，编辑器两列排布 —— 用来读
  //   · 编辑页：body.ops-editing 打开后才放输入框 —— 用来改
  // 竖屏维持原样（一页滚到底）。所有内容都塞进 .ops__editor，CSS 才好成套地切换。
  const editor = document.createElement('div');
  editor.className = 'ops__editor';
  const editBack = document.createElement('button');
  editBack.type = 'button';
  editBack.className = 'ops__editback';
  editBack.textContent = '← 返回干员详情';
  editBack.addEventListener('click', leaveEditing);
  editor.append(editBack);
  detailEl.append(editor);

  // 同一位干员在数据里有多个形态（`_a` 未升级 / `_b` 升级态，或 chess 与 aue 各一份）。
  // 它们的数值是**分开存的**，改哪一个只影响哪一个 —— 所以必须让用户看得见、选得了，
  // 否则「我改了攻击怎么没生效」十有八九是改在了另一个形态上。
  const groupIds = groupOf(selected);
  if (groupIds.length > 1) {
    const bar = document.createElement('div');
    bar.className = 'ops__forms';
    bar.innerHTML = '<span class="ops__forms-label">形态</span>'
      + groupIds.map((gid) => {
        const g = native[gid] || {};
        const label = formLabel(gid);
        const mark = hasEdits(gid) ? ' ·已改' : '';
        return `<button type="button" class="ops__form${gid === selected ? ' is-on' : ''}"`
          + ` data-form="${esc(gid)}" title="${esc(gid)}">${esc(label)}${mark}</button>`;
      }).join('');
    editor.append(bar);
  }

  if (cats.length) {
    const banner = document.createElement('div');
    banner.className = 'ops__banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `<b>这位干员有改动。</b>已改的类别：${cats.map((c) => CATEGORY_LABEL[c]).join('、')}。`
      + '各块右上角可以只把某一块还原。'
      + '<button type="button" class="ops__banner-close" data-dismiss-banner aria-label="收起提示">×</button>';
    editor.append(banner);
  }

  // ⓪ 携带与潜能（这里存的是「携带技能 / 携带模组 / 潜能 / 皮肤」，
  //    独立于下面四类数值改动，可以单独还原）
  editor.append(section('携带与潜能', loadoutBody(rec, e.loadout || {}), 'loadout'));

  // ① 基础数值
  const statsBody = document.createElement('div');
  // 「原值」必须是折算后的那份（recPot），不能是原表 rec ——
  // 低潜能时界面顶部显示折算值、输入框却拿未折算值当基准，
  // 结果「改了却判成没改」「没改却标成改过」。两端同源才比得准。
  statsBody.append(kvGrid(STAT_FIELDS, recPot.stats || {}, e.stats || {}, 'stats'));
  editor.append(section('基础数值', statsBody, 'stats'));

  // ② 职业特性
  const trait = rec.trait || {};
  const traitPairs = trait.bb && Object.keys(trait.bb).length
    ? Object.entries(trait.bb).map(([k]) => [k, k]) : [];
  const traitBody = document.createElement('div');
  if (trait.desc) {
    const d = document.createElement('p');
    d.className = 'ops__desc';
    d.textContent = trait.desc;
    traitBody.append(d);
  }
  if (traitPairs.length) {
    traitBody.append(kvGrid(traitPairs, trait.bb, (e.trait && e.trait.bb) || {}, 'trait.bb'));
  } else {
    const p = document.createElement('p');
    p.className = 'ops__hint';
    p.textContent = '这个干员的职业特性没有可调整的数值项。';
    traitBody.append(p);
  }
  editor.append(section('职业特性', traitBody, 'trait'));

  // ③ 天赋
  editor.append(section('天赋', talentsBody(rec, e, pot), 'talents'));

  // ④ 模组
  const modules = Array.isArray(rec.modules) ? rec.modules : [];
  const modBody = document.createElement('div');
  if (!modules.length) {
    const p = document.createElement('p');
    p.className = 'ops__hint';
    p.textContent = '这个干员没有模组。';
    modBody.append(p);
  } else {
    modules.forEach((m) => {
      const uid = String(m.uniEquipId || '');
      const delta = ((e.modules || {})[uid]) || {};
      const box = document.createElement('div');
      box.className = 'ops__module';
      const typeCn = m.typeName ? moduleTypeCn(m.typeName) : '';
      const special = isSpecialModule(m);
      box.innerHTML = `<h4>模组 · ${esc(m.name || uid)}`
        + `${m.typeName ? ` · ${esc(typeCn)}（${esc(m.typeName)}）` : ''}`
        + `${special ? ' <i class="ops__modtag ops__modtag--special">特限</i>' : ''}`
        + `${m.isDefault ? ' <i class="ops__modtag">默认</i>' : ''}</h4>`
        + `${special ? `<p class="ops__hint ops__hint--special">${esc(m.specialDesc || '适配限定模式')}`
          + `——本模拟器把它当普通模组全天候生效：属性常驻，官方原本只在对应模式里才给的特性与天赋追加，`
          + `这里也按官方数值一并叠上，方便在普通关里直接试。`
          + (m.typeName && modulePrefix(m.typeName) === 'ISW' ? '官方限定【集成战略】。' : m.typeName && modulePrefix(m.typeName) === 'RA' ? '官方限定【生息演算】。' : m.typeName && modulePrefix(m.typeName) === 'SO' ? '官方限定【岁的界园志异】。' : '')
          + `</p>` : ''}`;

      // 等级
      const lvVal = delta.level !== undefined ? delta.level : m.level;
      const lvWrap = document.createElement('div');
      lvWrap.className = 'ops__grid';
      const lvCell = document.createElement('div');
      lvCell.className = 'ops__field';
      lvCell.innerHTML = `<label>模组等级</label>`
        + `<input type="number" step="1" min="1" max="3" data-kv="modules.${esc(uid)}.level" data-key="level"`
        + ` value="${esc(num(lvVal, ''))}"${delta.level !== undefined ? ' class="is-changed"' : ''}>`
        + `<span class="ops__origin">原值 ${esc(num(m.level))}</span>`;
      lvCell.dataset.origin = JSON.stringify(typeof m.level === 'number' ? m.level : null);
      lvWrap.append(lvCell);
      box.append(lvWrap);

      // 属性加成
      const attrFields = MODULE_ATTR_FIELDS
        .filter((k) => (m.attr && k in m.attr) || (delta.attr && k in delta.attr))
        .map((k) => [k, (STAT_FIELDS.find(([sf]) => sf === k) || [k, k])[1]]);
      if (attrFields.length) {
        const h = document.createElement('h5');
        h.textContent = '模组属性加成';
        box.append(h);
        // 原值只能是官方给的 m.attr。以前这里写成 `{...m.attr, ...delta.attr}`，
        // 把用户改过的值混进了「原值」，结果字段下方的「原值」跟着一起变，
        // 而且 collectPatches 拿它比对时会认为「和原值相同」，改完保存直接提示没有改动。
        box.append(kvGrid(attrFields, m.attr || {}, delta.attr || {}, `modules.${uid}.attr`));
      }

      // 模组替换的职业特性
      const to = m.traitOverride || {};
      const toPairs = to.bb && Object.keys(to.bb).length ? Object.entries(to.bb).map(([k]) => [k, k]) : [];
      if (toPairs.length) {
        const h = document.createElement('h5');
        h.textContent = '模组替换的职业特性';
        box.append(h);
        box.append(kvGrid(toPairs, to.bb, (delta.traitOverride && delta.traitOverride.bb) || {},
          `modules.${uid}.traitOverride.bb`));
      }

      // 模组追加 / 加强的天赋
      const tcs = Array.isArray(m.talentChanges) ? m.talentChanges : [];
      if (tcs.length) {
        const h = document.createElement('h5');
        h.textContent = '模组追加 / 加强的天赋';
        box.append(h);
        tcs.forEach((tc, j) => {
          const pairs = tc.bb && Object.keys(tc.bb).length ? Object.entries(tc.bb).map(([k]) => [k, k]) : [];
          const d2 = (delta.talentChanges && delta.talentChanges[j]) || {};
          const c = document.createElement('div');
          c.className = 'ops__talent';
          c.innerHTML = `<h4>${tc.name ? esc(tc.name) : '天赋 ' + (j + 1)}</h4>`
            + (tc.desc ? `<p class="ops__desc">${esc(tc.desc)}</p>` : '');
          if (pairs.length) {
            c.append(kvGrid(pairs, tc.bb, d2.bb || {}, `modules.${uid}.talentChanges.${j}.bb`));
          }
          box.append(c);
        });
      }
      modBody.append(box);
    });
  }
  editor.append(section('模组', modBody, 'modules'));

  // ⑤ 技能数值
  editor.append(section('技能数值', skillsBody(rec, e), 'skills'));

  const actions = document.createElement('div');
  actions.className = 'ops__actions';
  actions.innerHTML = `<button type="button" class="is-primary" data-act="save">保存改动</button>`
    + `<button type="button" data-act="revert"${cats.length ? '' : ' disabled'}>还原这位干员的全部</button>`
    + '<span class="ops__status" role="status"></span>';
  editor.append(actions);
}

/* ---- 技能数值 -------------------------------------------------------------------------------- */

/**
 * 技能的几个「会被战斗引擎真的读走」的字段。
 *
 * 为什么只给这几项：引擎在 `server/sim/skills.js:93` 读 `duration` / 在
 * `server/sim/content/dsl/bounds.js:36` 读 `spCost` / 在 `deploy.js:63-70` 读 `initSp`，
 * 改它们战斗里立刻有反应。而 `desc`（技能描述文字）与 `rangeId`（攻击范围）
 * 改了不影响战斗，其中攻击范围是用户明确要求不许改的，所以这两个字段刻意不在列表里。
 */
const SKILL_NUM_FIELDS = [
  ['spCost', '技力消耗'],
  ['initSp', '初始技力'],
  ['duration', '持续时间'],
  ['maxChargeTime', '充能上限'],
  ['increment', '每次回复'],
  ['level', '技能等级'],
];

/** 官方 -1 = 持续时间无限；0 = 瞬发。把数字翻成人话，避免用户以为是填错了。 */
function durationHint(v) {
  const n = Number(v);
  if (n < 0) return '持续时间无限';
  if (n === 0) return '瞬发 / 持续到技能结束';
  return `${n} 秒`;
}

function skillSelect(idx, key, options, current, label) {
  const opts = options.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(current) ? ' selected' : ''}>${esc(t)}</option>`).join('');
  return `<div class="ops__row"><label class="ops__rowlabel">${esc(label)}`
    + `<select data-kvsel="skills.${idx}.${esc(key)}" data-init="${esc(current)}">${opts}</select>`
    + `</label></div>`;
}

/**
 * 「技能数值」区块。
 *
 * 三位干员（阿米娅、卡达这类）有三条技能，每条都单独给一份，因为玩家改的是
 * 「第一/第二/第三技能」的位置 —— 只给当前携带那一条的话，想调第二技能就得先
 * 在「携带与潜能」里切过去、改完再切回来，非常反直觉。
 *
 * 下标存法见后端 OperatorStore.applySkills：`skills[]` 与当前携带的 `skill` 是两份
 * 独立副本，后端会把同一个补丁叠到两处，所以这里改一条两条都变。
 */
function skillsBody(rec, e) {
  const body = document.createElement('div');
  const skills = Array.isArray(rec.skills) ? rec.skills : [];
  if (!skills.length) {
    const p = document.createElement('p');
    p.className = 'ops__hint';
    p.textContent = '这个干员没有技能数据。';
    body.append(p);
    return body;
  }
  const curIdx = currentSkillIndex(rec, e.loadout || {});
  const patchSkills = (e && e.skills) || {};

  skills.forEach((sk, i) => {
    if (!sk || typeof sk !== 'object') return;
    const delta = patchSkills[String(i)] || {};
    const box = document.createElement('div');
    box.className = 'ops__skill';
    const carry = i === curIdx ? ' <i class="ops__modtag">携带中</i>' : '';
    box.innerHTML = `<h4>${i + 1}. ${esc(sk.name || '技能 ' + (i + 1))}${carry}</h4>`
      + (sk.desc ? `<p class="ops__desc">${esc(sk.desc)}</p>` : '')
      + `<p class="ops__hint">持续时间当前是「${esc(durationHint(delta.duration !== undefined ? delta.duration : sk.duration))}」；`
      + `-1 表示无限。</p>`;

    // 数字项：原值取记录里的，补丁有就压上去
    const pairs = SKILL_NUM_FIELDS
      .filter(([k]) => sk[k] !== undefined && sk[k] !== null)
      .map(([k, label]) => [k, label]);
    if (pairs.length) {
      const origin = {};
      for (const [k] of pairs) origin[k] = sk[k];
      box.append(kvGrid(pairs, origin, delta, `skills.${i}`));
    }

    // 枚举项：技力回复类型 / 持续时间类型
    const spOpts = [['INCREASE_WITH_TIME', '自动回复'], ['INCREASE_WHEN_ATTACK', '攻击回复'],
      ['INCREASE_WHEN_TAKEN_DAMAGE', '受击回复'], ['ON_DEPLOY', '被动（部署即生效）']];
    const dtOpts = [['NONE', '不按弹药计'], ['AMMO', '按弹药计']];
    box.insertAdjacentHTML('beforeend',
      skillSelect(i, 'spType', spOpts, delta.spType !== undefined ? delta.spType : sk.spType, '技力回复类型')
      + skillSelect(i, 'durationType', dtOpts, delta.durationType !== undefined ? delta.durationType : sk.durationType, '持续时间类型'));

    // 描述类字段只读展示 —— 引擎不读 desc，改了不会影响战斗，徒增误解
    const ro = document.createElement('p');
    ro.className = 'ops__hint';
    ro.textContent = `触发：${sk.skillType || '—'}　·　范围 id：${sk.rangeId || '默认'}（攻击范围不可修改）`;
    box.append(ro);

    body.append(box);
  });

  // 圆一下：技能数值改完必须保存才会生效
  const tip = document.createElement('p');
  tip.className = 'ops__hint';
  tip.textContent = '改完要按最下面的「保存改动」才生效。攻击范围不可在本页修改。';
  body.append(tip);
  return body;
}

/* ---- 收集输入 → 分四类补丁 ---------------------------------------------------------------- */

function setDeep(root, path, key, value) {
  const parts = path.split('.');
  let node = root;
  for (const p of parts) {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  node[key] = value;
}

/**
 * 收集要提交的数值。
 *
 * 判据是「输入框里的值与原值不同」，**不是**看 `is-changed` 类。
 * 原来只看类，而类是在 `input` 事件里加的 —— 手机数字键盘在某些输入法下
 * （尤其连续点击、或用系统数字面板直接改）不会稳定派发 `input`，
 * 结果用户明明改了数字、点保存却提示「没有改动可保存」。这是「干员数值调整无法保存」
 * 最可能的一类成因，所以这里直接比数值。
 */
function collectPatches() {
  const patches = { loadout: {}, stats: {}, trait: {}, talents: {}, modules: {}, skills: {} };

  // 携带与潜能：**逐项**比较渲染时的初值（data-init），只提交用户真正动过的那几项。
  // 早先的写法是「四项一起提交」，结果只改技能也会把「潜能=6 / 模组=不装」写进覆盖表，
  // 把干员原本的默认模组顶掉 —— 那是不可接受的副作用。
  for (const sel of detailEl.querySelectorAll('[data-loadout]')) {
    const kind = sel.dataset.loadout;
    const init = sel.dataset.init;
    if (sel.value === init) continue;
    const value = sel.value;
    if (!value || value === 'none' && kind !== 'module') continue;
    if (kind === 'potential') {
      patches.loadout.potential = Number(value);
    } else if (kind === 'skill') {
      patches.loadout.skill = Number(value);
    } else if (kind === 'module') {
      patches.loadout.module = String(value);
    } else if (kind === 'art') {
      patches.loadout.art = String(value);
    }
  }

  // 技能的类型项（spType / durationType）是枚举，不是数字，走 select 单独收。
  for (const sel of detailEl.querySelectorAll('select[data-kvsel]')) {
    if (sel.value === sel.dataset.init) continue;
    const seg = String(sel.dataset.kvsel || '').split('.');
    if (seg.length !== 3 || seg[0] !== 'skills') continue;
    const idx = seg[1];
    if (!patches.skills[idx]) patches.skills[idx] = {};
    patches.skills[idx][seg[2]] = sel.value;
  }

  for (const input of detailEl.querySelectorAll('input[data-kv]')) {
    const raw = input.value.trim();
    if (raw === '') continue;
    // 负数与超过两位小数一律收掉 —— 保存的是收过的那份，不是用户敲的原文。
    // 例外：技能数值里的 duration，官方用 -1 表示「持续时间无限」，钳到 0 会把
    // 一个永久技能变成一个瞬间技能，所以那一类只做两位小数、不钳符号。
    const allowNeg = String(input.dataset.kv || '').startsWith('skills.');
    const v = allowNeg ? round2n(Number(raw)) : clampNum(Number(raw));
    if (v === null) continue;

    // 与原值比较：cell.dataset.origin 存的是原始单个值（JSON），可能为 null
    const cell = input.closest('.ops__field');
    let origin = null;
    try { origin = cell && cell.dataset.origin ? JSON.parse(cell.dataset.origin) : null; } catch { origin = null; }
    const same = origin === null ? false : Number(origin) === v;
    if (same && !input.classList.contains('is-changed')) continue;   // 真没改
    if (same && input.classList.contains('is-changed')) continue;    // 改回去了

    const path = input.dataset.kv;
    const key = input.dataset.key;

    if (path === 'stats') {
      patches.stats[key] = v;
    } else if (path === 'trait.bb') {
      setDeep(patches.trait, 'bb', key, v);
    } else if (path.startsWith('talents.')) {
      const idx = path.split('.')[1];
      if (!patches.talents[idx]) patches.talents[idx] = { bb: {} };
      patches.talents[idx].bb[key] = v;
    } else if (path.startsWith('skills.')) {
      // 按技能下标存。路径形如 skills.0.spCost / skills.2.duration。
      const seg = path.split('.');
      const idx = seg[1];
      if (!patches.skills[idx]) patches.skills[idx] = {};
      patches.skills[idx][key] = v;
    } else if (path.startsWith('modules.')) {
      const seg = path.split('.');
      const uid = seg[1];
      if (!patches.modules[uid]) patches.modules[uid] = {};
      const m = patches.modules[uid];
      if (seg[2] === 'level') {
        m.level = v;
      } else if (seg[2] === 'attr') {
        if (!m.attr) m.attr = {};
        m.attr[key] = v;
      } else if (seg[2] === 'traitOverride') {
        if (!m.traitOverride) m.traitOverride = { bb: {} };
        m.traitOverride.bb[key] = v;
      } else if (seg[2] === 'talentChanges') {
        const j = seg[3];
        if (!m.talentChanges) m.talentChanges = {};
        if (!m.talentChanges[j]) m.talentChanges[j] = { bb: {} };
        m.talentChanges[j].bb[key] = v;
      }
    }
  }
  return patches;
}

/* ---- 写盘 --------------------------------------------------------------------------------- */

function setStatus(text, bad = false) {
  const node = detailEl.querySelector('.ops__status');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('is-bad', bad);
}

async function saveCurrent() {
  if (!selected) return;
  const patches = collectPatches();
  const cats = Object.keys(patches).filter((c) => Object.keys(patches[c]).length);
  if (!cats.length) { setStatus('没有改动可保存', true); return; }
  try {
    for (const cat of cats) {
      await api(`/api/operators/${encodeURIComponent(selected)}/${cat}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patches[cat]),
      });
    }
    await loadAll();
    renderList();
    renderDetail();
    setStatus('已保存：' + cats.map((c) => CATEGORY_LABEL[c]).join('、'));
  } catch (err) {
    setStatus(err.message || '保存失败', true);
  }
}

/**
 * 解当前这位干员的皮肤。
 *
 * 只在网页里跑（AndroidShell 是壳注入的接口），所以浏览器里打开时会走 mock：
 * 直接提示「需要在 App 里打开」，不会静默失败让人以为点了没反应。
 */
async function unpackSkins(btn) {
  const rec = native[selected];
  if (!rec) return;
  const charId = rec.charId;
  if (!charId) { setStatus('这位干员没有 charId，解不出皮肤', true); return; }
  const shell = window.AndroidShell;
  if (!shell || typeof shell.extractSkins !== 'function') {
    setStatus('皮肤解包只能在应用里用（当前没有本机资源）', true);
    return;
  }
  const label = btn.textContent;
  const host = btn.closest('.ops__loadout') || btn.parentElement;
  let bar = host && host.querySelector('[data-skin-progress]');
  if (host && !bar) {
    bar = document.createElement('div');
    bar.className = 'ops__skinbar';
    bar.setAttribute('data-skin-progress', '');
    bar.innerHTML = '<i><b></b></i><span data-skin-pct>0%</span>';
    host.append(bar);
  }
  btn.disabled = true;
  btn.textContent = '正在解…';
  const paint = (pct, text) => {
    if (!bar) return;
    const fill = bar.querySelector('i > b');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    bar.querySelector('[data-skin-pct]').textContent = text || `${Math.round(pct)}%`;
  };
  try {
    const msg = shell.extractSkins(charId);
    setStatus(msg || '正在解皮肤…');
    // 解包在后台线程跑，一边轮询 extractStatus 拿实时百分比，一边等索引里出现这位干员。
    // 以前这里只是死等 30 秒，界面上一点动静都没有 —— 用户以为「皮肤根本解不出来」。
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      let st = {};
      try { st = JSON.parse(shell.extractStatus() || '{}'); } catch { /* 读不到就按 0 算 */ }
      const pct = Number(st.percent) || 0;
      paint(pct, st.running ? `${Math.round(pct)}%` : undefined);
      if (!st.running && i > 2) break;
      await loadSkins();
      if ((skinsByChar[charId] || []).length) break;
    }
    paint(100, '100%');
    await loadSkins();
    renderDetail();
    const n = (skinsByChar[charId] || []).length;
    setStatus(n ? `已解出 ${n} 套皮肤` : '这次没解出皮肤（这个干员可能只有默认皮肤）');
  } catch (err) {
    setStatus(err.message || '解包失败', true);
    btn.disabled = false;
    btn.textContent = label;
  } finally {
    if (bar) setTimeout(() => bar.remove(), 1600);
  }
}

async function revertCategory(cat) {
  if (!selected) return;
  try {
    await api(`/api/operators/${encodeURIComponent(selected)}/${cat}`, { method: 'DELETE' });
    await loadAll();
    renderList();
    renderDetail();
    setStatus('已还原' + (CATEGORY_LABEL[cat] || cat));
  } catch (err) {
    setStatus(err.message || '还原失败', true);
  }
}

async function revertCurrent() {
  if (!selected) return;
  try {
    await api(`/api/operators/${encodeURIComponent(selected)}`, { method: 'DELETE' });
    await loadAll();
    renderList();
    renderDetail();
    setStatus('已还原这位干员的全部改动');
  } catch (err) {
    setStatus(err.message || '还原失败', true);
  }
}

// 「还原改动」不再用 window.prompt 手打数字：手机上是原生输入框，每次都要弹键盘，
// 还得记住 1~5 各自对应哪一类。改成页内一条按钮，点「还原改动」展开、点具体项执行。
function openRevertBar() {
  if (!revertBarEl) { doRevertAll(null); return; }
  revertBarEl.hidden = !revertBarEl.hidden;
}

function closeRevertBar() { if (revertBarEl) revertBarEl.hidden = true; }

async function doRevertAll(cat) {
  closeRevertBar();
  try {
    await api(cat ? `/api/operators/ALL/${cat}` : '/api/operators/ALL', { method: 'DELETE' });
    await loadAll();
    renderList();
    renderDetail();
    setStatus(cat ? '已还原所有干员的' + CATEGORY_LABEL[cat] : '已还原全部改动');
  } catch (err) {
    setStatus(err.message || '还原失败', true);
  }
}

/* ---- 事件 --------------------------------------------------------------------------------- */

listEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-id]');
  if (!btn) return;
  // 换人时要退出「编辑数据」页：编辑页是给上一位干员打开的，
  // 留着这个状态新干员一进来就落在输入框堆里，看不到详情。
  document.body.classList.remove('ops-editing');
  selected = btn.dataset.id;
  // 只在现有节点上切换高亮，不重建列表（重建会让滚动位置归零，用户被弹回顶部）。
  // 列表里每题只出现一行，所以直接按 data-id 相等判断即可（一行就是一个代表 id）。
  for (const el of listEl.querySelectorAll('[data-id]')) {
    el.classList.toggle('is-on', isSelectedRow(el.dataset.id));
  }
  renderDetail();
  try { scrollTo({ top: 0, behavior: 'auto' }); } catch {}
});

searchEl.addEventListener('input', () => { keyword = (searchEl.value || '').trim().toLowerCase(); renderList({ keepScroll: false }); });
onlyEl.addEventListener('change', () => { onlyEdited = onlyEl.checked; renderList({ keepScroll: false }); });
profEl?.addEventListener('change', () => { filterProf = profEl.value; renderList({ keepScroll: false }); });
rarityEl?.addEventListener('change', () => { filterRarity = rarityEl.value; renderList({ keepScroll: false }); });
moduleEl?.addEventListener('change', () => { filterModule = moduleEl.value; renderList({ keepScroll: false }); });
subProfEl?.addEventListener('change', () => { filterSub = subProfEl.value; renderList({ keepScroll: false }); });

/* 职业栏：点职业 = 筛该职业 + 从右侧滑出它的子职业；点 ALL = 清掉职业与子职业。 */
proftabsEl?.addEventListener('click', (e) => {
  const b = e.target.closest('.ops__ptab');
  if (!b) return;
  const prof = b.dataset.prof || '';
  if (prof === filterProf) { openSubpop(prof); if (subProfEl) subProfEl.value = filterSub; return; }
  filterProf = prof;
  filterSub = '';
  if (profEl) profEl.value = prof;
  if (subProfEl) subProfEl.value = '';
  renderList({ keepScroll: false });
  if (prof) openSubpop(prof); else closeSubpop();
});
subpopBodyEl?.addEventListener('click', (e) => {
  const row = e.target.closest('.ops__subrow');
  if (!row) return;
  filterSub = row.dataset.sub || '';
  if (subProfEl) subProfEl.value = filterSub;
  closeSubpop();
  renderList({ keepScroll: false });
});
subpopCloseEl?.addEventListener('click', closeSubpop);
submaskEl?.addEventListener('click', closeSubpop);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSubpop(); });

detailEl.addEventListener('click', (e) => {
  const profBtn = e.target.closest('.ops__profbtn');
  if (profBtn) {
    const prof = profBtn.dataset.prof || '';
    document.body.classList.remove('ops-detail-open');
    exitDetailPage();
    filterProf = prof;
    filterSub = '';
    if (profEl) profEl.value = prof;
    if (subProfEl) subProfEl.value = '';
    renderList({ keepScroll: false });
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
    if (prof) openSubpop(prof);
    return;
  }
  if (e.target.closest('[data-act="edit-data"]')) { enterEditing(); return; }
  if (e.target.closest('.ops__editback')) { leaveEditing(); return; }
  if (e.target.closest('[data-dismiss-banner]')) {
    const b = detailEl.querySelector('.ops__banner');
    if (b) b.remove();
    return;
  }
  const form = e.target.closest('[data-form]');
  if (form) {
    selected = form.dataset.form;
    for (const el of listEl.querySelectorAll('[data-id]')) {
      el.classList.toggle('is-on', isSelectedRow(el.dataset.id));
    }
    renderDetail();
    // 顶栏是 fixed 的（.page__topbar），scrollIntoView 会把详情标题塞到它下面看不见，
    // 所以自己算一个「顶栏高度 + 一点余量」的偏移。
    const top = detailEl.getBoundingClientRect().top + window.scrollY - 64;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    return;
  }
  const rv = e.target.closest('[data-revert-cat]');
  if (rv) { revertCategory(rv.dataset.revertCat); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'save') saveCurrent();
  else if (btn.dataset.act === 'revert') revertCurrent();
  else if (btn.dataset.act === 'skins') unpackSkins(btn);
});

detailEl.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-loadout]');
  if (!sel) return;
  const rec = native[selected];
  if (!rec) return;
  const kind = sel.dataset.loadout;
  if (kind === 'potential') {
    const next = Number(sel.value) || POTENTIAL_MAX;
    paintPotential(detailEl, rec, next);
    // 天赋也要跟着换一档 —— 只重绘这一块，别把上面还没保存的其他输入清掉。
    const sec = detailEl.querySelector('.ops__sec[data-cat="talents"]');
    if (sec) sec.replaceWith(section('天赋', talentsBody(rec, edited[selected] || {}, next), 'talents'));
  } else if (kind === 'skill') {
    const list = Array.isArray(rec.skills) ? rec.skills : [];
    const desc = detailEl.querySelector('[data-skill-desc]');
    const sk = list[Number(sel.value)];
    if (desc) desc.textContent = sk?.desc || '';
  } else if (kind === 'module') {
    const note = detailEl.querySelector('[data-mod-note]');
    if (!note) return;
    const list = Array.isArray(rec.modules) ? rec.modules : [];
    const m = list.find((x) => String(x.uniEquipId || '') === String(sel.value));
    if (!m) { note.textContent = '装上后干员的数值会回到无模组基础值（生命/攻击/防御各减掉模组加成）。'; return; }
    const attr = m.attr || {};
    const bits = Object.keys(attr).filter((k) => typeof attr[k] === 'number')
      .map((k) => `${({ maxHp: '生命', atk: '攻击', def: '防御', res: '法抗', cost: '费用', blockCnt: '阻挡', aspd: '攻速', respawnTime: '再部署' })[k] || k} +${attr[k]}`);
    note.textContent = bits.length ? `装上这个模组：${bits.join('，')}。` : '这个模组没有属性加成，只改特性/天赋。';
  }
});

detailEl.addEventListener('input', (e) => {
  const input = e.target.closest('input[data-kv]');
  if (!input) return;
  const cell = input.closest('.ops__field');
  let origin = null;
  try { origin = cell && cell.dataset.origin ? JSON.parse(cell.dataset.origin) : null; } catch { origin = null; }
  // 输入过程中的值也要收：负数直接清零、多余小数位就地砍掉。
  // 只在「值真的变了」时回写 input.value，否则光标会被打断（敲 1.25 的中间态 1.2 也会被重写）。
  const typed = input.value.trim() === '' ? null : Number(input.value);
  const v = typed === null ? null : clampNum(typed);
  if (v !== null && typed !== v) input.value = String(v);
  const differs = v === null ? origin !== null : (origin === null || v !== origin);
  input.classList.toggle('is-changed', differs);
  updateNow(cell, input, origin, v);
});

/**
 * 实时把「改后生效值」写到字段下面。
 *
 * 为什么需要：之前只有「原值」一行，玩家填完不知道最终会生效多少。
 * 现在每改一次就立刻显示：
 *   · 数值类字段 → 直接显示填入的数（保存后就是它生效）
 *   · 与潜能相关的基础数值 → 同时标出「按 N 潜折算后」
 * 计算规则照官方：每级潜能对该干员主要数值 +2%（生命/攻击/防御），法抗每级 +0~1（不折算）。
 */
function updateNow(cell, input, origin, v) {
  if (!cell) return;
  const nowEl = cell.querySelector('[data-now]');
  if (!nowEl) return;
  if (v === null || !Number.isFinite(v)) { nowEl.textContent = ''; return; }
  const key = input.dataset.key;
  const isModuleAttr = input.dataset.kv.includes('.attr');
  if (isModuleAttr) {
    // 模组的加成是「叠在干员基础数值上」的，单独标出来更清楚
    nowEl.textContent = `模组加成 ${round2(v)}`;
  } else if (typeof origin === 'number' && Number.isFinite(origin) && origin !== v) {
    // 有原值就给出增减量，比只写「改后 1234」直观
    const d = v - origin;
    nowEl.textContent = `改后 ${round2(v)}（${d > 0 ? '+' : ''}${round2(d)}）`;
  } else {
    nowEl.textContent = `改后 ${round2(v)}`;
  }
}

const round2 = (n) => (Math.round(n * 100) / 100).toString();

/** 重算所有字段的「改后」提示。 */
function refreshAllNow() {
  for (const input of detailEl.querySelectorAll('input[data-kv]')) {
    const cell = input.closest('.ops__field');
    let origin = null;
    try { origin = cell && cell.dataset.origin ? JSON.parse(cell.dataset.origin) : null; } catch { origin = null; }
    const typed = input.value.trim() === '' ? null : Number(input.value);
    const v = typed === null ? null : clampNum(typed);
    updateNow(cell, input, origin, v);
  }
}

resetAllEl.addEventListener('click', () => {
  // 必须是 CATEGORY_ORDER，不是手写的四个字符串 —— 以前漏了 loadout，
  // 结果只改过「携带与潜能」的时候点「还原改动」会提示「现在没有任何改动可以还原」。
  const cats = CATEGORY_ORDER.filter(
    (c) => Object.keys(edited).some((id) => edited[id] && edited[id][c] && Object.keys(edited[id][c]).length),
  );
  if (!cats.length) { setStatus('现在没有任何改动可以还原'); return; }
  resetAllEl.disabled = false;
  openRevertBar();
});
revertBarEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-revert-all]');
  if (!btn) return;
  const which = btn.dataset.revertAll;
  if (which === 'cancel') { closeRevertBar(); return; }
  doRevertAll(which === 'all' ? null : which);
});

/* ---- 自定义干员（实验功能） ------------------------------------------------------------------ */

const customHost = el('ops-custom-host');
let customOpen = false;

function refreshCustomList() {
  if (!customHost) return;
  const box = document.createElement('div');
  customHost.replaceChildren(box);
  renderCustomList(box, { onChange: () => { refreshCustomList(); loadAll().then(() => { renderList(); }); } });
}

el('ops-new-custom')?.addEventListener('click', async () => {
  if (!customHost) return;
  if (customOpen) { customHost.replaceChildren(); customOpen = false; refreshCustomList(); return; }
  customOpen = true;
  const box = document.createElement('div');
  customHost.replaceChildren(box);
  renderCustomEditor(box, {
    onCancel: () => { customOpen = false; customHost.replaceChildren(); refreshCustomList(); },
    onSaved: async () => {
      await loadAll();
      renderList();
      // 保存成功后收起编辑器，回到列表
      customOpen = false;
      customHost.replaceChildren();
      refreshCustomList();
      setStatus('自定义干员已加入牌库');
    },
  });
});

refreshCustomList();

/* ---- 启动 --------------------------------------------------------------------------------- */

(async () => {
  try {
    await loadAll();
    // 深链：从沙盒详情面板的「编辑此干员」跳过来时会带 ?id=<chessId>。
    // 必须等 loadAll 之后才能解析（groups/native 都是那时才有），并且要按整组解析：
    // 传进来的可能是 _b，而列表里显示的是同组的代表 id。
    const wantId = new URLSearchParams(location.search).get('id');
    if (wantId && native[wantId]) {
      selected = idInGroupWith(wantId, (id) => entries.includes(id)) || wantId;
      if (!entries.includes(selected)) selected = wantId;
    }
    renderList();
    renderDetail();
    if (wantId && selected) {
      // 详情在右侧、列表在左侧：滚到详情顶部，并让列表里那行可见
      const row = listEl.querySelector(`[data-id="${CSS.escape(selected)}"]`);
      row?.scrollIntoView({ block: 'center' });
      const top = detailEl.getBoundingClientRect().top + window.scrollY - 64;
      window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    }
  } catch (err) {
    countEl.textContent = '载入失败：' + (err.message || err);
    detailEl.replaceChildren();
    const p = document.createElement('p');
    p.className = 'ops__hint';
    p.textContent = '读不到干员表。请确认本地服务在运行。';
    detailEl.append(p);
  }
})();
