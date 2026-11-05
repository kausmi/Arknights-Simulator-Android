import { PROF_CN } from './state.js';
import { COLS } from './battlefield.js';

function visibleTalents(record) {
  const found = new Map();
  for (const t of record?.talents || []) {
    const name = String(t?.name || '').trim(), desc = String(t?.description ?? t?.desc ?? '').trim();
    if (t?.hidden || Number(t?.index) < 0 || !name || !desc) continue;
    const index = Number.isInteger(t.index) ? t.index : found.size;
    found.set(index, { index, name, desc, richDesc: t.descRaw || desc });
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

function skillInfoOf(rec) {
  if (!rec) return null;
  return { name: String(rec.name || ''), desc: String(rec.desc || rec.description || rec.descRaw || ''),
    richDesc: rec.descRaw || rec.desc || rec.description || '', skillId: rec.id || rec.skillId,
    spType: rec.spType || '', auto: String(rec.skillType || rec.type || '').toUpperCase() === 'AUTO',
    duration: Number(rec.duration), passive: String(rec.skillType || rec.type || '').toUpperCase() === 'PASSIVE' };
}

/**
 * 详情面板「基础数值」八格需要的原值（参照 Stronghold-Protocol 的 chessStatsBlock）。
 * 只从棋子记录 / 运行时 stats 里取，不改动任何战斗数值 —— 面板是只读视图。
 */
function baseInfoOf(rec, fallbackStats) {
  const st = rec?.statsBase || rec?.stats || {};
  const live = fallbackStats || {};
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    appellation: String(rec?.appellation || ''),
    subProfessionName: String(rec?.subProfessionName || ''),
    position: String(rec?.position || ''),
    rarity: num(rec?.rarity, 1),
    tier: num(rec?.tier, 1),
    cost: num(st.cost ?? rec?.price),
    respawnTime: num(st.respawnTime, 70),
    bat: num(st.bat, 0),
    aspd: num(st.aspd, 100),
    maxHpBase: num(st.maxHp ?? live.maxHp),
    modules: Array.isArray(rec?.modules) ? rec.modules : [],
    module: rec?.module && typeof rec.module === 'object' ? rec.module : null,
  };
}

/** 攻击间隔：方案约定 bat * 100 / aspd（与 shared/protocol.js 的 attackInterval 同式，这里内联避免跨层依赖）。 */
function attackIntervalOf(bat, aspd) {
  const b = Number(bat), a = Number(aspd);
  if (!(b > 0) || !(a > 0)) return null;
  return Math.round((b * 100 / a) * 100) / 100;
}


/**
 * 多形态干员（目前只有阿米娅升变：术师 / 近卫 / 医疗）。
 *
 * 三条形态在数据层是**三条独立的 chess 记录**（`aue_char_002_amiya` /
 * `aue_char_1001_amiya2` / `aue_char_1037_amiya3`），共享同一个 `charId` 与美术；
 * 每条记录上带 `personaGroup` / `personaIds` / `personaName` 互相指认。
 * 之所以拆成三条记录而不是一条里塞数组：引擎的 `content.operators[key]` 是按
 * chessId 取定义的，拆开才能让「换形态 = 换一份 chessId」走通现有的装配链。
 *
 * @returns {null | {group:string, list:{id,name,profession}[], index:number}}
 */
function personaOf(rec, currentId, all) {
  const ids = Array.isArray(rec?.personaIds) ? rec.personaIds.filter(Boolean) : null;
  if (!ids || ids.length < 2 || !all) return null;
  const list = ids.map((id, i) => {
    const r = all[id];
    return {
      id,
      index: i,
      name: String(r?.personaName || r?.name || id),
      profession: String(r?.subProfessionName || r?.profession || ''),
    };
  });
  const cur = ids.indexOf(String(currentId || ''));
  return { group: String(rec?.personaGroup || ''), list, index: cur < 0 ? 0 : cur };
}

export function createUnitModels({ state, units, charIdOf, selectedUnit, now, canSpend, getHandRecord, getRangeKeys }) {
function unitVM() {
  const u = selectedUnit();
  if (!u || !u.alive || !u.deployed) return null;
  const sk = u.skill;
  const cost = sk && !sk.noSkill ? sk.spCost : 0;
  const ready = !!(sk && sk.ready);
  // 原始当前配装记录保留 hidden/index；隐藏模组条目只供机制使用。
  const rec = units()[u.defId];
  const base = u.def.raw || rec || u.def;
  const raw = u.kind === 'token' ? { ...base, ...base.variants?.[u.ownerUnit?.defId] } : base;
  const talents = visibleTalents(raw);
  const skIndex = Number(sk?.def?.index) || 0;
  const skRec = u.kind === 'token' ? u.def.skill : raw.skills?.[skIndex] || rec?.skills?.[skIndex] || raw.skill;
  const mk = u.mem.customMakoto || null;
  // 特性文案：simdata 归一化后 `def.trait` **是字符串**（server/sim/simdata.js:207 把 rec.trait.desc 拍平了），
  // 只有原始 chess.json 里的 rec.trait 才是 {desc, descRaw} 对象。两种形态都要认，
  // 之前只取 .desc 导致归一化后的字符串被忽略，面板显示「该干员没有特性说明」。
  const traitOf = (v) => (typeof v === 'string' ? v : String(v?.desc || v?.descRaw || ''));
  const traitDesc = traitOf(u.def?.trait) || traitOf(rec?.trait);
  const info = baseInfoOf(raw, { maxHp: u.s.maxHp, cost: rec?.stats?.cost });
  return {
    uid: u.uid ?? `unit:${u.id}`,
    // 干员编辑页（/studio/operators.html?id=…）要的就是这个 chessId；
    // 召唤物 / 非干员单位给 null，详情面板据此不画「编辑」按钮。
    chessId: u.kind === 'token' ? null : (u.defId || null),
    tokenId: u.kind === 'token' ? u.defId : null,
    name: u.name ?? u.defId,
    charId: charIdOf(u),
    prof: u.kind === 'token' ? `召唤物${u.ownerUnit ? ` · ${u.ownerUnit.name}` : ''}` : String(u.def?.subProfessionName || PROF_CN[u.def?.profession] || u.def?.profession || ''),
    profession: u.def.profession,
    level: raw.status?.level || rec?.status?.level || u.ownerUnit?.def.raw?.status?.level || null,
    rangeGrid: (getRangeKeys?.(u, state.ui.rangeMode) || u.rangeKeys || []).map((k) => [Math.floor(k / COLS) - u.tileR, k % COLS - u.tileC]),
    hp: u.hp, maxHp: u.s.maxHp,
    atk: u.s.atk, def: u.s.def, res: u.s.res, block: u.s.blockCnt,
    talents,
    traitDesc,
    traitRich: raw.trait?.descRaw || traitDesc,
    // ---- 详情面板新版式（参照 Stronghold-Protocol 的 ChessDetail head / stats 块）需要的字段
    appellation: info.appellation,
    subProfessionName: info.subProfessionName,
    position: info.position,
    rarity: info.rarity,
    tier: info.tier,
    cost: info.cost,
    respawnTime: info.respawnTime,
    attackInterval: attackIntervalOf(info.bat, info.aspd),
    modules: info.modules,
    module: info.module,          // 当前携带的模组（含 id/name/type/level/active）
    // 范围按钮当前在哪个视图（面板据此亮灭）
    rangeMode: state.ui.rangeMode,
    skillInfo: skillInfoOf(skRec),
    skill: sk && !sk.noSkill ? {
      name: String(sk.name || sk.def?.name || '技能'),
      skillId: String(sk.def?.id || sk.def?.skillId || sk.def?.iconId || ''),
      index: skIndex,
      sp: sk.sp,
      cost,
      ready,
      charges: sk.charges,
      maxCharges: sk.maxCharges,
      active: !!sk.active,
      ammoLeft: sk.ammoLeft,
      ammoMax: sk.ammoMax,
      // 技能页要标注触发方式（本体在技能名下面写「自动回复 / 手动触发」）
      spType: String(sk.def?.spType || sk.spType || ''),
      auto: String(sk.def?.skillType || sk.def?.type || sk.skillType || '').toUpperCase() === 'AUTO',
      left: Number(sk.timeLeft) || 0,
      dur: Number(sk.duration) || 0,
      frac: ready ? 1 : (cost > 0 ? Math.min(1, sk.sp / cost) : 0),
    } : null,
    alt: mk ? `面具：${mk.names[mk.index]} · 切换 10 费` : null,
    equipment: mk ? `装备应变 · ${mk.index === 0 ? 3 : mk.index === 1 ? 8 : 50}费` : null,
    // 切换面具的冷却剩余（秒）与费用是否够：两个都要显示，否则玩家点了没反应只能瞎猜
    altCd: mk ? Math.max(0, (Number(mk.switchAt) || 0) - now()) : 0,
    altPoor: mk ? !canSpend(u.ownerId, 10) : false,
    personaIndex: mk?.index,
    // 多形态（阿米娅升变）：null 表示这个干员只有一个形态，面板不画切换条
    persona: personaOf(raw, u.defId, units()),
  };
}

/**
 * 只拿着手牌、还没落地时的面板内容：面板一样要能看到天赋与技能说明（用户明确要求「无论手牌还是已经放置的干员」）。
 * 和场上干员共用同一块面板与同一个选中框，只是没有生命 / 技力 / 撤退可谈，这几项留空由 hud 那边略过。
 */
function handVM() {
  const id = state.ui.active;
  if (!id) return null;
  const rec = getHandRecord?.(id) || units()[id];
  if (!rec) return null;
  const skRec = Array.isArray(rec.skills) ? rec.skills[Math.min(state.ui.skillIndex, rec.skills.length - 1)] : null;
  const talents = visibleTalents(rec);
  const info = baseInfoOf(rec, { maxHp: rec.stats?.maxHp, cost: rec.stats?.cost });
  return {
    hand: true,
    uid: `hand:${id}`,
    chessId: id,
    // 手牌没有范围键，这个字段只为让模板里的 ${u.rangeMode === 'skill'} 有个确定值
    rangeMode: 'attack',
    name: String(rec.name || id),
    charId: String(rec.charId || ''),
    tokenId: rec.tokenId || null,
    prof: rec.tokenId ? '召唤物' : String(rec.subProfessionName || PROF_CN[rec.profession] || rec.profession || ''),
    profession: rec.profession,
    level: rec.status?.level || null,
    rangeGrid: rec.rangeGrid || [],
    // 待部署状态展示所带配装的完整面板。
    hp: Number(rec.stats?.maxHp) || 0, maxHp: Number(rec.stats?.maxHp) || 0,
    atk: Number(rec.stats?.atk) || 0,
    def: Number(rec.stats?.def) || 0,
    res: Number(rec.stats?.res) || 0,
    block: Number(rec.stats?.blockCnt) || 0,
    talents,
    traitDesc: typeof rec.trait === 'string' ? rec.trait : String(rec.trait?.desc || rec.trait?.descRaw || ''),
    traitRich: rec.trait?.descRaw,
    // 详情面板新版式字段（与 unitVM 对齐：手牌也要能看到八格数值、职业、模组）
    appellation: info.appellation,
    subProfessionName: info.subProfessionName,
    position: info.position,
    rarity: info.rarity,
    tier: info.tier,
    cost: info.cost,
    respawnTime: info.respawnTime,
    attackInterval: attackIntervalOf(info.bat, info.aspd),
    modules: info.modules,
    module: info.module,
    skillInfo: skillInfoOf(skRec),
    skill: null,
    alt: null,
    // 手牌也要能切形态（阿米娅升变），切完部署出去就是新形态
    persona: personaOf(rec, id, units()),
  };
}


/**
 * 场上敌人 → 面板模型（用户要求「点击敌人可以查看敌人面板」）。
 *
 * 字段与 unitVM/handVM 对齐，面板模板可以直接吃：只是没有技能可开、没有撤退，
 * 用 hand:true 走「只读」那一路（模板里 hand 分支不画技能按钮与撤退键）。
 */
function enemyVM(enemy) {
  if (!enemy || !enemy.alive || !enemy.deployed) return null;
  const def = enemy.def || {};
  const st = enemy.s || def.stats || {};
  const rankCn = { NORMAL: '普通', ELITE: '精英', BOSS: '首领' }[def.rank] || def.rank || '';
  return {
    hand: true,                       // 只读面板：不画技能按钮 / 撤退键
    enemy: true,
    uid: `enemy:${enemy.id}`,
    chessId: null,
    rangeMode: 'attack',
    name: String(def.name || enemy.defId || '敌人'),
    charId: String(def.iconId || def.key || ''),
    tokenId: null,
    prof: rankCn ? `${rankCn}敌人` : '敌人',
    profession: null,
    level: def.level || null,
    rangeGrid: Array.isArray(def.stats?.rangeGrid) ? def.stats.rangeGrid : [],
    hp: enemy.hp, maxHp: st.maxHp || enemy.hp,
    atk: Number(st.atk) || 0,
    def: Number(st.def) || 0,
    res: Number(st.res) || 0,
    block: Number(st.blockCnt) || 0,
    // 敌人的机制说明：abilities / talents / skills 都当「天赋」塞进面板那三栏里
    talents: [
      ...(Array.isArray(def.abilities) ? def.abilities.map((a, i) => ({
        index: i, name: a.name || `能力 ${i + 1}`, desc: a.desc || a.description || '',
      })) : []),
      ...(Array.isArray(def.talents) ? def.talents.map((t, i) => ({
        index: i, name: t.name || `天赋 ${i + 1}`, desc: t.desc || '',
      })) : []),
    ],
    traitDesc: String(def.desc || '').trim(),
    traitRich: def.descRaw || null,
    // 敌人没有职业 / 模组，但八格数值照给，模板统一渲染（避免模板里到处写 u.enemy ? … : …）
    appellation: '',
    subProfessionName: '',
    position: String(def.isFlyEnemy ? 'RANGED' : 'MELEE'),
    rarity: 0,
    tier: Number(def.level) || 1,
    cost: 0,
    respawnTime: 0,
    attackInterval: attackIntervalOf(st.bat, st.aspd),
    modules: [],
    module: null,
    skillInfo: Array.isArray(def.skills) && def.skills.length
      ? { name: def.skills[0].name || '技能', desc: def.skills[0].desc || '' } : null,
    skill: null,
    alt: null,
    // 敌人专属：移动速度、重量、是否飞行、免疫
    enemyExtra: {
      moveSpeed: st.moveSpeed, massLevel: st.massLevel, isFly: !!def.isFlyEnemy,
      dmgType: st.dmgType, immunities: st.immunities,
      tags: Array.isArray(def.tags) ? def.tags : [],
    },
  };
}

return { unitVM, handVM, enemyVM };
}
