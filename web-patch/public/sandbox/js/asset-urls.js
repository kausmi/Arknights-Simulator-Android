// HUD 图片地址：data/assets.json 的登记素材与完整立绘登记表。
//   干员头像 / 立绘      assets.avatar(charId) / assets.portrait(charId, {e2})
//   技能图标             assets.skillIcon(skillId)（自设干员没注册就返回 null，由 hud.js 画占位）
//   敌人小图标           assets.enemyIcon(enemyKey)
//   HUD 底板 / 血条 / 星级 assets.ui('hudPanel/bg_battle') 等（这些在 sandbox.css 里直接写死路径，不经过这里）
// 拿不到图时返回 FD_AVATAR（一枚灰底剪影 data URI），绝不出现裂图。

import { OPERATOR_ILLUSTRATIONS } from './generated-illustrations.js';

let store = null;
export const portraitFrame = (charId) => OPERATOR_ILLUSTRATIONS[charId] || null;

export function useAssets(a) { store = a; }

// 玩家在「干员详情」里给某位干员选的立绘（覆盖表的 loadout.art）：
//   'e0' 精一 / 'e2' 精二 / 其它 = skinpack 解出来的皮肤 id。
// 皮肤索引来自 /data/local-skins.json（extract_skins.py 写），选中项来自 /data/operator-art.json。
let artPicks = {};
let artSkins = {};
export function useArtState(next) {
  if (!next || typeof next !== 'object') return;
  if (next.picks && typeof next.picks === 'object') artPicks = next.picks;
  if (next.skins && typeof next.skins === 'object') artSkins = next.skins;
}
const pickOf = (charId) => (charId && artPicks[charId]) || '';
const skinOf = (charId, id) => {
  const list = artSkins[charId];
  if (!Array.isArray(list)) return null;
  return list.find((s) => s && String(s.id) === String(id)) || null;
};

const FD_AVATAR = 'data:image/svg+xml;utf8,'
  + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>"
    + "<rect width='100' height='100' fill='#1c2024'/>"
    + "<circle cx='50' cy='37' r='15' fill='#3a4046'/>"
    + "<path d='M17 100c0-18 14-31 33-31s33 13 33 31z' fill='#3a4046'/></svg>");

export const FALLBACK = FD_AVATAR;

const safe = (fn, ...a) => { try { return fn(...a) || null; } catch { return null; } };

// 兜底：data/assets.json 里登记的路径是「官方客户端有、本机不一定有」的。
// 提取只覆盖本机 chararts/ 里真实存在的 bundle，缺的那几个（阿米娅的老 id、自设干员等）
// URL 是真字符串但文件 404 —— img 就显示成裂图。这里在捕获阶段统一接管：
// 任何 <img> 加载失败都换成灰剪影，绝不出现「图片损坏」图标。
if (typeof window !== 'undefined' && !window.__arksimImgGuard) {
  window.__arksimImgGuard = true;
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG' || t.dataset.fallbackApplied) return;
    t.dataset.fallbackApplied = '1';
    t.src = FD_AVATAR;
  }, true);
}

export function avatar(charId) {
  if (!store || !charId) return FD_AVATAR;
  if (charId.startsWith('token_')) return tokenIcon(charId);
  const pick = pickOf(charId);
  // 选了皮肤就用皮肤的半身图当头像（方形框里 object-fit 自动裁），没有半身退回全身。
  if (pick && pick !== 'e0' && pick !== 'e2') {
    const sk = skinOf(charId, pick);
    if (sk) return sk.artB || sk.art || FD_AVATAR;
  }
  if (pick === 'e2') return safe(store.avatar, charId, { e2: true }) || safe(store.avatar, charId) || FD_AVATAR;
  return safe(store.avatar, charId) || safe(store.portrait, charId) || FD_AVATAR;
}

export function tokenIcon(tokenId) {
  return store ? safe(store.tokenAvatar, tokenId) || FD_AVATAR : FD_AVATAR;
}

/** 完整立绘优先，其次精二半身图；玩家在详情页选了立绘/皮肤时以选择为准。 */
export function portrait(charId) {
  if (!store || !charId) return FD_AVATAR;
  if (charId.startsWith('token_')) return tokenIcon(charId);
  const pick = pickOf(charId);
  if (pick && pick !== 'e0' && pick !== 'e2') {
    const sk = skinOf(charId, pick);
    if (sk) return sk.art || sk.artB || FD_AVATAR;
  }
  if (pick === 'e0') {
    return safe(store.portrait, charId, { e2: false }) || safe(store.illust, charId, { e2: false })
      || safe(store.avatar, charId) || FD_AVATAR;
  }
  if (OPERATOR_ILLUSTRATIONS[charId]) return OPERATOR_ILLUSTRATIONS[charId].url;
  const illustration = safe(store.illust, charId, { e2: true });
  if (illustration) return illustration;
  return safe(store.portrait, charId, { e2: true }) || safe(store.avatar, charId) || FD_AVATAR;
}

export function skillIcon(skillId) {
  if (!store || !skillId) return null;
  return safe(store.skillIcon, skillId);
}

export function professionIcon(profession, kind = 'icon') {
  return store ? safe(store.profIcon, profession, kind) : null;
}

export function enemyIcon(key) {
  if (!store || !key) return null;
  return safe(store.enemyIcon, key);
}

/** 星级条底板：官方 charRaritySprite/rarity_N（rarity_N 有 N+1 颗星）。 */
export function rarityStars(rarity) {
  const n = Math.max(0, Math.min(5, (Number(rarity) || 1) - 1));
  return `/assets/ui/charRaritySprite/rarity_${n}.png`;
}

/** 星级 / 阶级的颜色（对应 theme.css 的 --tier-N）。 */
export function rarityColor(rarity) {
  const r = Number(rarity) || 1;
  if (r >= 6) return '#f88000';
  if (r === 5) return '#f8bf00';
  if (r === 4) return '#b06ee8';
  if (r === 3) return '#4a9edb';
  return '#9aa4ab';
}
