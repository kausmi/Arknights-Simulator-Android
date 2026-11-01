// public/sandbox/js/ui/picker.js — 干员选择器（从 hud.js 抽出）。
import { esc } from './html.js';
import { PROFESSIONS } from '../operator-library.js';
import { avatar } from '../asset-urls.js';
import { createAutoScroll } from './auto-scroll.js';

// 多选：勾起来的人先攒着，点「加入」一次性全部进手牌。
// 放在模块级而不是 refs 上，重绘/切筛选都不会丢。
let multiSel = new Set();
let multiOn = false;

export function resetMultiPick() { multiSel = new Set(); multiOn = false; }
export function multiPicked() { return [...multiSel]; }
export function toggleMulti() { multiOn = !multiOn; if (!multiOn) multiSel = new Set(); return multiOn; }
/** 多选模式开着吗。 */
export function multiActive() { return multiOn; }
/** 勾上 / 取消一个；返回勾上后的状态（true = 现在已选）。 */
export function togglePick(id) {
  if (multiSel.has(id)) { multiSel.delete(id); return false; }
  multiSel.add(id);
  return true;
}

export function setPicker(refs, on) {
  refs.picker.classList.toggle('is-on', !!on);
  if (!on) refs._pickerAuto?.setEnabled(false);
}

/**
 * 选人器：自设干员与明确开放的支援，后接尚未接入的槽位。
 * @param {Array<{id,name,charId,rarity,prof}>} ops
 * @param {Array<{name:string,owner:string}>} [reserve]
 */
export function renderPicker(refs, ops, filter = '', reserve = []) {
  refs._pickerAuto ||= createAutoScroll(refs.pkGrid, refs.pkAuto);
  const q = filter.trim();
  const prof = refs._pickerProfession || '';
  if (!refs.pkProfessions) {
    refs.pkProfessions = document.createElement('nav'); refs.pkProfessions.className = 'pk__professions';
    refs.pkGrid.before(refs.pkProfessions);
    refs.pkProfessions.onclick = (e) => { const b = e.target.closest('[data-prof]'); if (!b) return; refs._pickerProfession = b.dataset.prof; renderPicker(refs, ops, refs.pkSearch.value, reserve); };
  }
  refs.pkProfessions.innerHTML = PROFESSIONS.map(([id, name]) => `<button class="dbtn${id === prof ? ' is-on' : ''}" data-prof="${id}">${name}</button>`).join('');
  const list = ops.filter((o) => (!prof || o.profession === prof) && (!q || o.name.includes(q) || o.id.includes(q)));
  const ready = list.map((o) => {
    const picked = multiSel.has(o.id);
    return `<button class="pk__op${picked ? ' is-picked' : ''}" data-act="picker-pick" data-id="${esc(o.id)}"
      title="${esc(o.name)} · ${esc(o.prof)} · ${esc(o.role || '')}">
    <img src="${esc(avatar(o.charId))}" alt="" loading="lazy" /><span>${esc(o.name)}</span>
    ${multiOn ? `<i class="pk__check">${picked ? '✓' : ''}</i>` : ''}
  </button>`;
  }).join('');
  const slots = q ? '' : reserve.map((r) => `<div class="pk__op pk__op--hold" title="${esc(r.owner)}">
    <i class="pk__ph">预留</i><span>${esc(r.name)}</span>
  </div>`).join('');
  refs.pkGrid.innerHTML = ready + slots
    || '<p class="dr__hint">没有匹配的干员。</p>';
  refs.pkGrid.scrollTop = 0;

  // 多选区底栏：开关 + 已选数量 + 一起加入
  const bar = refs.pkGrid.parentElement?.querySelector('[data-multi-bar]');
  if (bar) {
    bar.innerHTML = `<button type="button" class="pk__multi${multiOn ? ' is-on' : ''}" data-act="picker-multi">
        ${multiOn ? '多选中' : '多选'}</button>`
      + (multiOn
        ? `<span class="pk__multicount">已选 ${multiSel.size}</span>
           <button type="button" class="pk__multiadd" data-act="picker-multiadd"${multiSel.size ? '' : ' disabled'}>全部加入手牌</button>`
        : '');
  }
}
