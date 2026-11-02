// public/studio/js/operators.js — 干员数值编辑器（/studio/operators.html）
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

/** 基础数值的可编辑字段。 */
const STAT_FIELDS = [
  ['potRank', '潜能'], ['maxHp', '生命上限'], ['atk', '攻击'], ['def', '防御'], ['res', '法抗'],
  ['cost', '部署费用'], ['blockCnt', '阻挡数'], ['bat', '攻击间隔'], ['aspd', '攻速'],
  ['respawnTime', '再部署'], ['spRecovery', '技力回复'], ['hpRecoveryPerSec', '每秒回血'],
  ['moveSpeed', '移动速度'], ['tauntLevel', '嘲讽等级'], ['massLevel', '重量等级'],
];

/** 模组属性可编辑字段。 */
const MODULE_ATTR_FIELDS = ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'aspd', 'respawnTime'];

const CATEGORY_LABEL = { loadout: '携带与潜能', stats: '基础数值', trait: '职业特性', talents: '天赋', modules: '模组' };
const CATEGORY_ORDER = ['loadout', 'stats', 'trait', 'talents', 'modules'];

import { renderCustomEditor, renderCustomList } from './custom-operator.js';
// 潜能必须按官方每人的 potDown 表折算 —— 每个干员「潜能给什么」都不一样
// （有的降费用、有的降再部署、有的加攻），统一按 +2% 算必错。
import { atRank, hasPotentialData, POTENTIAL_MAX } from '../../../shared/potential.js';
import {
  PROFESSION_CN, SUB_PROFESSION_CN, subProfessionCn, professionCn, moduleTypeCn, skillKeyCn,
} from './tables.js';

const el = (id) => document.getElementById(id);
const listEl = el('ops-list');
const detailEl = el('ops-detail');
const searchEl = el('ops-search');
const onlyEl = el('ops-only-edited');
const countEl = el('ops-count');
const resetAllEl = el('ops-reset-all');
const revertBarEl = el('ops-revert');
const profEl = el('ops-prof');
const rarityEl = el('ops-rarity');
const moduleEl = el('ops-module');
const subProfEl = el('ops-subprof');

let native = {};      // 官方原表
let edited = {};      // 覆盖表
let skinsByChar = {}; // charId -> [{id,name,art,artB}]（来自解包出来的 data/local-skins.json）
let selected = null;
let keyword = '';
let onlyEdited = false;
let filterProf = '';
let filterRarity = '0';
let filterModule = 'any';
let filterSub = '';

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
  fillSubProfessions();
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

/** 把数据里出现过的子职业填进筛选下拉（按职业分组，用中文名显示）。 */
function fillSubProfessions() {
  if (!subProfEl) return;
  const seen = new Map();      // subId -> profession
  for (const rec of Object.values(native)) {
    const id = rec?.subProfessionId;
    if (id && !seen.has(id)) seen.set(id, rec.profession || '');
  }
  const groups = {};
  for (const [id, prof] of seen) {
    (groups[prof] = groups[prof] || []).push(id);
  }
  const keep = filterSub;
  const parts = ['<option value="">全部子职业</option>'];
  for (const prof of Object.keys(PROFESSIONS)) {
    const ids = groups[prof];
    if (!ids || !ids.length) continue;
    const opts = ids
      .sort((a, b) => subProfessionCn(a).localeCompare(subProfessionCn(b), 'zh-Hans-CN'))
      .map((id) => `<option value="${esc(id)}"${id === keep ? ' selected' : ''}>${esc(subProfessionCn(id))}</option>`)
      .join('');
    parts.push(`<optgroup label="${esc(professionCn(prof))}">${opts}</optgroup>`);
  }
  subProfEl.innerHTML = parts.join('');
}

/* ---- 列表 + 筛选 ------------------------------------------------------------------------------ */

