package com.arksim.app;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 干员数值覆盖表的读写（「改干员数值 / 模组 / 天赋 / 职业特性」的全部后端逻辑）。
 *
 * 设计
 * ----
 * 官方原表 data/aue-operators.json **只读**，玩家的改动单独存一份覆盖表
 * data/operator-overrides.json，形状：
 *
 *   {
 *     "version": 1,
 *     "operators": {
 *       "<chessId>": {
 *         "stats":  { "maxHp": 2900, "atk": 980, ... },   // 基础数值
 *         "trait":  { "0": { "bb": {"xxx": 1} } },        // 职业特性（按「字段路径」存）
 *         "talents": { "0": { "bb": {...} } },            // 天赋（按天赋序号存）
 *         "modules": {                                     // 模组（按 uniEquipId 存）
 *           "<uniEquipId>": {
 *             "level": 3,
 *             "attr": { "maxHp": 150, "atk": 50 },
 *             "traitOverride": { "bb": {...} },
 *             "talentChanges": { "0": { "bb": {...} } }
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 *         "skills": {                                      // 技能数值（按技能下标存）
 *           "0": { "spCost": 4, "initSp": 0, "duration": 0, "level": 7 },
 *           "2": { "spCost": 30 }
 *         }
 *       }
 *     }
 *   }
 *
 * 各类改动互相独立，所以「只还原模组」「只还原天赋」「只还原技能」做得到 —— 前端按类别 DELETE 对应键即可。
 *
 * 为什么按类别分开存：玩家经常只想把模组改回去而保留自己调过的基础数值。
 * 混在一个扁平对象里就没法分开还原了。
 */
public final class OperatorStore {

    /** 认可的四个改动类别。 */
    public static final String[] CATEGORIES = {"loadout", "stats", "trait", "talents", "modules", "skills"};

    private final JSONObject nativeTable;
    private final JSONObject overrides;

    public OperatorStore(JSONObject nativeTable, JSONObject overrides) {
        this.nativeTable = nativeTable;
        this.overrides = overrides;
    }

    private static boolean isCategory(String k) {
        for (String c : CATEGORIES) if (c.equals(k)) return true;
        return false;
    }

    // ── 读 ─────────────────────────────────────────────────────────────

    /** 原表里的干员表。 */
    public JSONObject nativeOperators() {
        JSONObject ops = nativeTable == null ? null : nativeTable.optJSONObject("operators");
        return ops == null ? new JSONObject() : ops;
    }

    /** 覆盖表里的干员改动。 */
    public JSONObject edits() {
        JSONObject ops = overrides == null ? null : overrides.optJSONObject("operators");
        return ops == null ? new JSONObject() : ops;
    }

    /** 某位干员的改动对象（可能为空）。 */
    public JSONObject editOf(String id) {
        JSONObject e = edits().optJSONObject(id);
        return e == null ? new JSONObject() : e;
    }

    /** 这位干员到底改过没有（四个类别里任意一个非空）。 */
    public boolean isEdited(String id) {
        JSONObject e = editOf(id);
        for (String c : CATEGORIES) {
            JSONObject part = e.optJSONObject(c);
            if (part != null && part.length() > 0) return true;
        }
        return false;
    }

    /** 这位干员改过哪些类别（给前端画徽章）。 */
    public JSONArray editedCategories(String id) {
        JSONArray out = new JSONArray();
        JSONObject e = editOf(id);
        for (String c : CATEGORIES) {
            JSONObject part = e.optJSONObject(c);
            if (part != null && part.length() > 0) out.put(c);
        }
        return out;
    }

    // ── 合并：原表 + 覆盖 → 实际生效的那份 ─────────────────────────────

    /** 把覆盖叠到原表上，得到网页真正使用的那份干员表。 */
    public JSONObject effectiveOperators() {
        JSONObject base;
        try {
            base = nativeTable != null ? new JSONObject(nativeTable.toString())
                    : new JSONObject("{\"version\":1,\"operators\":{}}");
        } catch (Exception e) {
            return new JSONObject();
        }
        JSONObject ops = base.optJSONObject("operators");
        if (ops == null) return base;

        JSONObject patchAll = edits();
        java.util.Iterator<String> ids = patchAll.keys();
        while (ids.hasNext()) {
            String id = ids.next();
            JSONObject op = ops.optJSONObject(id);
            JSONObject patch = patchAll.optJSONObject(id);
            if (op == null || patch == null) continue;
            JSONObject rec;
            try {
                rec = new JSONObject(op.toString());
            } catch (Exception e) {
                continue;
            }
            applyLoadout(rec, patch.optJSONObject("loadout"));
            applyStats(rec, patch.optJSONObject("stats"));
            applyTrait(rec, patch.optJSONObject("trait"), "trait");
            applyTalents(rec, patch.optJSONObject("talents"));
            applyModules(rec, patch.optJSONObject("modules"));
            applySkills(rec, patch.optJSONObject("skills"));
            putSafe(ops, id, rec);
        }
        return base;
    }

    /**
     * 把一份覆盖叠到一条干员记录上，返回**新的**记录（不改动入参）。
     *
     * 做成静态的，是因为官方牌库那条路由（/data/operator-library.json）手里已经有
     * 那张表了，不该为了叠一次改动用整张表再 new 一个 OperatorStore 出来。
     */
    public static JSONObject patchRecord(JSONObject rec, JSONObject patch) {
        if (rec == null || patch == null) return null;
        JSONObject copy;
        try {
            copy = new JSONObject(rec.toString());
        } catch (Exception e) {
            return null;
        }
        OperatorStore helper = new OperatorStore(null, null);
        helper.applyLoadout(copy, patch.optJSONObject("loadout"));
        helper.applyStats(copy, patch.optJSONObject("stats"));
        helper.applyTrait(copy, patch.optJSONObject("trait"), "trait");
        helper.applyTalents(copy, patch.optJSONObject("talents"));
        helper.applyModules(copy, patch.optJSONObject("modules"));
        helper.applySkills(copy, patch.optJSONObject("skills"));
        return copy;
    }

    /**
     * 出战配置（携带技能 / 携带模组 / 潜能 / 立绘版本）。
     *
     * 为什么单独一类：这四样不是「把某个数字改掉」，而是「从已有选项里挑一个」。
     * 它们的实际效果都要动到记录里别的字段（stats / trait / skill），所以不能像 stats 那样直接盖值，
     * 必须按数据里现成的 statsBase、modules[].attr、potDown 重新算一遍。
     *
     * 顺序是有讲究的：
     *   ① 潜能先折 —— potDown 的叶子同时覆盖 stats 与 statsBase，是「基础值」；
     *   ② 模组后叠 —— stats = statsBase + 模组 attr，顺序反了会叠错；
     *   ③ 技能最后 —— 只换 skill 指针，与数值无关。
     */
    private void applyLoadout(JSONObject rec, JSONObject patch) {
        if (patch == null || patch.length() == 0) return;
        int potential = patch.optInt("potential", 0);
        if (potential >= 1 && potential <= 6) applyPotential(rec, potential - 1);
        Object mod = patch.opt("module");
        if (mod instanceof String) applyModuleChoice(rec, (String) mod);
        int idx = patch.optInt("skill", -1);
        if (idx >= 0) applySkillChoice(rec, idx);
        String art = patch.optString("art", "");
        if (!art.isEmpty()) putSafe(rec, "artVariant", art);
    }

    /**
     * 把记录折到指定潜能档（数据是按满潜 rank 5 建的）。
     *
     * 潜能在这份数据里改两样东西，缺一不可：
     *   ① `potDown` —— 数值叶子（费用 / 再部署 / 攻击 / 法抗 …），从 rank 4 往下逐层覆盖到目标档；
     *   ② 天赋的 `potMin` / `potBelow` —— 官方那档「天赋效果增强」。例：惊蛰 rank < 4 时
     *      攻击倍率 1.13 → 1.10、描述同时换成不带「（+3%）」的那句。
     *
     * 只做 ① 会让低潜能只减费用不减天赋，跟游戏里对不上；旧版本就是这个毛病，
     * 覆盖表里选 3 潜和选 6 潜除了几个数值以外没有任何差别。
     * 折算规则与网页端 shared/potential.js 的 atRank() 逐条对齐，两边必须算出同一个数。
     */
    private void applyPotential(JSONObject rec, int rank) {
        JSONObject down = rec.optJSONObject("potDown");
        if (down != null) {
            for (int r = 4; r >= rank; r--) {
                JSONObject step = down.optJSONObject(String.valueOf(r));
                if (step == null) continue;
                java.util.Iterator<String> ks = step.keys();
                while (ks.hasNext()) {
                    String path = ks.next();
                    Object v = step.opt(path);
                    if (v == null) continue;
                    setDotted(rec, path, v);
                }
            }
        }

        JSONArray talents = rec.optJSONArray("talents");
        if (talents != null) putSafe(rec, "talents", talentsAtRank(talents, rank));
        JSONArray talentsBase = rec.optJSONArray("talentsBase");
        if (talentsBase != null) putSafe(rec, "talentsBase", talentsAtRank(talentsBase, rank));
        JSONArray mods = rec.optJSONArray("modules");
        if (mods != null) {
            for (int i = 0; i < mods.length(); i++) {
                JSONObject m = mods.optJSONObject(i);
                if (m == null) continue;
                JSONArray changes = m.optJSONArray("talentChanges");
                if (changes != null) putSafe(m, "talentChanges", talentsAtRank(changes, rank));
            }
        }
        // 按模组分表的天赋（当前数据 0 条，但 potential.js 里有这一支，保持一致免得以后漏）。
        JSONObject byModule = rec.optJSONObject("byModule");
        if (byModule != null) {
            java.util.Iterator<String> ids = byModule.keys();
            while (ids.hasNext()) {
                JSONObject bm = byModule.optJSONObject(ids.next());
                if (bm == null) continue;
                JSONArray list = bm.optJSONArray("talents");
                if (list != null) putSafe(bm, "talents", talentsAtRank(list, rank));
            }
        }
    }

    /** 一整个天赋列表折到 rank（逐项走 {@link #talentAtRank}）。 */
    private static JSONArray talentsAtRank(JSONArray list, int rank) {
        if (list == null) return null;
        JSONArray out = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            Object t = list.opt(i);
            out.put(t instanceof JSONObject ? talentAtRank((JSONObject) t, rank) : t);
        }
        return out;
    }

    /**
     * 一条天赋折到 rank：只要 `rank < potMin` 就顺着 `potBelow` 换下一档，并把下一档带的字段并进结果。
     *
     * `potBelow` 是「这一档改了什么」的部分条目（通常只有 desc / descRaw / bb），
     * 所以要往上并，而不是整体替换。返回的条目不带 potMin / potBelow。
     */
    private static JSONObject talentAtRank(JSONObject t, int rank) {
        if (t == null) return null;
        if (!t.has("potMin") && !t.has("potBelow")) return t;
        JSONObject out = copy(t);
        out.remove("potMin");
        out.remove("potBelow");
        JSONObject x = t;
        while (x.optJSONObject("potBelow") != null) {
            int min = x.has("potMin") ? x.optInt("potMin", 0) : 0;
            if (rank >= min) break;
            x = x.optJSONObject("potBelow");
            java.util.Iterator<String> ks = x.keys();
            while (ks.hasNext()) {
                String k = ks.next();
                if (k.equals("potMin") || k.equals("potBelow")) continue;
                Object v = x.opt(k);
                if (v != null) putSafe(out, k, v);
            }
        }
        return out;
    }

    /** 按点路径写一个标量。只覆盖已存在的对象，不凭空造结构（避免把记录写坏）。 */
    private static void setDotted(JSONObject root, String path, Object value) {
        String[] keys = path.split("\\.");
        Object cur = root;
        for (int i = 0; i < keys.length - 1; i++) {
            if (!(cur instanceof JSONObject)) return;
            cur = ((JSONObject) cur).opt(keys[i]);
        }
        if (cur instanceof JSONObject) putSafe((JSONObject) cur, keys[keys.length - 1], value);
    }

    /**
     * 换模组：stats / trait / talents 三样一起重新算。
     *
     * 反复切换模组时**必须每次都从基线重算**，不能在上一次的结果上再叠：
     *   ① stats      = statsBase + 该模组 attr
     *   ② trait      = traitBase 上盖该模组的 traitOverride
     *   ③ talents    = talentsBase 上合并该模组的 talentChanges
     *
     * 老实现是在当前的 trait 上 deepMerge、完全不动 talents —— 于是「装了 A 再换 B」会把 A 的特性残留带过去，
     * 而模组自己改写的天赋（例：能天使 MAR-X 让「天使的祝福」攻击加成从 8% 抬到 10%）永远看不到，
     * 详情面板里显示的还是没加强的那句。用户 m13851 报的就是这个。
     *
     * 老数据没有 statsBase / traitBase（143 条）的，退化成只改 module 标记，数值不动 ——
     * 宁可不重算，也不能拿「已含模组」的 stats 再叠一次 attr，那会直接叠爆。
     */
    private void applyModuleChoice(JSONObject rec, String moduleId) {
        JSONArray mods = rec.optJSONArray("modules");
        JSONObject none = new JSONObject();
        putSafe(none, "id", "none");
        putSafe(none, "name", "未装备模组");
        putSafe(none, "type", "");
        putSafe(none, "level", 0);
        putSafe(none, "active", false);

        JSONObject statsBase = rec.optJSONObject("statsBase");
        JSONObject traitBase = rec.optJSONObject("traitBase");
        JSONArray talentsBase = rec.optJSONArray("talentsBase");

        if (moduleId.isEmpty() || moduleId.equals("none")) {
            putSafe(rec, "module", none);
            if (statsBase != null) putSafe(rec, "stats", copy(statsBase));
            if (traitBase != null) putSafe(rec, "trait", copy(traitBase));
            if (talentsBase != null) putSafe(rec, "talents", copyArray(talentsBase));
            return;
        }
        if (mods == null) return;
        for (int i = 0; i < mods.length(); i++) {
            JSONObject m = mods.optJSONObject(i);
            if (m == null || !moduleId.equals(m.optString("uniEquipId", ""))) continue;

            JSONObject mark = new JSONObject();
            putSafe(mark, "id", moduleId);
            putSafe(mark, "name", m.optString("name", moduleId));
            putSafe(mark, "type", m.optString("typeName", ""));
            putSafe(mark, "level", m.optInt("level", 3));
            putSafe(mark, "active", true);
            if (m.optBoolean("isSpecial", false)) {
                putSafe(mark, "isSpecial", true);
                putSafe(mark, "specialDesc", m.optString("specialDesc", "适配限定模式"));
            }
            putSafe(rec, "module", mark);

            // ① stats = statsBase + attr
            JSONObject attr = m.optJSONObject("attr");
            if (statsBase != null) {
                JSONObject s = copy(statsBase);
                if (attr != null) {
                    java.util.Iterator<String> ks = attr.keys();
                    while (ks.hasNext()) {
                        String k = ks.next();
                        Object v = attr.opt(k);
                        if (!(v instanceof Number)) continue;
                        putSafe(s, k, s.optDouble(k, 0) + ((Number) v).doubleValue());
                    }
                }
                putSafe(rec, "stats", s);
            }

            // ② trait = traitBase 上盖 traitOverride
            JSONObject to = m.optJSONObject("traitOverride");
            JSONObject traitSeed = traitBase != null ? copy(traitBase) : rec.optJSONObject("trait");
            if (traitSeed != null) {
                JSONObject merged = copy(traitSeed);
                if (to != null && to.length() > 0) deepMerge(merged, to);
                putSafe(rec, "trait", merged);
            }

            // ③ talents = talentsBase 上合并 talentChanges
            JSONArray seed = talentsBase != null ? talentsBase : rec.optJSONArray("talents");
            if (seed != null) putSafe(rec, "talents", mergeModuleTalents(seed, m.optJSONArray("talentChanges")));
            return;
        }
    }

    /**
     * 把模组的 talentChanges 合并进一份天赋表（对齐 shared 层 mergeTalentChanges 的规则）。
     *
     * 命中同 index 的天赋时是「部分覆盖」而不是整体替换：
     *   name / desc / descRaw —— change 有就用 change 的，空则保留原句（很多模组只改数值不改文案）；
     *   bb / bbStr           —— 原表打底、change 覆盖（例：atk 0.08 → 0.10，其余键不动）；
     *   rangeGrid / tokenKey —— change 优先，空则沿用；
     *   hidden               —— 两侧都为真才算隐藏（原表可见的天赋不会因为模组而被藏掉）。
     *
     * talentIndex 为负或找不到对应天赋时，作为一条新天赋追加（index 就是 talentIndex）。
     */
    /** 数组的深拷贝（只处理元素是对象的场景，其余按原样放回）。 */
    private static JSONArray copyArray(JSONArray src) {
        JSONArray out = new JSONArray();
        for (int i = 0; i < src.length(); i++) {
            Object o = src.opt(i);
            out.put(o instanceof JSONObject ? copy((JSONObject) o) : o);
        }
        return out;
    }

    /** deepMerge 的静态版：mergeModuleTalents 是静态方法，改天赋时要用到同样的规则。 */
    private static void deepMergeInto(JSONObject target, JSONObject src) {
        java.util.Iterator<String> ks = src.keys();
        while (ks.hasNext()) {
            String k = ks.next();
            Object v = src.opt(k);
            if (v instanceof JSONObject) {
                JSONObject child = target.optJSONObject(k);
                boolean created = child == null;
                if (created) child = new JSONObject();
                deepMergeInto(child, (JSONObject) v);
                if (created) putSafe(target, k, child);
            } else if (v != null) {
                putSafe(target, k, v);
            }
        }
    }

    private static JSONArray mergeModuleTalents(JSONArray base, JSONArray changes) {
        JSONArray out = new JSONArray();
        for (int i = 0; i < base.length(); i++) {
            Object o = base.opt(i);
            out.put(o instanceof JSONObject ? copy((JSONObject) o) : o);
        }
        if (changes == null) return out;

        for (int j = 0; j < changes.length(); j++) {
            JSONObject ch = changes.optJSONObject(j);
            if (ch == null) continue;
            int idx = ch.optInt("talentIndex", -1);

            int at = -1;
            if (idx >= 0) {
                for (int i = 0; i < out.length(); i++) {
                    JSONObject t = out.optJSONObject(i);
                    if (t != null && t.optInt("index", Integer.MIN_VALUE) == idx) {
                        at = i;
                        break;
                    }
                }
            }

            JSONObject built = new JSONObject();
            java.util.Iterator<String> ks = ch.keys();
            while (ks.hasNext()) {
                String k = ks.next();
                if (k.equals("talentIndex")) continue;
                Object v = ch.opt(k);
                if (v != null) putSafe(built, k, v);
            }
            putSafe(built, "index", idx);
            putSafe(built, "fromModule", true);

            if (at < 0) {
                out.put(built);
                continue;
            }

            JSONObject old = out.optJSONObject(at);
            if (old == null) {
                out.put(built);
                continue;
            }
            for (String k : new String[]{"name", "desc", "descRaw"}) {
                if (built.optString(k, "").isEmpty()) {
                    Object ov = old.opt(k);
                    if (ov != null) putSafe(built, k, ov);
                }
            }
            for (String k : new String[]{"bb", "bbStr"}) {
                JSONObject o = old.optJSONObject(k);
                JSONObject sum = o != null ? copy(o) : new JSONObject();
                JSONObject c = built.optJSONObject(k);
                if (c != null) deepMergeInto(sum, c);
                putSafe(built, k, sum);
            }
            Object rg = built.opt("rangeGrid");
            if (rg == null || rg == JSONObject.NULL) {
                Object ov = old.opt("rangeGrid");
                putSafe(built, "rangeGrid", ov != null ? ov : JSONObject.NULL);
            }
            if (built.optString("tokenKey", "").isEmpty()) {
                Object ov = old.opt("tokenKey");
                putSafe(built, "tokenKey", ov != null ? ov : JSONObject.NULL);
            }
            putSafe(built, "hidden", old.optBoolean("hidden", false) && built.optBoolean("hidden", false));
            try { out.put(at, built); } catch (Exception ignored) { }
        }

        // 与 shared 层同一条过滤：什么都没有的天赋不留（模组里常见的「只隐藏」空壳）
        JSONArray kept = new JSONArray();
        for (int i = 0; i < out.length(); i++) {
            Object raw = out.opt(i);
            JSONObject t = raw instanceof JSONObject ? (JSONObject) raw : null;
            if (t == null) {
                kept.put(raw);
                continue;
            }
            boolean keep = !t.optString("name", "").isEmpty()
                    || !t.optString("desc", "").isEmpty()
                    || !t.optString("tokenKey", "").isEmpty();
            if (!keep) {
                JSONObject bb = t.optJSONObject("bb");
                if (bb != null && bb.length() > 0) keep = true;
            }
            if (keep) kept.put(t);
        }
        return kept;
    }

    /** 换携带技能：把 rec.skill 指向 skills[idx]（引擎只认单数那个 skill）。 */
    private void applySkillChoice(JSONObject rec, int idx) {
        JSONArray skills = rec.optJSONArray("skills");
        if (skills == null) return;
        JSONObject picked = skills.optJSONObject(idx);
        if (picked == null) return;
        putSafe(rec, "skill", copy(picked));
    }

    /** 基础数值：写进 stats；等级/阶段这类同时同步到 status。 */
    private void applyStats(JSONObject rec, JSONObject patch) {
        if (patch == null || patch.length() == 0) return;
        JSONObject stats = rec.optJSONObject("stats");
        boolean created = stats == null;
        if (created) stats = new JSONObject();
        java.util.Iterator<String> ks = patch.keys();
        while (ks.hasNext()) {
            String k = ks.next();
            Object v = patch.opt(k);
            if (!(v instanceof Number)) continue;
            putSafe(stats, k, v);
            if (k.equals("level") || k.equals("phase") || k.equals("skillLevel")
                    || k.equals("equipLevel") || k.equals("potRank")) {
                JSONObject status = rec.optJSONObject("status");
                if (status != null) putSafe(status, k, v);
            }
        }
        if (created) putSafe(rec, "stats", stats);
    }

    /** 职业特性：trait.traitOverride 这种路径式覆盖。 */
    private void applyTrait(JSONObject rec, JSONObject patch, String field) {
        if (patch == null || patch.length() == 0) return;
        JSONObject trait = rec.optJSONObject(field);
        boolean created = trait == null;
        if (created) trait = new JSONObject();
        deepMerge(trait, patch);
        if (created) putSafe(rec, field, trait);
    }

    /** 天赋：按天赋序号（"0"、"1"）合并 bb / desc 等字段。 */
    private void applyTalents(JSONObject rec, JSONObject patch) {
        if (patch == null || patch.length() == 0) return;
        JSONArray talents = rec.optJSONArray("talents");
        if (talents == null) return;
        java.util.Iterator<String> idxIt = patch.keys();
        while (idxIt.hasNext()) {
            String idxKey = idxIt.next();
            int idx;
            try {
                idx = Integer.parseInt(idxKey);
            } catch (NumberFormatException e) {
                continue;
            }
            if (idx < 0 || idx >= talents.length()) continue;
            JSONObject target = talents.optJSONObject(idx);
            JSONObject delta = patch.optJSONObject(idxKey);
            if (target == null || delta == null) continue;
            deepMerge(target, delta);
        }
    }

    /**
     * 技能数值（「修改技能数值」）。
     *
     * 为什么按**下标**存而不是按 skillId：同一个干员三个技能的 skillId 各不相同，玩家改的是
     * 「第一 / 第二 / 第三技能」这个位置，位置才是稳定的锚点。记录里 skills[] 与 skill（当前携带的那个）
     * 是两份独立副本，只改一份的话——沙盒读 skills[]、详情面板读 skill——两边会显示不同的数。
     * 所以这里同时写：skills[idx]，并在 skill.index == idx 时把同样的值叠到 skill 上。
     *
     * 只认白名单键：spCost / initSp / duration / level / maxChargeTime / increment / durationType / spType。
     * 不给「改攻击范围」—— 用户明确要求攻击范围不可改（rangeId / rangeGrid 一个都不在这里）。
     */
    private void applySkills(JSONObject rec, JSONObject patch) {
        if (patch == null || patch.length() == 0) return;
        JSONArray skills = rec.optJSONArray("skills");
        java.util.Iterator<String> keys = patch.keys();
        while (keys.hasNext()) {
            String idxKey = keys.next();
            int idx;
            try {
                idx = Integer.parseInt(idxKey);
            } catch (NumberFormatException e) {
                continue;
            }
            JSONObject delta = patch.optJSONObject(idxKey);
            if (delta == null) continue;
            JSONObject target = skills != null && idx >= 0 && idx < skills.length() ? skills.optJSONObject(idx) : null;
            // 有的老记录没有 skills[]，只有单个 skill：下标 0 就落到它身上
            if (target == null && idx == 0) target = rec.optJSONObject("skill");
            if (target == null) continue;
            mergeSkillNumbers(target, delta);
            JSONObject cur = rec.optJSONObject("skill");
            if (cur != null && cur != target && cur.optInt("index", -1) == idx) mergeSkillNumbers(cur, delta);
        }
    }

    private static void mergeSkillNumbers(JSONObject target, JSONObject delta) {
        java.util.Iterator<String> ks = delta.keys();
        while (ks.hasNext()) {
            String k = ks.next();
            Object v = delta.opt(k);
            boolean numeric = k.equals("spCost") || k.equals("initSp") || k.equals("duration")
                    || k.equals("level") || k.equals("maxChargeTime") || k.equals("increment");
            boolean textual = k.equals("spType") || k.equals("durationType");
            if (numeric && v instanceof Number) putSafe(target, k, v);
            else if (textual && v instanceof String) putSafe(target, k, v);
            // 其余键（rangeId / rangeGrid / desc / bb …）一律忽略：既不支持也不该被顺手改掉
        }
    }

    /** 模组：按 uniEquipId 找到 modules 里那一条，合并 level / attr / traitOverride / talentChanges。 */
    private void applyModules(JSONObject rec, JSONObject patch) {
        if (patch == null || patch.length() == 0) return;
        JSONArray modules = rec.optJSONArray("modules");
        if (modules == null) return;
        java.util.Iterator<String> ids = patch.keys();
        while (ids.hasNext()) {
            String uid = ids.next();
            JSONObject delta = patch.optJSONObject(uid);
            if (delta == null) continue;
            for (int i = 0; i < modules.length(); i++) {
                JSONObject mod = modules.optJSONObject(i);
                if (mod == null) continue;
                if (!uid.equals(mod.optString("uniEquipId", ""))) continue;

                Object level = delta.opt("level");
                if (level instanceof Number) putSafe(mod, "level", level);

                JSONObject attr = delta.optJSONObject("attr");
                if (attr != null) {
                    JSONObject target = mod.optJSONObject("attr");
                    boolean created = target == null;
                    if (created) target = new JSONObject();
                    mergeNumbers(target, attr);
                    if (created) putSafe(mod, "attr", target);
                }

                JSONObject trait = delta.optJSONObject("traitOverride");
                if (trait != null) {
                    JSONObject target = mod.optJSONObject("traitOverride");
                    boolean created = target == null;
                    if (created) target = new JSONObject();
                    deepMerge(target, trait);
                    if (created) putSafe(mod, "traitOverride", target);
                }

                JSONObject tc = delta.optJSONObject("talentChanges");
                if (tc != null) {
                    JSONArray changes = mod.optJSONArray("talentChanges");
                    if (changes != null) {
                        java.util.Iterator<String> ks = tc.keys();
                        while (ks.hasNext()) {
                            String idxKey = ks.next();
                            int k;
                            try {
                                k = Integer.parseInt(idxKey);
                            } catch (NumberFormatException e) {
                                continue;
                            }
                            if (k < 0 || k >= changes.length()) continue;
                            JSONObject target = changes.optJSONObject(k);
                            JSONObject delta2 = tc.optJSONObject(idxKey);
                            if (target != null && delta2 != null) deepMerge(target, delta2);
                        }
                    }
                }
                break;
            }
        }
    }

    /** 只合并数字字段（用于 attr，避免把结构写坏）。 */
    private void mergeNumbers(JSONObject target, JSONObject src) {
        java.util.Iterator<String> ks = src.keys();
        while (ks.hasNext()) {
            String k = ks.next();
            Object v = src.opt(k);
            if (v instanceof Number) putSafe(target, k, v);
        }
    }

    /** 深层合并：对象递归、数组按下标、标量直接覆盖。用于天赋/特性里嵌套的 bb。 */
    private void deepMerge(JSONObject target, JSONObject src) {
        java.util.Iterator<String> ks = src.keys();
        while (ks.hasNext()) {
            String k = ks.next();
            Object v = src.opt(k);
            if (v instanceof JSONObject) {
                JSONObject child = target.optJSONObject(k);
                boolean created = child == null;
                if (created) child = new JSONObject();
                deepMerge(child, (JSONObject) v);
                if (created) putSafe(target, k, child);
            } else if (v instanceof JSONArray) {
                // 数组整体覆盖（天赋的 bb 是对象，数组极少，简单处理即可）
                putSafe(target, k, v);
            } else if (v != null) {
                putSafe(target, k, v);
            }
        }
    }

    /**
     * 深拷贝（org.json 的 JSONObject(String) 会抛 JSONException，到处 try/catch 太吵）。
     * 失败时返回空对象而不是 null —— 调用点都是「拿拷贝去改」，空对象最坏是改成空，不会 NPE。
     */
    private static JSONObject copy(JSONObject src) {
        if (src == null) return new JSONObject();
        try {
            return new JSONObject(src.toString());
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void putSafe(JSONObject o, String key, Object value) {
        try {
            o.put(key, value);
        } catch (Exception ignored) {
        }
    }
}
