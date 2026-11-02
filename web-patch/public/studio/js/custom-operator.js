// public/studio/js/custom-operator.js — 「新增自定义干员」（实验功能）
//
// 玩家自己捏一位干员，存进 /api/custom-operators，服务端会把它并进 /data/aue-operators.json，
// 于是手牌、牌库、存档都当成普通干员用 —— 前端别处一行不用改。
//
// 实验功能的边界（页面上要写清楚）：
//   · 数值不做任何平衡校核，填多少就是多少；
//   · 技能只支持「数值型」的基础描述（伤害倍率、持续时间、技力消耗、目标数），
//     官方那套召唤物 / 复杂条件 / 多段位移不在支持范围内；
//   · 没有立绘与 Spine 小人，战斗里显示替代图标。

import { SUB_RANGES, SUB_PROFESSION, subRange } from './sub-ranges.js';
import { subProfessionCn } from './tables.js';

const PROFESSIONS = [
  ['PIONEER', '先锋'], ['WARRIOR', '近卫'], ['SNIPER', '狙击'], ['MEDIC', '医疗'],
  ['CASTER', '术师'], ['SPECIAL', '特种'], ['TANK', '重装'], ['SUPPORT', '辅助'],
];
const POSITIONS = [['MELEE', '近战'], ['RANGED', '远程'], ['ALL', '不限']];
const DMG_TYPES = [['PHYSICAL', '物理'], ['MAGICAL', '法术'], ['HEAL', '治疗'], ['NONE', '无']];

/** 基础数值字段（与 aue-operators.json 的 stats 对齐）。 */
const STATS = [
  ['maxHp', '生命上限', 1000], ['atk', '攻击', 300], ['def', '防御', 150],
  ['res', '法抗', 0], ['cost', '部署费用', 15], ['blockCnt', '阻挡数', 1],
  ['bat', '攻击间隔', 1.2], ['aspd', '攻速', 100], ['respawnTime', '再部署', 70],
  ['spRecovery', '技力回复', 1], ['hpRecoveryPerSec', '每秒回血', 0],
  ['moveSpeed', '移动速度', 1], ['tauntLevel', '嘲讽等级', 0], ['massLevel', '重量', 0],
];

/** 攻击范围：相对本格的偏移（行, 列），与官方 rangeGrid 同构。 */
const RANGE_PRESETS = [
  { id: 'melee', label: '本格', cells: [[0, 0]] },
  { id: 'melee3', label: '前方三格', cells: [[0, 1], [0, 2], [0, 3]] },
  { id: 'ranged', label: '远程十字', cells: [[0, 1], [0, 2], [0, 3], [0, 0]] },
  { id: 'ranged3x3', label: '前方九格', cells: [[0, 1], [0, 2], [0, 3], [-1, 1], [-1, 2], [-1, 3], [1, 1], [1, 2], [1, 3]] },
  { id: 'healer', label: '治疗范围', cells: [[0, 0], [0, 1], [0, 2], [-1, 0], [-1, 1], [-1, 2], [1, 0], [1, 1], [1, 2]] },
];

/**
 * 攻击范围的三种给法：
 *   preset —— 用上面那 5 个模板（最快）
 *   sub    —— 沿用所选子职业的官方范围（最省事，也最不容易画歪）
 *   custom —— 自己在格子上点出来
 */
const RANGE_MODES = [
  ['sub', '沿用子职业范围'],
  ['preset', '用模板'],
  ['custom', '自己画'],
];

/** 自定义范围编辑器的画布：7 行 × 5 列，第 4 行第 3 列是干员自己。 */
const GRID_ROWS = 7;
const GRID_COLS = 5;
const GRID_SELF = { r: 3, c: 2 };

const el = (id) => document.getElementById(id);

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

/** 生成一个不重复的 chessId。 */
function newId(name) {
  const slug = String(name || 'diy').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'diy';
  const rnd = Math.random().toString(36).slice(2, 7);
  return `chess_diy_${slug}_${rnd}`;
}

