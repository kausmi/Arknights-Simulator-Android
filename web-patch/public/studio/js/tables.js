// public/studio/js/tables.js — 中文名对照表（子职业 / 职业 / 模组类型 / 技能词条）。
//
// 为什么单独一个文件：官方数据里 subProfessionId 只有英文 id（corecaster、musha…），
// 没有中文名；模组只给 typeName 代号（CCR-Y），技能只有内部 id。
// 界面上给人看必须换成中文，所以这里按「官方术语」整理一份对照表。
//
// 维护方式：官方新增职业/子职业时往这里补一行即可，取不到就原样显示 id（不会出错）。

/** 八大职业。 */
export const PROFESSION_CN = {
  PIONEER: '先锋', WARRIOR: '近卫', SNIPER: '狙击', MEDIC: '医疗',
  CASTER: '术师', SPECIAL: '特种', TANK: '重装', SUPPORT: '辅助',
};

/**
 * 子职业（分支）中文名 —— 官方 PRTS 的叫法。
 * 72 个，覆盖当前数据里全部 subProfessionId（2026-11 按 data/chess.json 与
 * data/operator-library.json 自带的 subProfessionName 逐条核对，那两份是官方表导出的，
 * 是唯一可信的中文名来源；旧的这份手写表有 33 处写错、3 处漏，已全部按官方改正）。
 *
 * 注意 supportiveranger 与 guerrilla 是两个不同 id，但官方中文都叫「游击手」
 * （数据里现在只有 supportiveranger 在用，guerrilla 已无干员）。
 */
export const SUB_PROFESSION_CN = {
  // 先锋
  charger: '冲锋手', pioneer: '尖兵', agent: '情报官', tactician: '战术家',
  bearer: '执旗手', counsellor: '策士',
  // 近卫
  mercenary: '佣兵', sword: '剑豪', centurion: '强攻手', hammer: '撼地者',
  reaper: '收割者', instructor: '教官', fighter: '斗士', fearless: '无畏者',
  primguard: '本源近卫', artsfghter: '术战者', musha: '武者', librator: '解放者',
  crusher: '重剑手', lord: '领主',
  // 重装
  unyield: '不屈者', duelist: '决战者', shotprotector: '哨戒铁卫', guardian: '守护者',
  primprotector: '本源铁卫', fortress: '要塞', protector: '铁卫', artsprotector: '驭法铁卫',
  // 狙击
  loopshooter: '回环射手', bombarder: '投掷手', siegesniper: '攻城手', reaperrange: '散射手',
  aoesniper: '炮手', hunter: '猎手', longrange: '神射手', skybreaker: '裂空炮手',
  fastshot: '速射手', closerange: '重射手',
  // 术师
  corecaster: '中坚术师', soulcaster: '塑灵术师', splashcaster: '扩散术师', primcaster: '本源术师',
  mystic: '秘术师', blastcaster: '轰击术师', chain: '链术师', phalanx: '阵法术师',
  funnel: '驭械术师',
  // 医疗
  physician: '医师', incantationmedic: '咒愈师', watchman: '守望者', healer: '疗养师',
  ringhealer: '群愈师', wandermedic: '行医', chainhealer: '链愈师',
  // 辅助
  slower: '凝滞师', underminer: '削弱者', summoner: '召唤师', bard: '吟游者',
  craftsman: '工匠', ritualist: '巫役', blessing: '护佑者', guerrilla: '游击手',
  supportiveranger: '游击手',
  // 特种
  stalker: '伏击客', dollkeeper: '傀儡师', executor: '处决者', skywalker: '巡空者',
  geek: '怪杰', pusher: '推击手', alchemist: '炼金师', merchant: '行商',
  dispatcher: '调度者', hookmaster: '钩索师', traper: '陷阱师',
};

