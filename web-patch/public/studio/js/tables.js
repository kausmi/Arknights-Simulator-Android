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
 * 71 个，覆盖当前数据里全部 subProfessionId。
 */
export const SUB_PROFESSION_CN = {
  // 先锋
  pioneer: '尖兵', charger: '冲锋手', skypuller: '执旗手', tactician: '战术家',
  bearer: '策士', agent: '情报官', pioneer2: '尖兵',
  // 近卫
  fearless: '强攻手', lord: '领主', centurion: '重剑手', sword: '剑豪',
  artsfghter: '术战者', crusher: '撼地者', hammer: '重锤手', duelist: '决斗者',
  instructor: '教官', fighter: '斗士', guard: '守卫', musha: '武者',
  reaper: '收割者', unyield: '不屈者', primguard: '本源近卫',
  // 狙击
  fastshot: '速射手', aoesniper: '炮手', closerange: '近距射手', longrange: '远距射手',
  siegesniper: '攻城手', hunter: '猎手', loopshooter: '回环射手', bombarder: '投掷手',
  skybreaker: '散射手', traper: '陷阱师', underminer: '挖掘工',
  // 术师
  corecaster: '中坚术师', splashcaster: '扩散术师', blastcaster: '轰击术师',
  chain: '链术师', funnel: '阵法术师', mystic: '秘术师', primcaster: '本源术师',
  soulcaster: '驭械术师', ritualist: '塑灵术师',
  // 医疗
  physician: '医师', blessing: '群愈师', ringhealer: '环愈师', chainhealer: '链愈师',
  wandermedic: '行医', incantationmedic: '咒愈师',
  // 重装
  protector: '铁卫', guardian: '守护者', artsprotector: '术铁卫', shotprotector: '哨卫',
  fortress: '要塞', primprotector: '本源铁卫',
  // 辅助
  bard: '吟游者', slower: '削弱者', summoner: '召唤师', craftsman: '工匠',
  alchemist: '炼金师', counsellor: '谋士', geek: '技术人员', guerrilla: '游击手',
  // 特种
  executor: '处决者', pusher: '推击手', hookmaster: '钩索师', stalker: '伏击客',
  gecko: '傀儡师', dollkeeper: '人偶师', skywalker: '行空使', reaperrange: '荒域客',
  merchant: '行商', loopshooter2: '回环射手', supportiveranger: '支援射手',
  watchman: '巡空者', mercenary: '佣兵', dispatcher: '调度者',
};

/** 模组类型代号（CCR-Y 这种）→ 中文说明。取不到的显示代号。 */
export const MODULE_TYPE_CN = {
  CCR: '术师', MAR: '近卫', SUP: '辅助', TAN: '重装', SPE: '特种',
  SNO: '狙击', MED: '医疗', PIO: '先锋', EXE: '处决', UPR: '成长',
  AMB: '特种', INS: '近卫', PRP: '重装',
};

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