/* ---- 表单 ------------------------------------------------------------------------------------- */

function fieldRow(key, label, type, value) {
  return `<div class="ops__field"><label for="c-${key}">${esc(label)}</label>
    <input id="c-${key}" type="${type}" step="any" data-field="${key}" value="${esc(value)}"></div>`;
}

function selectRow(key, label, choices, value) {
  return `<div class="ops__field"><label for="c-${key}">${esc(label)}</label>
    <select id="c-${key}" data-field="${key}">${choices.map(([id, nm]) =>
      `<option value="${esc(id)}"${value === id ? ' selected' : ''}>${esc(nm)}</option>`).join('')}</select></div>`;
}

export function renderCustomEditor(mount, { record = null, onSaved, onCancel } = {}) {
  const rec = record || {};
  const stats = rec.stats || {};
  const skills = Array.isArray(rec.skills) ? rec.skills : [];
  const rangeId = rec.rangePreset || 'melee';
  // 子职业：没填就按职业推一个（同一个职业里第一个分支），保证下拉框永远有选中项
  const startProfession = rec.profession || 'WARRIOR';
  const subsOf = (prof) => Object.keys(SUB_RANGES).filter((id) => (SUB_PROFESSION[id] || '') === prof);
  const startSub = rec.subProfessionId
    || subsOf(startProfession)[0] || '';
  // 范围模式：老记录里只有 rangePreset，就当成 preset；新记录带 rangeMode
  const rangeMode = rec.rangeMode
    || (rec.rangeGrid && !rec.rangePreset ? 'custom' : (rec.subProfessionId ? 'sub' : 'preset'));
  // 自己画的格子：rangeGrid 存的是「相对干员自己的偏移」（[0,0] = 自己那格），
  // 画布用的是绝对格子坐标，两者差一个 GRID_SELF 偏移。
  const customCells = Array.isArray(rec.rangeGrid) && rec.rangeGrid.length
    ? rec.rangeGrid.map(([r, c]) => `${r + GRID_SELF.r},${c + GRID_SELF.c}`)
    : [];

  const statsHtml = STATS.map(([k, label, def]) => fieldRow(k, label, 'number',
    stats[k] !== undefined ? stats[k] : def)).join('');

  mount.innerHTML = `
    <section class="ops__sec" data-custom-editor>
      <header class="ops__sec-head"><h3>新建自定义干员</h3>
        <button type="button" class="ops__mini" data-custom="cancel">取消</button></header>
      <div class="ops__custom-warn">
        <b>实验功能。</b>数值不做平衡校核，填多少就是多少；技能只支持数值型的基础描述
        （伤害倍率 / 持续时间 / 技力消耗 / 目标数），官方那套召唤物与复杂条件不支持；
        没有立绘与小人，战斗里显示替代图标。
      </div>

      <h5>基本信息</h5>
      <div class="ops__grid">
        ${fieldRow('name', '名字（必填）', 'text', rec.name || '')}
        ${fieldRow('appellation', '英文名', 'text', rec.appellation || '')}
        ${selectRow('profession', '职业', PROFESSIONS, startProfession)}
        <div class="ops__field"><label for="c-subProfessionId">子职业（分支）</label>
          <select id="c-subProfessionId" data-field="subProfessionId">${subsOf(startProfession).map((id) =>
            `<option value="${esc(id)}"${startSub === id ? ' selected' : ''}>${esc(subProfessionCn(id))} · ${esc(id)}</option>`).join('')}</select>
        </div>
        ${selectRow('position', '位置', POSITIONS, rec.position || 'MELEE')}
        ${selectRow('dmgType', '伤害类型', DMG_TYPES, rec.dmgType || 'PHYSICAL')}
        ${fieldRow('rarity', '星级（1-6）', 'number', rec.rarity || 4)}
        ${fieldRow('tier', '费用档位', 'number', rec.tier || 4)}
      </div>

      <h5>基础数值</h5>
      <div class="ops__grid">${statsHtml}</div>

      <h5>攻击范围</h5>
      <div class="ops__grid">
        <div class="ops__field"><label for="c-rangeMode">怎么定</label>
          <select id="c-rangeMode" data-field="rangeMode">${RANGE_MODES.map(([id, nm]) =>
            `<option value="${esc(id)}"${rangeMode === id ? ' selected' : ''}>${esc(nm)}</option>`).join('')}</select>
        </div>
        <div class="ops__field" data-range-panel="preset"><label for="c-rangePreset">范围模板</label>
          <select id="c-rangePreset" data-field="rangePreset">${RANGE_PRESETS.map((r) =>
            `<option value="${esc(r.id)}"${rangeId === r.id ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
        </div>
      </div>
      <p class="ops__hint" data-range-note></p>
      <div class="ops__rangegrid" data-range-canvas hidden></div>

      <h5>技能（可选，最多 3 个）</h5>
      <div data-skills></div>
      <button type="button" class="ops__mini" data-custom="add-skill">＋ 添加一个技能</button>

      <div class="ops__actions">
        <button type="button" class="is-primary" data-custom="save">保存这个干员</button>
        <span class="ops__status" role="status"></span>
      </div>
    </section>`;

  const skillsHost = mount.querySelector('[data-skills]');
  let skillCount = 0;

  /* ---- 攻击范围：三种给法的联动 ------------------------------------------------------------ */

  const canvas = mount.querySelector('[data-range-canvas]');
  const note = mount.querySelector('[data-range-note]');
  const rangeModeSel = mount.querySelector('[data-field="rangeMode"]');
  const presetPanel = mount.querySelector('[data-range-panel="preset"]');
  let picked = new Set(customCells);

  /** 当前选中的子职业范围（没子职业就给本格）。 */
  function currentSubRange() {
    const sub = mount.querySelector('[data-field="subProfessionId"]')?.value || '';
    const cells = subRange(sub);
    return cells.length ? cells : [[0, 0]];
  }

  /** 把格子画成 7×5 的可点击网格。 */
  function paintCanvas() {
    if (!canvas) return;
    const cells = [];
    for (let r = 0; r < GRID_ROWS; r += 1) {
      for (let c = 0; c < GRID_COLS; c += 1) {
        const self = r === GRID_SELF.r && c === GRID_SELF.c;
        const on = self || picked.has(`${r},${c}`);
        cells.push(`<button type="button" class="ops__cell${on ? ' is-on' : ''}${self ? ' is-self' : ''}"
          data-cell="${r},${c}" aria-pressed="${on ? 'true' : 'false'}"
          title="${self ? '干员自己站的位置' : `第 ${r + 1} 行第 ${c + 1} 列`}">${self ? '干员' : ''}</button>`);
      }
    }
    canvas.innerHTML = cells.join('');
  }

  /** 按模式切换面板的可见性，并把提示写成人话。 */
  function syncRangeUi() {
    const mode = rangeModeSel?.value || 'sub';
    if (presetPanel) presetPanel.hidden = mode !== 'preset';
    if (canvas) canvas.hidden = mode !== 'custom';
    if (note) {
      if (mode === 'sub') {
        const cells = currentSubRange();
        note.textContent = `沿用子职业范围：${cells.length} 格。改子职业会跟着变。`;
      } else if (mode === 'preset') {
        note.textContent = '模板范围：本格 / 前方三格 / 远程十字 / 前方九格 / 治疗范围。';
      } else {
        note.textContent = '点格子画出攻击范围（干员自己那格固定包含）。';
      }
    }
    if (mode === 'custom') paintCanvas();
  }

  /** 子职业下拉框按当前职业重建（切职业时不能留着别的职业的分支）。 */
  function syncSubSelect() {
    const prof = mount.querySelector('[data-field="profession"]')?.value || 'WARRIOR';
    const sel = mount.querySelector('[data-field="subProfessionId"]');
    if (!sel) return;
    const keep = sel.value;
    const ids = subsOf(prof);
    sel.innerHTML = ids.map((id) =>
      `<option value="${esc(id)}">${esc(subProfessionCn(id))} · ${esc(id)}</option>`).join('');
    if (ids.includes(keep)) sel.value = keep;
    else if (ids.length) sel.value = ids[0];
    syncRangeUi();
  }

  canvas?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cell]');
    if (!btn) return;
    const [r, c] = btn.dataset.cell.split(',').map(Number);
    if (r === GRID_SELF.r && c === GRID_SELF.c) return;      // 自己那格不给取消
    const key = btn.dataset.cell;
    if (picked.has(key)) picked.delete(key); else picked.add(key);
    paintCanvas();
  });

  syncRangeUi();

  function addSkill(sk = null) {
    if (skillCount >= 3) return;
    skillCount += 1;
    const i = skillCount;
    const box = document.createElement('div');
    box.className = 'ops__module';
    box.dataset.skill = String(i);
    box.innerHTML = `<h4>技能 ${i}${sk?.name ? ' · ' + esc(sk.name) : ''}</h4>
      <div class="ops__grid">
        <div class="ops__field"><label>名称</label><input type="text" data-sk="name" value="${esc(sk?.name || '')}"></div>
        <div class="ops__field"><label>技力消耗</label><input type="number" step="any" data-sk="spCost" value="${esc(sk?.spCost ?? 20)}"></div>
        <div class="ops__field"><label>持续时间（秒）</label><input type="number" step="any" data-sk="duration" value="${esc(sk?.duration ?? 15)}"></div>
        <div class="ops__field"><label>伤害倍率</label><input type="number" step="any" data-sk="atkScale" value="${esc(sk?.atkScale ?? 1.5)}"></div>
        <div class="ops__field"><label>目标数</label><input type="number" step="1" data-sk="targets" value="${esc(sk?.targets ?? 1)}"></div>
        <div class="ops__field"><label>描述</label><input type="text" data-sk="desc" value="${esc(sk?.desc || '')}"></div>
      </div>
      <button type="button" class="ops__mini" data-custom="del-skill">删除这个技能</button>`;
    skillsHost.append(box);
  }

  // 已有技能回填
  for (const sk of skills.slice(0, 3)) addSkill(sk);

  const status = () => mount.querySelector('.ops__status');
  const setStatus = (t, bad = false) => {
    const s = status();
    if (!s) return;
    s.textContent = t;
    s.classList.toggle('is-bad', bad);
  };

  mount.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-custom]');
    if (!btn) return;
    const act = btn.dataset.custom;

    if (act === 'cancel') { onCancel?.(); return; }

    if (act === 'add-skill') { addSkill(); return; }

    if (act === 'del-skill') {
      const box = btn.closest('[data-skill]');
      if (box) { box.remove(); skillCount = Math.max(0, skillCount - 1); }
      return;
    }

    if (act === 'save') {
      const get = (k) => mount.querySelector(`[data-field="${k}"]`)?.value?.trim() ?? '';
      const name = get('name');
      if (!name) { setStatus('请先填名字', true); return; }

      // 范围按当前模式算：沿用子职业 / 模板 / 自己画
      const mode = get('rangeMode') || 'sub';
      let range;
      if (mode === 'sub') {
        range = currentSubRange();
      } else if (mode === 'custom') {
        // 画布坐标 → 相对干员的偏移
        range = [...picked].map((k) => k.split(',').map(Number))
          .filter(([r, c]) => !(r === GRID_SELF.r && c === GRID_SELF.c))
          .map(([r, c]) => [r - GRID_SELF.r, c - GRID_SELF.c]);
        range.unshift([0, 0]);
        if (range.length < 2) { setStatus('自己画的范围至少要再点一格', true); return; }
      } else {
        range = (RANGE_PRESETS.find((r) => r.id === get('rangePreset')) || RANGE_PRESETS[0]).cells;
      }

      const outStats = {};
      for (const [k] of STATS) {
        const v = Number(get(k));
        if (Number.isFinite(v)) outStats[k] = v;
      }

      const outSkills = [];
      for (const box of skillsHost.querySelectorAll('[data-skill]')) {
        const name2 = box.querySelector('[data-sk="name"]')?.value?.trim();
        if (!name2) continue;
        outSkills.push({
          name: name2,
          spCost: Number(box.querySelector('[data-sk="spCost"]')?.value) || 20,
          duration: Number(box.querySelector('[data-sk="duration"]')?.value) || 15,
          atkScale: Number(box.querySelector('[data-sk="atkScale"]')?.value) || 1.5,
          targets: Number(box.querySelector('[data-sk="targets"]')?.value) || 1,
          desc: box.querySelector('[data-sk="desc"]')?.value?.trim() || '',
        });
      }

      const chessId = rec.chessId || newId(name);
      const record2 = {
        chessId,
        baseId: chessId,
        charId: rec.charId || chessId,
        name,
        appellation: get('appellation') || name,
        rarity: Number(get('rarity')) || 4,
        tier: Number(get('tier')) || 4,
        profession: get('profession') || 'WARRIOR',
        subProfessionId: get('subProfessionId') || null,
        subProfessionName: subProfessionCn(get('subProfessionId') || '') || null,
        rangeMode: mode,
        position: get('position') || 'MELEE',
        dmgType: get('dmgType') || 'PHYSICAL',
        status: rec.status || { phase: 2, level: 80, skillLevel: 10, equipLevel: 3 },
        stats: outStats,
        rangeGrid: range,
        isDiy: true,
        custom: true,
        skills: outSkills,
        skill: outSkills.length ? { ...outSkills[0], index: 1 } : null,
      };

      try {
        await api(`/api/custom-operators/${encodeURIComponent(chessId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record2),
        });
        setStatus('已保存：' + name);
        onSaved?.(record2);
      } catch (err) {
        setStatus(err.message || '保存失败', true);
      }
    }
  });

  // 下拉框联动：换职业要重建子职业列表，换子职业/模式要刷新范围面板
  mount.addEventListener('change', (e) => {
    const field = e.target.dataset.field;
    if (field === 'profession') { syncSubSelect(); return; }
    if (field === 'subProfessionId' || field === 'rangeMode') { syncRangeUi(); return; }
    if (field === 'rangePreset') {
      setStatus(`范围：${RANGE_PRESETS.find((r) => r.id === e.target.value)?.label || ''}`);
    }
  });
}