/** 模组类型代号（CCR-Y 这种）→ 中文说明。取不到的显示代号。 */
export const MODULE_TYPE_CN = {
  CCR: '术师', MAR: '近卫', SUP: '辅助', TAN: '重装', SPE: '特种',
  SNO: '狙击', MED: '医疗', PIO: '先锋', EXE: '处决', UPR: '成长',
  AMB: '特种', INS: '近卫', PRP: '重装',
  // 特限证章三族：官方 uniequip_table 里 typeName2 为 A/B、isSpecialEquip = true。
  // 它们不是按职业分的，只在集成战略 / 生息演算 / 界园志异这些模式里出现，
  // 所以不能走「取前缀查职业」那条路，必须单独列出来。
  ISW: '集成战略', RA: '生息演算', SO: '界园志异',
};

/**
 * 模组的官方类型前缀（'MAR-X' → 'MAR'）——与 {@link moduleTypeCn} 共用的解析。
 */
export function modulePrefix(typeName) {
  const m = /^([A-Z]{2,4})/.exec(String(typeName || ''));
  return m ? m[1] : '';
}

/**
 * 是不是特限模组（特限证章）。
 *
 * 判据取两头，缺一不可：
 *   ① 数据侧的 `isSpecial`（本地从 uniequip_table 的 isSpecialEquip 抄进来）；
 *   ② 类型前缀落在 ISW / RA / SO 三族里。
 * 老数据只有 ②，所以两边都要认。
 */
export function isSpecialModule(mod) {
  if (!mod || typeof mod !== 'object') return false;
  if (mod.isSpecial === true) return true;
  return ['ISW', 'RA', 'SO'].includes(modulePrefix(mod.typeName));
}

/**
 * 技能里常见的 bb 键名 → 中文（用于把 "atk"/"duration"/"cost" 这类词显示成人话）。
 */
export const SKILL_KEY_CN = {
  atk: '攻击力加成', attack_speed: '攻击速度', aspd: '攻击速度',
  duration: '持续时间', interval: '间隔', cost: '费用', fake_cost: '总费用',
  sp: '技力', sp_cost: '技力消耗', sp_recovery: '技力回复',
  hp_recovery_per_sec_by_max_hp_ratio: '每秒回血（最大生命百分比）',
  damage_resistance: '庇护（减伤）', scale: '倍率', max_target: '最大目标数',
  targets: '目标数', radius: '半径', range: '范围', times: '次数',
  prob: '概率', force: '力度', speed: '速度', heal: '治疗量',
  shield: '护盾', charge: '蓄力', hp: '生命', def: '防御', res: '法术抗性',
  block_cnt: '阻挡数', max_hp: '生命上限', weight: '重量', duration_time: '总时长',
};

/** 温和的查询：拿不到就返回原 id，绝不会出现「空」。 */
export const subProfessionCn = (id) => SUB_PROFESSION_CN[id] || id || '';
export const professionCn = (id) => PROFESSION_CN[id] || id || '';

/**
 * 从模组 typeName（如 "CCR-Y"）推出中文说明。
 * 规则：取前缀字母，查 MODULE_TYPE_CN；查不到就用「模组」。
 */
export function moduleTypeCn(typeName) {
  const t = String(typeName || '');
  const m = /^([A-Z]{2,4})/.exec(t);
  if (!m) return '模组';
  const cn = MODULE_TYPE_CN[m[1]];
  return cn ? `${cn}模组` : '模组';
}

/** bb 键 → 中文；没有对照就原样（但把下划线换成空格，至少好读一点）。 */
export function skillKeyCn(key) {
  const k = String(key || '');
  if (SKILL_KEY_CN[k]) return SKILL_KEY_CN[k];
  // 形如 "amiya_t_1[atk].sp" 这种复合键：把 [xxx] 里的英文换成中文，再补后缀
  const m = /^(.+?)\[(.+?)\](?:\.(.+))?$/.exec(k);
  if (m) {
    const inner = SKILL_KEY_CN[m[2]] || m[2];
    const tail = m[3] ? `（${SKILL_KEY_CN[m[3]] || m[3]}）` : '';
    return `${inner}${tail}`;
  }
  return k.replace(/_/g, ' ');
}
