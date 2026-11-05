// public/sandbox/js/ui/picker.js — 干员选择器（从 hud.js 抽出）。
//
// 0.1.16 重做：卡片结构从「img + span」改成「.pk__ava 画框 + .pk__body 两行」。
//
//   为什么要给 img 套一层画框：<img> 是替换元素，`height` 为 auto 时浏览器用图片自身的
//   固有宽高比算高度，CSS 的 `aspect-ratio` 不参与 —— 于是 768×1024 的半身立绘会把
//   格子撑到 1024 高，溢到相邻格子、叠成一团，`object-fit: cover` 也救不回来。
//   把 aspect-ratio 放在普通元素 `.pk__ava` 上、img 绝对定位铺满它，才是可靠的裁法。
//
//   兼容性：按钮仍然是 `button.pk__op[data-act="picker-pick"][data-id]`，
//   多选区底栏仍然在 `[data-multi-bar]`，搜索框仍由 shell.js 提供 ——
//   controller.js 的事件委托与 `refs.picker.querySelector('.pk__head h2')` 都依赖它们。
import { esc } from './html.js';
import { PROFESSIONS } from '../operator-library.js';
import { avatar, rarityColor } from '../asset-urls.js';
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

/** 一张干员卡片。 */
function card(o, picked) {
  const rarity = Number(o.rarity) || 1;
  const meta = [o.prof, o.cost ? `${o.cost}费` : ''].filter(Boolean).join(' · ');
  return `<button class="pk__op${picked ? ' is-picked' : ''}" data-act="picker-pick" data-id="${esc(o.id)}"
      title="${esc(o.name)} · ${esc(o.prof || '')} · ${esc(o.role || '')}"
      style="--pk-rarity:${rarityColor(rarity)}">
    <span class="pk__ava"><img src="${esc(avatar(o.charId))}" alt="" loading="lazy" decoding="async" /></span>
    <span class="pk__body">
      <span class="pk__name">${esc(o.name)}</span>
      ${meta ? `<span class="pk__meta"><i></i>${esc(meta)}</span>` : ''}
    </span>
    ${multiOn ? `<i class="pk__check">${picked ? '✓' : ''}</i>` : ''}
  </button>`;
}

/**
 * 选人器：自设干员与明确开放的支援，后接尚未接入的槽位。
 * @param {Array<{id,name,charId,rarity,prof,profession,cost,role}>} ops
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
  const ready = list.map((o) => card(o, multiSel.has(o.id))).join('');
  const slots = q ? '' : reserve.map((r) => `<div class="pk__op pk__op--hold" title="${esc(r.owner)}">
    <i class="pk__ph">预留</i><span class="pk__body"><span class="pk__name">${esc(r.name)}</span></span>
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
