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
 * 四类改动互相独立，所以「只还原模组」「只还原天赋」做得到 —— 前端按类别 DELETE 对应键即可。
 *
 * 为什么按类别分开存：玩家经常只想把模组改回去而保留自己调过的基础数值。
 * 混在一个扁平对象里就没法分开还原了。
 */
public final class OperatorStore {

    /** 认可的四个改动类别。 */
    public static final String[] CATEGORIES = {"stats", "trait", "talents", "modules"};

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
            applyStats(rec, patch.optJSONObject("stats"));
            applyTrait(rec, patch.optJSONObject("trait"), "trait");
            applyTalents(rec, patch.optJSONObject("talents"));
            applyModules(rec, patch.optJSONObject("modules"));
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
        helper.applyStats(copy, patch.optJSONObject("stats"));
        helper.applyTrait(copy, patch.optJSONObject("trait"), "trait");
        helper.applyTalents(copy, patch.optJSONObject("talents"));
        helper.applyModules(copy, patch.optJSONObject("modules"));
        return copy;
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

    private static void putSafe(JSONObject o, String key, Object value) {
        try {
            o.put(key, value);
        } catch (Exception ignored) {
        }
    }
}
