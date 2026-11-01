// public/studio/js/operators.js — 干员数值编辑器（/studio/operators.html）
//
// 四类可改的东西，各自独立存在、独立还原：
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

const CATEGORY_LABEL = { stats: '基础数值', trait: '职业特性', talents: '天赋', modules: '模组' };

import { renderCustomEditor, renderCustomList } from './custom-operator.js';
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
const profEl = el('ops-prof');
const rarityEl = el('ops-rarity');
const moduleEl = el('ops-module');
const subProfEl = el('ops-subprof');

let native = {};      // 官方原表
let edited = {};      // 覆盖表
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
  return ['stats', 'trait', 'talents', 'modules'].some((c) => e[c] && Object.keys(e[c]).length);
};
const editedCats = (id) => {
  const e = edited[id] || {};
  return ['stats', 'trait', 'talents', 'modules'].filter((c) => e[c] && Object.keys(e[c]).length);
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
  fillSubProfessions();
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

function collectPatches() {
  const patches = { stats: {}, trait: {}, talents: {}, modules: {} };
  for (const input of detailEl.querySelectorAll('input[data-kv]')) {
    if (!input.classList.contains('is-changed')) continue;   // 只提交真改过的
    const raw = input.value.trim();
    if (raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
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

async function revertAll() {
  const cats = ['stats', 'trait', 'talents', 'modules'].filter(
    (c) => Object.keys(edited).some((id) => edited[id] && edited[id][c] && Object.keys(edited[id][c]).length),
  );
  if (!cats.length) return;
  const choice = window.prompt(
    '要还原哪些改动？\n1 = 全部\n2 = 只还原基础数值\n3 = 只还原职业特性\n4 = 只还原天赋\n5 = 只还原模组',
    '1',
  );
  if (!choice) return;
  const map = { '1': null, '2': 'stats', '3': 'trait', '4': 'talents', '5': 'modules' };
  if (!(choice in map)) { setStatus('输入无效，已取消', true); return; }
  const cat = map[choice];
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
    nowEl.textContent = `当前 ${v} 潜`;
    // 潜能一变，所有基础数值的折算提示都要重算
    refreshAllNow();
    return;
  }
  const potable = ['maxHp', 'atk', 'def'].includes(key);
  if (potable && pot > 0) {
    const scaled = v * (1 + 0.02 * pot);
    nowEl.textContent = `改后 ${round2(v)} → ${pot}潜折算 ${round2(scaled)}`;
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

resetAllEl.addEventListener('click', revertAll);

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
