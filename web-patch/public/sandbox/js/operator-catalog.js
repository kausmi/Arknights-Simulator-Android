import { DIY_OPS, SUPPORT_OPS, AVAILABLE_IDS } from './roster.js';

export function createCatalog(data, state) {
let chessUnits = null;
function units() {
  if (chessUnits) return chessUnits;
  const raw = data.getRaw('chess');
  const map = raw?.units && typeof raw.units === 'object' ? raw.units : raw;
  chessUnits = map && typeof map === 'object' ? map : {};
  return chessUnits;
}

/** 手牌 / 选择器要用的干员视图模型。 */
function opVM(id) {
  const r = units()[id];
  if (!r || typeof r !== 'object') return null;
  // 多形态干员（阿米娅三形态）在数据层是三条独立记录、名字都叫「阿米娅」，
  // 手牌与选择器只显示 name，不追加形态名的话三张卡完全分不清。
  const personaName = String(r.personaName || '');
  return {
    id,
    name: personaName && personaName !== '术师' ? `${String(r.name || id)}·${personaName}` : String(r.name || id),
    charId: String(r.charId || ''),
    cost: Number(r.stats?.cost) || 0,
    rarity: Number(r.rarity) || 1,
    prof: String(r.subProfessionName || r.profession || ''),
    tier: Number(r.tier) || 0,
    profession: r.profession,
    skills: (Array.isArray(r.skills) ? r.skills : []).map((s, i) => ({
      name: String(s?.name || `技能 ${i + 1}`),
      skillId: String(s?.skillId || s?.iconId || ''),
      index: i,
    })),
  };
}

/** 牌库：自设干员 + 明确开放的演示支援。 */
function allOps() {
  const out = [];
  for (const id of AVAILABLE_IDS) {
    const rec = units()[id];
    if (!rec || typeof rec !== 'object') continue;
    const pn = String(rec.personaName || '');
    out.push({
      id,
      name: pn && pn !== '术师' ? `${String(rec.name || id)}·${pn}` : String(rec.name || id),
      charId: String(rec.charId || ''),
      profession: rec.profession, rarity: Number(rec.rarity) || 1, prof: String(rec.subProfessionName || rec.profession || ''),
      tier: Number(rec.tier) || 0,
      role: DIY_OPS.some((o) => o.id === id) ? '自设干员' : '满配干员',
    });
  }
  out.sort((a, b) => (b.rarity - a.rarity) || (b.tier - a.tier) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
}

/** 选人器里的「预留槽位」：数据还没接进来的自设干员（维娜 / 结城理）。 */
const reserveSlots = () => DIY_OPS.filter((o) => !o.ready).map((o) => ({ name: o.name, owner: o.owner }));

const squadVMs = () => state.document.squad.map(opVM).filter(Boolean);

function charIdOf(u) {
  return String(u?.def?.charId || u?.def?.raw?.charId || units()[u?.defId]?.charId || '');
}

function rangeGridOf(chessId) {
  const g = units()[chessId]?.rangeGrid;
  return Array.isArray(g) && g.length ? g : [[0, 0], [0, 1]];
}


return { units, opVM, allOps, reserveSlots, squadVMs, charIdOf, rangeGridOf };
}