function passes(id) {
  const rec = native[id] || {};
  if (onlyEdited && !hasEdits(id)) return false;
  if (filterProf && rec.profession !== filterProf) return false;
  if (filterSub && rec.subProfessionId !== filterSub) return false;
  if (filterRarity !== '0' && String(rec.rarity) !== filterRarity) return false;
  if (filterModule !== 'any') {
    const n = Array.isArray(rec.modules) ? rec.modules.length : 0;
    if (filterModule === 'has' && n === 0) return false;
    if (filterModule === 'none' && n > 0) return false;
  }
  if (keyword) {
    const hay = `${rec.name || ''} ${id} ${rec.charId || ''} ${PROFESSIONS[rec.profession] || ''}`.toLowerCase();
    if (!hay.includes(keyword)) return false;
  }
  return true;
}

function renderList({ keepScroll = true } = {}) {
  // 点击某个干员只该高亮变化，不该把列表滚回顶部 —— 所以重建前记住位置、重建后放回去。
  const prevTop = keepScroll ? listEl.scrollTop : 0;
  const ids = Object.keys(native).sort((a, b) => {
    const na = native[a]?.name || '', nb = native[b]?.name || '';
    return na.localeCompare(nb, 'zh-Hans-CN') || a.localeCompare(b);
  });
  const shown = ids.filter(passes);
  const changed = ids.filter(hasEdits).length;
  countEl.textContent = `显示 ${shown.length} / ${ids.length} · 已改 ${changed}`;
  resetAllEl.disabled = changed === 0;

  const frag = document.createDocumentFragment();
  for (const id of shown) {
    const rec = native[id] || {};
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ops__item${id === selected ? ' is-on' : ''}`;
    btn.dataset.id = id;
    const cats = editedCats(id);
    btn.innerHTML = `<span class="ops__item__name">${esc(rec.name || id)}</span>`
      + `<span class="ops__item__meta">${esc(professionCn(rec.profession))}</span>`
      + (cats.length ? `<span class="ops__flag">已改</span>` : '');
    li.append(btn);
    frag.append(li);
  }
  listEl.replaceChildren(frag);
  if (keepScroll) listEl.scrollTop = prevTop;
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
    // 潜能默认 0（官方表里没这一项，但玩家想按 0-6 潜改数值时会用到）
    const dflt = key === 'potRank' ? 0 : '';
    const showCur = cur === undefined || cur === null ? dflt : cur;
    const showOrigin = o === undefined || o === null ? dflt : o;
    cell.innerHTML = `<label for="${esc(id)}">${esc(shown)}<i class="ops__key">${esc(key)}</i></label>`
      + `<input id="${esc(id)}" type="number" step="any" data-kv="${esc(pathPrefix)}" data-key="${esc(key)}"`
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
    modBox.insertAdjacentHTML('beforeend', '<p class="ops__hint">这个干员没有模组。' + (rec.module && rec.module.name ? `（官方表里记着一个「${esc(rec.module.name)}」，但本机没有它的属性数据，只能看不能装。）` : '') + '</p>');
  } else {
    const opts = ['<option value="none"' + (mid === 'none' ? ' selected' : '') + '>不装模组</option>']
      .concat(modules.map((m) => {
        const id = String(m.uniEquipId || '');
        const typeCn = m.typeName ? moduleTypeCn(m.typeName) : '';
        return `<option value="${esc(id)}"${id === mid ? ' selected' : ''}>${esc(m.name || id)}${typeCn ? ' · ' + esc(typeCn) : ''}</option>`;
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
  if (note) note.textContent = `按官方 potDown 表逐档回放，${potential} 潜时生效值如下。`;
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
  grid.innerHTML = rows || '<p class="ops__hint">这份数据里没有可折的主要数值。</p>';
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

  detailEl.replaceChildren();

  const title = document.createElement('div');
  title.className = 'ops__title';
  const subCn = subProfessionCn(rec.subProfessionId || '');
  title.innerHTML = `<h2>${esc(rec.name || selected)}</h2>`
    + `<span class="ops__prof">${esc(professionCn(rec.profession))}${subCn && subCn !== rec.profession ? ` · ${esc(subCn)}` : ''}</span>`
    + `<span class="ops__rarity">${RARITY_LABEL(rec.rarity)}</span>`
    + `<small>${esc(selected)}</small>`;
  detailEl.append(title);

  if (cats.length) {
    const banner = document.createElement('div');
    banner.className = 'ops__banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `<b>这位干员有改动。</b>已改的类别：${cats.map((c) => CATEGORY_LABEL[c]).join('、')}。`
      + '各块右上角可以只把某一块还原。'
      + '<button type="button" class="ops__banner-close" data-dismiss-banner aria-label="收起提示">×</button>';
    detailEl.append(banner);
  }

  // ⓪ 携带与潜能（这里存的是「携带技能 / 携带模组 / 潜能 / 皮肤」，
  //    独立于下面四类数值改动，可以单独还原）
  detailEl.append(section('携带与潜能', loadoutBody(rec, e.loadout || {}), 'loadout'));

  // ① 基础数值
  const statsBody = document.createElement('div');
  statsBody.append(kvGrid(STAT_FIELDS, rec.stats || {}, e.stats || {}, 'stats'));
  detailEl.append(section('基础数值', statsBody, 'stats'));

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
  detailEl.append(section('职业特性', traitBody, 'trait'));

  // ③ 天赋
  const talents = Array.isArray(rec.talents) ? rec.talents : [];
  const talBody = document.createElement('div');
  if (!talents.length) {
    const p = document.createElement('p');
    p.className = 'ops__hint';
    p.textContent = '这个干员没有天赋。';
    talBody.append(p);
  } else {
    talents.forEach((t, i) => {
      const conn = document.createElement('div');
      conn.className = 'ops__talent';
      const pairs = t.bb && Object.keys(t.bb).length ? Object.entries(t.bb).map(([k]) => [k, k]) : [];
      conn.innerHTML = `<h4>天赋 ${i + 1}${t.name ? ' · ' + esc(t.name) : ''}</h4>`
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
  }
  detailEl.append(section('天赋', talBody, 'talents'));

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
      box.innerHTML = `<h4>模组 · ${esc(m.name || uid)}`
        + `${m.typeName ? ` · ${esc(typeCn)}（${esc(m.typeName)}）` : ''}`
        + `${m.isDefault ? ' <i class="ops__modtag">默认</i>' : ''}</h4>`;

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
        const originAttr = { ...(m.attr || {}), ...(delta.attr || {}) };
        box.append(kvGrid(attrFields, originAttr, delta.attr || {}, `modules.${uid}.attr`));
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
  detailEl.append(section('模组', modBody, 'modules'));

  const actions = document.createElement('div');
  actions.className = 'ops__actions';
  actions.innerHTML = `<button type="button" class="is-primary" data-act="save">保存改动</button>`
    + `<button type="button" data-act="revert"${cats.length ? '' : ' disabled'}>还原这位干员的全部</button>`
    + '<span class="ops__status" role="status"></span>';
  detailEl.append(actions);
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
  const patches = { loadout: {}, stats: {}, trait: {}, talents: {}, modules: {} };

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

  for (const input of detailEl.querySelectorAll('input[data-kv]')) {
    const raw = input.value.trim();
    if (raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;

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
    setStatus('皮肤解包只能在 App 里用（浏览器里没有本机资源）', true);
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在解…';
  try {
    const msg = shell.extractSkins(charId);
    setStatus(msg || '正在解皮肤…');
    // 解包在后台线程跑，轮询到索引里出现这位干员为止（最多 30 秒）
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      await loadSkins();
      if ((skinsByChar[charId] || []).length) break;
    }
    await loadSkins();
    renderDetail();
    const n = (skinsByChar[charId] || []).length;
    setStatus(n ? `已解出 ${n} 套皮肤` : '这次没解出皮肤（这个干员可能只有默认皮肤）');
  } catch (err) {
    setStatus(err.message || '解包失败', true);
    btn.disabled = false;
    btn.textContent = label;
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
  selected = btn.dataset.id;
  // 只在现有节点上切换高亮，不重建列表（重建会让滚动位置归零，用户被弹回顶部）
  for (const el of listEl.querySelectorAll('[data-id]')) {
    el.classList.toggle('is-on', el.dataset.id === selected);
  }
  renderDetail();
});

searchEl.addEventListener('input', () => { keyword = (searchEl.value || '').trim().toLowerCase(); renderList({ keepScroll: false }); });
onlyEl.addEventListener('change', () => { onlyEdited = onlyEl.checked; renderList({ keepScroll: false }); });
profEl?.addEventListener('change', () => { filterProf = profEl.value; renderList({ keepScroll: false }); });
rarityEl?.addEventListener('change', () => { filterRarity = rarityEl.value; renderList({ keepScroll: false }); });
moduleEl?.addEventListener('change', () => { filterModule = moduleEl.value; renderList({ keepScroll: false }); });
subProfEl?.addEventListener('change', () => { filterSub = subProfEl.value; renderList({ keepScroll: false }); });

detailEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-dismiss-banner]')) {
    const b = detailEl.querySelector('.ops__banner');
    if (b) b.remove();
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
    paintPotential(detailEl, rec, Number(sel.value) || POTENTIAL_MAX);
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
  const v = input.value.trim() === '' ? null : Number(input.value);
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
  const potEl = detailEl.querySelector('input[data-key="potRank"]');
  const pot = potEl ? Math.max(0, Math.min(6, Number(potEl.value) || 0)) : 0;

  if (key === 'potRank') {
    // 官方潜能是 0~6（0 = 无潜，6 = 满潜）。超出范围要明说，别静默按 6 算。
    const clamped = Math.max(0, Math.min(6, v));
    const warnTxt = (v < 0 || v > 6) ? `（超出 0~6，折算按 ${clamped} 潜）` : '';
    nowEl.textContent = `当前 ${clamped} 潜${warnTxt}`;
    // 潜能一变，所有基础数值的折算提示都要重算
    refreshAllNow();
    return;
  }
  // 模组属性（path 里带 modules.*.attr）与天赋/特性一样只是独立数值，不参与潜能折算
  const isModuleAttr = input.dataset.kv.includes('.attr');
  const potable = !isModuleAttr && ['maxHp', 'atk', 'def'].includes(key) && !input.dataset.kv.startsWith('modules.');
  if (potable && pot > 0) {
    const scaled = v * (1 + 0.02 * pot);
    nowEl.textContent = `改后 ${round2(v)} → ${pot}潜折算 ${round2(scaled)}`;
  } else if (isModuleAttr) {
    // 模组的加成是「叠在干员基础数值上」的，单独标出来更清楚
    nowEl.textContent = `模组加成 ${round2(v)}`;
  } else {
    nowEl.textContent = `改后 ${round2(v)}`;
  }
}

const round2 = (n) => (Math.round(n * 100) / 100).toString();

/** 重算所有字段的「改后」提示（潜能变化时调用）。 */
function refreshAllNow() {
  for (const input of detailEl.querySelectorAll('input[data-kv]')) {
    const cell = input.closest('.ops__field');
    let origin = null;
    try { origin = cell && cell.dataset.origin ? JSON.parse(cell.dataset.origin) : null; } catch { origin = null; }
    const v = input.value.trim() === '' ? null : Number(input.value);
    updateNow(cell, input, origin, v);
  }
}

resetAllEl.addEventListener('click', () => {
  const cats = ['stats', 'trait', 'talents', 'modules'].filter(
    (c) => Object.keys(edited).some((id) => edited[id] && edited[id][c] && Object.keys(edited[id][c]).length),
  );
  if (!cats.length) { setStatus('现在没有任何改动可以还原'); return; }
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
    renderList();
    renderDetail();
  } catch (err) {
    countEl.textContent = '载入失败：' + (err.message || err);
    detailEl.replaceChildren();
    const p = document.createElement('p');
    p.className = 'ops__hint';
    p.textContent = '读不到干员表。请确认本地服务在运行。';
    detailEl.append(p);
  }
})();