/** 列出已有自定义干员（带删除）。 */
export async function renderCustomList(mount, { onChange } = {}) {
  let data;
  try {
    data = await api('/api/custom-operators');
  } catch (err) {
    mount.innerHTML = `<p class="ops__hint">读不到自定义干员表：${esc(err.message || err)}</p>`;
    return;
  }
  const ops = (data && data.operators) || {};
  const ids = Object.keys(ops);
  if (!ids.length) {
    mount.innerHTML = '<p class="ops__hint">还没有自定义干员。</p>';
    return;
  }
  mount.innerHTML = `<h5>已建的自定义干员（${ids.length}）</h5>
    <ul class="ops__custom-list">${ids.map((id) => {
      const r = ops[id] || {};
      return `<li data-cid="${esc(id)}"><b>${esc(r.name || id)}</b>
        <small>${esc(PROFESSIONS.find(([p]) => p === r.profession)?.[1] || r.profession || '')} · ${esc(id)}</small>
        <button type="button" class="ops__mini" data-custom-del="${esc(id)}">删除</button></li>`;
    }).join('')}</ul>`;

  mount.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-custom-del]');
    if (!btn) return;
    const id = btn.dataset.customDel;
    if (!window.confirm('删除这个自定义干员？')) return;
    try {
      await api(`/api/custom-operators/${encodeURIComponent(id)}`, { method: 'DELETE' });
      onChange?.();
    } catch (err) {
      alert('删除失败：' + (err.message || err));
    }
  }, { once: false });
}
