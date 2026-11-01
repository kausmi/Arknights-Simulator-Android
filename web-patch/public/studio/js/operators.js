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

const PROFESSIONS = {
  PIONEER: '先锋', WARRIOR: '近卫', SNIPER: '狙击', MEDIC: '医疗',
  CASTER: '术师', SPECIAL: '特种', TANK: '重装', SUPPORT: '辅助',
};
const RARITY_LABEL = (r) => '★'.repeat(Math.max(1, Math.min(6, Number(r) || 1)));

/** 基础数值的可编辑字段。 */
const STAT_FIELDS = [
  ['maxHp', '生命上限'], ['atk', '攻击'], ['def', '防御'], ['res', '法抗'],
  ['cost', '部署费用'], ['blockCnt', '阻挡数'], ['bat', '攻击间隔'], ['aspd', '攻速'],
  ['respawnTime', '再部署'], ['spRecovery', '技力回复'], ['hpRecoveryPerSec', '每秒回血'],
  ['moveSpeed', '移动速度'], ['tauntLevel', '嘲讽等级'], ['massLevel', '重量等级'],
];

/** 模组属性可编辑字段。 */
const MODULE_ATTR_FIELDS = ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'aspd', 'respawnTime'];

const CATEGORY_LABEL = { stats: '基础数值', trait: '职业特性', talents: '天赋', modules: '模组' };

import { renderCustomEditor, renderCustomList } from './custom-operator.js';

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

let native = {};      // 官方原表
let edited = {};      // 覆盖表
let selected = null;
let keyword = '';
let onlyEdited = false;
let filterProf = '';
let filterRarity = '0';
let filterModule = 'any';

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
}

/* ---- 列表 + 筛选 ------------------------------------------------------------------------------ */

function passes(id) {
  const rec = native[id] || {};
  if (onlyEdited && !hasEdits(id)) return false;
  if (filterProf && rec.profession !== filterProf) return false;
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

function renderList() {
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
      + `<span class="ops__item__meta">${esc(PROFESSIONS[rec.profession] || '')}</span>`
      + (cats.length ? `<span class="ops__flag">已改</span>` : '');
    li.append(btn);
    frag.append(li);
  }
  listEl.replaceChildren(frag);
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
    cell.innerHTML = `<label for="${esc(id)}">${esc(label)}</label>`
      + `<input id="${esc(id)}" type="number" step="any" data-kv="${esc(pathPrefix)}" data-key="${esc(key)}"`
      + ` value="${esc(num(cur, ''))}"${p !== undefined ? ' class="is-changed"' : ''}>`
      + `<span class="ops__origin">原值 ${esc(num(o))}</span>`;
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
  title.innerHTML = `<h2>${esc(rec.name || selected)}</h2>`
    + `<span class="ops__prof">${esc(PROFESSIONS[rec.profession] || rec.profession || '')}</span>`
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
      box.innerHTML = `<h4>模组 · ${esc(m.name || uid)}${m.typeName ? '（' + esc(m.typeName) + '）' : ''}`
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
  renderList();
  renderDetail();
});

searchEl.addEventListener('input', () => { keyword = (searchEl.value || '').trim().toLowerCase(); renderList(); });
onlyEl.addEventListener('change', () => { onlyEdited = onlyEl.checked; renderList(); });
profEl?.addEventListener('change', () => { filterProf = profEl.value; renderList(); });
rarityEl?.addEventListener('change', () => { filterRarity = rarityEl.value; renderList(); });
moduleEl?.addEventListener('change', () => { filterModule = moduleEl.value; renderList(); });

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
});

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
