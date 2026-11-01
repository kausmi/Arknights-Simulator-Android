package com.arksim.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本机静态服务：把 node 版 server/sandbox/index.js 的三件事搬到 Java ——
 * 发静态文件（public / data / shared / sim / music 五个挂载点）、读写关卡库、列音乐。
 *
 * 只监听 127.0.0.1，不对外。每个请求一条连接、用完即关，实现简单且够快。
 */
public final class HttpService {

    private static final int MAX_LEVEL_BYTES = 600 * 1024;

    private final File root;
    private final File publicDir;
    private final File levelsDir;
    /** 干员满配数值（原样，只读）。 */
    private final File operatorsFile;
    /** 玩家改过的干员数值（覆盖层；不存在表示一个都没改）。 */
    private final File overridesFile;
    /** 自定义干员表（玩家自己造的，实验功能）。 */
    private final File customFile;
    private final int port;

    /** 解析过的原表，避免每次请求都重读 2 MB JSON。 */
    private volatile JSONObject operatorsCache;

    private ServerSocket server;
    private volatile boolean running;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    public HttpService(File root, int port) {
        this.root = root;
        this.publicDir = new File(root, "public");
        this.levelsDir = new File(root, "content/levels");
        this.operatorsFile = new File(root, "data/aue-operators.json");
        this.overridesFile = new File(root, "data/operator-overrides.json");
        // 玩家自己造的干员（实验功能）：单独一份，不混进官方表，也不进覆盖表。
        // 服务端在 /data/aue-operators.json 里把它们合并进去，前端就当成普通干员用。
        this.customFile = new File(root, "data/custom-operators.json");
        this.port = port;
    }

    public void start() throws IOException {
        server = new ServerSocket(port, 64, InetAddress.getByName("127.0.0.1"));
        running = true;
        Thread t = new Thread(() -> {
            while (running) {
                try {
                    final Socket s = server.accept();
                    pool.execute(() -> serve(s));
                } catch (IOException e) {
                    if (running) e.printStackTrace();
                }
            }
        }, "arksim-http");
        t.setDaemon(true);
        t.start();
    }

    public void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    // ── 请求处理 ────────────────────────────────────────────────────────

    private void serve(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream(), 64 * 1024);

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase(Locale.ROOT);
            String url = parts[1];

            Map<String, String> headers = new HashMap<>();
            for (int i = 0; i < 64; i++) {
                String line = readLine(in);
                if (line == null || line.isEmpty()) break;
                int c = line.indexOf(':');
                if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(Locale.ROOT), line.substring(c + 1).trim());
            }

            handle(method, url, headers, in, out);
            out.flush();
        } catch (IOException ignored) {
            // 客户端断开（页面跳转时很常见），不是错误
        } catch (Throwable t) {
            android.util.Log.e("arksim-http", "serve failed", t);
        }
    }

    private void handle(String method, String url, Map<String, String> headers,
                        InputStream in, OutputStream out) throws IOException {
        int q = url.indexOf('?');
        String rawPath = q >= 0 ? url.substring(0, q) : url;
        String query = q >= 0 ? url.substring(q + 1) : "";

        if (rawPath.equals("/")) {
            redirect(out, "/studio/home.html");
            return;
        }
        if (rawPath.equals("/healthz")) {
            json(out, 200, "{\"ok\":true,\"mode\":\"sandbox\",\"app\":\"arksim\"}");
            return;
        }
        if (rawPath.equals("/api/debug")) {
            json(out, 200, "{\"debug\":false}");
            return;
        }
        if (rawPath.equals("/api/music")) {
            json(out, 200, musicJson());
            return;
        }
        if (rawPath.equals("/api/levels")) {
            json(out, 200, levelsJson());
            return;
        }
        if (rawPath.equals("/api/log") && method.equals("POST")) {
            drain(in);
            json(out, 200, "{\"ok\":true}");
            return;
        }
        // 轻量版：只回答「现在有几个干员被改过」，给沙盒界面的常驻提示用（不必拉 2 MB 原表）。
        if (rawPath.equals("/api/operator-edits")) {
            json(out, 200, operatorEditsJson());
            return;
        }
        if (rawPath.equals("/api/operators")) {
            json(out, 200, operatorsJson());
            return;
        }
        if (rawPath.equals("/api/custom-operators")) {
            json(out, 200, customOperatorsJson());
            return;
        }
        if (rawPath.startsWith("/api/custom-operators/")) {
            handleCustomOperator(method, rawPath.substring("/api/custom-operators/".length()), in, out);
            return;
        }
        if (rawPath.startsWith("/api/operators/")) {
            handleOperatorOverride(method, rawPath.substring("/api/operators/".length()), in, out);
            return;
        }
        if (rawPath.startsWith("/api/levels/")) {
            handleLevel(method, rawPath.substring("/api/levels/".length()), query, in, out);
            return;
        }
        // 干员表：把玩家改过的数值叠在官方原表上再发出去，前端就不需要为「改数值」做任何适配。
        // 原表本身还在磁盘上，编辑器要显示原值 + 改后值的对照，走 /api/operators。
        if (rawPath.equals("/data/aue-operators.json")) {
            byte[] body = effectiveOperatorsJson().getBytes(StandardCharsets.UTF_8);
            writeResponse(out, 200, "application/json; charset=utf-8", body, method.equals("HEAD"), null);
            return;
        }
        if (rawPath.equals("/data.js")) {
            byte[] body = DATA_SHIM_JS.getBytes(StandardCharsets.UTF_8);
            writeResponse(out, 200, "text/javascript; charset=utf-8", body, false, null);
            return;
        }
        if (!method.equals("GET") && !method.equals("HEAD")) {
            json(out, 405, "{\"ok\":false,\"error\":\"仅支持读取\"}");
            return;
        }
        serveStatic(method, rawPath, headers, out);
    }

    /** JSONObject.toString(indent) 同样声明了 JSONException。 */
    private static String jsonText(JSONObject o) {
        try {
            return o.toString(1);
        } catch (Exception e) {
            return o.toString();
        }
    }

    /** org.json 的 put 在 android.jar 里声明了 JSONException，实际不会抛，包一层省事。 */
    private static void put(JSONObject o, String key, Object value) {
        try {
            o.put(key, value);
        } catch (Exception ignored) {
        }
    }

    // ── 关卡库 ─────────────────────────────────────────────────────────

    private static final java.util.regex.Pattern LEVEL_FILE =
            java.util.regex.Pattern.compile("^[^\\\\/:*?\"<>|\\x00-\\x1f]{1,80}\\.json$");

    private File resolveLevel(String name) {
        if (name == null || !LEVEL_FILE.matcher(name).matches() || name.equals("manifest.json")) return null;
        File f = new File(levelsDir, name);
        try {
            String base = levelsDir.getCanonicalPath() + File.separator;
            return f.getCanonicalPath().startsWith(base) ? f : null;
        } catch (IOException e) {
            return null;
        }
    }

    private String levelsJson() {
        JSONArray arr = new JSONArray();
        File[] files = levelsDir.listFiles();
        if (files != null) {
            List<String> names = new ArrayList<>();
            for (File f : files) {
                String n = f.getName();
                if (f.isFile() && LEVEL_FILE.matcher(n).matches() && !n.startsWith(".") && !n.equals("manifest.json")) {
                    names.add(n);
                }
            }
            java.util.Collections.sort(names);
            for (String n : names) {
                try {
                    String text = readText(new File(levelsDir, n));
                    JSONObject row = new JSONObject();
                    put(row, "file", n);
                    put(row, "level", new JSONObject(text));
                    arr.put(row);
                } catch (Exception ignored) {
                    // 坏档跳过，不让一个坏文件毁掉整张列表
                }
            }
        }
        JSONObject o = new JSONObject();
        put(o, "levels", arr);
        return o.toString();
    }

    private void handleLevel(String method, String rawName, String query,
                             InputStream in, OutputStream out) throws IOException {
        String file = decodeComponent(rawName);
        File abs = resolveLevel(file);
        if (abs == null) {
            json(out, 400, "{\"ok\":false,\"error\":\"关卡文件名无效\"}");
            return;
        }
        if (method.equals("PUT") || method.equals("POST")) {
            String body = readBody(in, MAX_LEVEL_BYTES);
            if (body == null) {
                json(out, 413, "{\"ok\":false,\"error\":\"关卡文件过大\"}");
                return;
            }
            JSONObject level;
            try {
                level = new JSONObject(body);
            } catch (Exception e) {
                json(out, 400, "{\"ok\":false,\"error\":\"不是合法 JSON\"}");
                return;
            }
            if (level.optInt("v", -1) != 2 || !(level.opt("id") instanceof String) || !(level.opt("name") instanceof String)
                    || !level.has("stage")) {
                json(out, 400, "{\"ok\":false,\"error\":\"不是 v2 关卡\"}");
                return;
            }
            levelsDir.mkdirs();
            String from = param(query, "from");
            if (from != null && !from.isEmpty() && !from.equals(file)) {
                File oldAbs = resolveLevel(from);
                if (oldAbs == null) {
                    json(out, 400, "{\"ok\":false,\"error\":\"原关卡文件名无效\"}");
                    return;
                }
                if (abs.exists()) {
                    json(out, 409, "{\"ok\":false,\"error\":\"已经有同名的关卡文件了\"}");
                    return;
                }
                if (oldAbs.exists() && !oldAbs.renameTo(abs)) {
                    json(out, 500, "{\"ok\":false,\"error\":\"改名失败\"}");
                    return;
                }
            } else if (abs.exists()) {
                JSONObject current = null;
                try {
                    current = new JSONObject(readText(abs));
                } catch (Exception ignored) {
                }
                if (current != null && !String.valueOf(current.opt("id")).equals(String.valueOf(level.opt("id")))) {
                    json(out, 409, "{\"ok\":false,\"error\":\"这个名字已被另一张关卡占用\"}");
                    return;
                }
            }
            File tmp = new File(abs.getPath() + ".tmp");
            try (FileOutputStream fos = new FileOutputStream(tmp)) {
                fos.write(jsonText(level).getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(abs)) {
                tmp.delete();
                json(out, 500, "{\"ok\":false,\"error\":\"写入失败\"}");
                return;
            }
            JSONObject ok = new JSONObject();
            put(ok, "ok", true);
            put(ok, "file", file);
            json(out, 200, ok.toString());
            return;
        }
        if (method.equals("DELETE")) {
            abs.delete();
            json(out, 200, "{\"ok\":true}");
            return;
        }
        if (!abs.isFile()) {
            json(out, 404, "{\"ok\":false,\"error\":\"关卡不存在\"}");
            return;
        }
        try {
            JSONObject o = new JSONObject();
            put(o, "file", file);
            put(o, "level", new JSONObject(readText(abs)));
            json(out, 200, o.toString());
        } catch (Exception e) {
            json(out, 500, "{\"ok\":false,\"error\":\"读档失败\"}");
        }
    }

    // ── 干员数值 ───────────────────────────────────────────────────────
    //
    // 原表 data/aue-operators.json 只读；玩家改的数值单独存在 data/operator-overrides.json，
    // 形如 {"version":1,"operators":{"<chessId>":{"maxHp":2900,"atk":980}}}。
    //
    // 前端加载干员时（sandbox/js/operator-library.js）把这份覆盖贴上去，于是：
    //   - 改动只涉及被编辑过的字段，其余仍跟随官方数据；
    //   - 想恢复原样只要删掉对应的键；
    //   - 服务端不需要改写 2 MB 的原表，也不会因为一次误改把整份数据弄坏。

    /** 原表（带缓存）。 */
    private JSONObject operatorsNative() {
        JSONObject cached = operatorsCache;
        if (cached != null) return cached;
        try {
            cached = new JSONObject(readText(operatorsFile));
        } catch (Exception e) {
            try {
                cached = new JSONObject("{\"version\":1,\"operators\":{}}");
            } catch (Exception ignored) {
                cached = null;
            }
        }
        operatorsCache = cached;
        return cached;
    }

    private JSONObject readOverrides() {
        if (!overridesFile.isFile()) {
            try {
                return new JSONObject("{\"version\":1,\"operators\":{}}");
            } catch (Exception e) {
                return null;
            }
        }
        try {
            JSONObject o = new JSONObject(readText(overridesFile));
            if (o.optJSONObject("operators") == null) o = new JSONObject("{\"version\":1,\"operators\":{}}");
            return o;
        } catch (Exception e) {
            try {
                return new JSONObject("{\"version\":1,\"operators\":{}}");
            } catch (Exception ignored) {
                return null;
            }
        }
    }

    private void writeOverrides(JSONObject o) throws IOException {
        File dir = overridesFile.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建目录 " + dir);
        File tmp = new File(overridesFile.getPath() + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(jsonText(o).getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(overridesFile)) {
            tmp.delete();
            throw new IOException("写入失败");
        }
    }

    // ── 干员数值（读写见 OperatorStore） ───────────────────────────────

    private OperatorStore operatorStore() {
        JSONObject nativeTable;
        try {
            nativeTable = operatorsNative();
        } catch (Exception e) {
            nativeTable = null;
        }
        JSONObject overrides = readOverrides();
        return new OperatorStore(nativeTable, overrides);
    }

    /** GET /api/operator-edits → {count, ids:[...], byId:{id:[categories]}} */
    private String operatorEditsJson() {
        OperatorStore st = operatorStore();
        JSONObject edits = st.edits();
        JSONArray ids = new JSONArray();
        JSONObject byId = new JSONObject();
        java.util.Iterator<String> it = edits.keys();
        while (it.hasNext()) {
            String id = it.next();
            if (!st.isEdited(id)) continue;
            ids.put(id);
            put(byId, id, st.editedCategories(id));
        }
        JSONObject out = new JSONObject();
        put(out, "count", ids.length());
        put(out, "ids", ids);
        put(out, "byId", byId);
        put(out, "categories", CATEGORIES_JSON);
        return out.toString();
    }

    /** GET /api/operators → { version, operators: 原表, edited: 覆盖表 } */
    private String operatorsJson() {
        JSONObject nativeTable = operatorsNative();
        JSONObject overrides = readOverrides();
        JSONObject out = new JSONObject();
        put(out, "version", nativeTable != null ? nativeTable.optInt("version", 1) : 1);
        put(out, "operators", nativeTable != null ? nativeTable.optJSONObject("operators") : new JSONObject());
        put(out, "edited", overrides != null ? overrides.optJSONObject("operators") : new JSONObject());
        put(out, "categories", CATEGORIES_JSON);
        return out.toString();
    }

    /** 官方原表 + 玩家覆盖 + 自定义干员，叠成前端实际使用的那份（/data/aue-operators.json）。 */
    private String effectiveOperatorsJson() {
        JSONObject effective = operatorStore().effectiveOperators();
        if (effective.length() == 0) effective = new JSONObject();
        // 自定义干员（实验功能）也并进去：前端把它们当普通干员用，手牌/牌库/存档都认。
        JSONObject ops = effective.optJSONObject("operators");
        if (ops == null) {
            ops = new JSONObject();
            put(effective, "operators", ops);
        }
        JSONObject custom = readCustom();
        JSONObject customOps = custom != null ? custom.optJSONObject("operators") : null;
        if (customOps != null) {
            java.util.Iterator<String> it = customOps.keys();
            while (it.hasNext()) {
                String id = it.next();
                put(ops, id, customOps.opt(id));
            }
        }
        if (effective.opt("version") == null) put(effective, "version", 1);
        return effective.toString();
    }

    private static final JSONArray CATEGORIES_JSON = makeCategories();

    private static JSONArray makeCategories() {
        JSONArray a = new JSONArray();
        a.put("stats");
        a.put("trait");
        a.put("talents");
        a.put("modules");
        return a;
    }

    /**
     * POST   /api/operators/&lt;id&gt;[/&lt;category&gt;]   写入覆盖（category 省略 = stats）
     * DELETE /api/operators/&lt;id&gt;                    撤销该干员全部改动
     * DELETE /api/operators/&lt;id&gt;/&lt;category&gt;      只撤销某一类（stats/trait/talents/modules）
     * DELETE /api/operators/ALL                      撤销所有干员
     * DELETE /api/operators/ALL/&lt;category&gt;         只撤销所有干员的某一类
     */
    private void handleOperatorOverride(String method, String rawName, InputStream in, OutputStream out)
            throws IOException {
        String rest = decodeComponent(rawName);
        if (rest == null || rest.isEmpty() || rest.length() > 160) {
            json(out, 400, "{\"ok\":false,\"error\":\"干员 id 无效\"}");
            return;
        }

        // 拆 id / category
        String id = rest;
        String category = "stats";
        int slash = rest.indexOf('/');
        if (slash >= 0) {
            id = rest.substring(0, slash);
            category = rest.substring(slash + 1);
        }
        if (id.contains("..") || id.contains("\\")) {
            json(out, 400, "{\"ok\":false,\"error\":\"干员 id 无效\"}");
            return;
        }
        if (!isKnownCategory(category)) {
            json(out, 400, "{\"ok\":false,\"error\":\"未知的改动类别：" + category + "\"}");
            return;
        }

        JSONObject rootObj = readOverrides();
        if (rootObj == null) {
            json(out, 500, "{\"ok\":false,\"error\":\"无法读取覆盖表\"}");
            return;
        }
        JSONObject ops = rootObj.optJSONObject("operators");
        if (ops == null) {
            ops = new JSONObject();
            put(rootObj, "operators", ops);
        }

        // ---- DELETE ----
        if (method.equals("DELETE")) {
            try {
                boolean all = id.equals("ALL");
                if (all) {
                    // ALL/category：只清这一类；ALL（无 category 后缀）清全部
                    if (slash >= 0) {
                        java.util.Iterator<String> ids = ops.keys();
                        java.util.List<String> targets = new java.util.ArrayList<>();
                        while (ids.hasNext()) targets.add(ids.next());
                        for (String oid : targets) {
                            JSONObject e = ops.optJSONObject(oid);
                            if (e == null) continue;
                            e.remove(category);
                            if (e.length() == 0) ops.remove(oid);
                        }
                    } else {
                        ops = new JSONObject();
                        put(rootObj, "operators", ops);
                    }
                } else {
                    JSONObject e = ops.optJSONObject(id);
                    if (e != null) {
                        e.remove(category);
                        if (e.length() == 0) ops.remove(id);
                    }
                }
                writeOverrides(rootObj);
                JSONObject ok = new JSONObject();
                put(ok, "ok", true);
                put(ok, "id", id);
                put(ok, "category", category);
                json(out, 200, ok.toString());
            } catch (Exception e) {
                json(out, 500, "{\"ok\":false,\"error\":\"写入失败\"}");
            }
            return;
        }

        if (!method.equals("POST") && !method.equals("PUT")) {
            json(out, 405, "{\"ok\":false,\"error\":\"仅支持读取\"}");
            return;
        }

        // ---- 写入 ----
        String body = readBody(in, 64 * 1024);
        if (body == null) {
            json(out, 413, "{\"ok\":false,\"error\":\"改动过大\"}");
            return;
        }
        JSONObject patch;
        try {
            patch = new JSONObject(body);
        } catch (Exception e) {
            json(out, 400, "{\"ok\":false,\"error\":\"不是合法的 JSON\"}");
            return;
        }
        if (patch.length() == 0) {
            json(out, 400, "{\"ok\":false,\"error\":\"改动为空\"}");
            return;
        }

        JSONObject merged = new JSONObject();
        JSONObject prev = ops.optJSONObject(id);
        JSONObject prevPart = prev == null ? null : prev.optJSONObject(category);
        if (prevPart != null) mergeDuplicate(prevPart, merged);
        mergeDuplicate(patch, merged);
        put(ops, id, mergeInto(prev, category, merged));

        try {
            writeOverrides(rootObj);
        } catch (Exception e) {
            json(out, 500, "{\"ok\":false,\"error\":\"写入失败\"}");
            return;
        }
        JSONObject ok = new JSONObject();
        put(ok, "ok", true);
        put(ok, "id", id);
        put(ok, "category", category);
        put(ok, "patch", merged);
        put(ok, "edited", operatorStore().editedCategories(id));
        json(out, 200, ok.toString());
    }

    private static boolean isKnownCategory(String c) {
        for (String k : OperatorStore.CATEGORIES) if (k.equals(c)) return true;
        return false;
    }

    /** 把已有类别对象合并进一个干净的顶层对象。 */
    private static JSONObject mergeInto(JSONObject prev, String category, JSONObject part) {
        JSONObject out = new JSONObject();
        if (prev != null) {
            java.util.Iterator<String> it = prev.keys();
            while (it.hasNext()) {
                String k = it.next();
                if (k.equals(category)) continue;
                put(out, k, prev.opt(k));
            }
        }
        put(out, category, part);
        return out;
    }

    /** 深拷贝合并（对象递归、标量覆盖）。 */
    private static void mergeDuplicate(JSONObject src, JSONObject target) {
        java.util.Iterator<String> it = src.keys();
        while (it.hasNext()) {
            String k = it.next();
            Object v = src.opt(k);
            if (v instanceof JSONObject) {
                JSONObject child = target.optJSONObject(k);
                boolean created = child == null;
                if (created) child = new JSONObject();
                mergeDuplicate((JSONObject) v, child);
                if (created) put(target, k, child);
            } else if (v != null) {
                put(target, k, v);
            }
        }
    }

    // ── 自定义干员（实验功能） ─────────────────────────────────────────
    //
    // 玩家自己捏一位干员：名字、职业、位置、星级、基础数值、攻击范围、技能。
    // 存 data/custom-operators.json，并在 /data/aue-operators.json 里合并进去 ——
    // 前端不用改任何东西，就当成普通干员用（手牌、牌库、存档都认）。
    //
    // 这是实验功能：数值不会经过任何平衡校核，技能只支持「数值型」的基础描述，
    // 官方那套复杂技能（召唤物、复杂条件）不在支持范围内。

    private static final int MAX_CUSTOM = 64;

    private JSONObject readCustom() {
        if (!customFile.isFile()) {
            try {
                return new JSONObject("{\"version\":1,\"operators\":{}}");
            } catch (Exception e) {
                return null;
            }
        }
        try {
            JSONObject o = new JSONObject(readText(customFile));
            if (o.optJSONObject("operators") == null) o = new JSONObject("{\"version\":1,\"operators\":{}}");
            return o;
        } catch (Exception e) {
            try {
                return new JSONObject("{\"version\":1,\"operators\":{}}");
            } catch (Exception ignored) {
                return null;
            }
        }
    }

    private void writeCustom(JSONObject o) throws IOException {
        File dir = customFile.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建目录 " + dir);
        File tmp = new File(customFile.getPath() + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(jsonText(o).getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(customFile)) {
            tmp.delete();
            throw new IOException("写入失败");
        }
    }

    /** GET /api/custom-operators → {version, count, operators} */
    private String customOperatorsJson() {
        JSONObject o = readCustom();
        JSONObject out = new JSONObject();
        put(out, "version", o != null ? o.optInt("version", 1) : 1);
        put(out, "operators", o != null ? o.optJSONObject("operators") : new JSONObject());
        put(out, "count", o != null && o.optJSONObject("operators") != null ? o.optJSONObject("operators").length() : 0);
        return out.toString();
    }

    /**
     * POST   /api/custom-operators            新建（body = 干员记录）
     * POST   /api/custom-operators/&lt;id&gt;     修改
     * DELETE /api/custom-operators/&lt;id&gt;     删除
     * DELETE /api/custom-operators/ALL        全部删除
     */
    private void handleCustomOperator(String method, String rawName, InputStream in, OutputStream out)
            throws IOException {
        String id = decodeComponent(rawName);
        if (id == null || id.isEmpty() || id.length() > 64
                || id.contains("/") || id.contains("\\") || id.contains("..")) {
            json(out, 400, "{\"ok\":false,\"error\":\"干员 id 无效\"}");
            return;
        }
        JSONObject rootObj = readCustom();
        if (rootObj == null) {
            json(out, 500, "{\"ok\":false,\"error\":\"无法读取自定义干员表\"}");
            return;
        }
        JSONObject ops = rootObj.optJSONObject("operators");

        if (method.equals("DELETE")) {
            try {
                if (id.equals("ALL")) ops = new JSONObject();
                else ops.remove(id);
                put(rootObj, "operators", ops);
                writeCustom(rootObj);
                json(out, 200, "{\"ok\":true}");
            } catch (Exception e) {
                json(out, 500, "{\"ok\":false,\"error\":\"写入失败\"}");
            }
            return;
        }

        if (!method.equals("POST") && !method.equals("PUT")) {
            json(out, 405, "{\"ok\":false,\"error\":\"仅支持读取\"}");
            return;
        }

        String body = readBody(in, 64 * 1024);
        if (body == null) {
            json(out, 413, "{\"ok\":false,\"error\":\"内容过大\"}");
            return;
        }
        JSONObject rec;
        try {
            rec = new JSONObject(body);
        } catch (Exception e) {
            json(out, 400, "{\"ok\":false,\"error\":\"不是合法的 JSON\"}");
            return;
        }
        String targetId = id.equals("NEW") ? rec.optString("chessId", "") : id;
        if (!targetId.matches("^chess_[a-zA-Z0-9_]{1,56}$")) {
            json(out, 400, "{\"ok\":false,\"error\":\"chessId 必须以 chess_ 开头，只能是字母数字下划线\"}");
            return;
        }
        if (ops.has(targetId)) {
            // 已存在：只允许改，不许顶掉别人的
            if (!id.equals(targetId) && !id.equals("NEW")) {
                json(out, 409, "{\"ok\":false,\"error\":\"这个 id 已被占用\"}");
                return;
            }
        } else if (ops.length() >= MAX_CUSTOM) {
            json(out, 409, "{\"ok\":false,\"error\":\"自定义干员已达上限 " + MAX_CUSTOM + " 位\"}");
            return;
        }

        put(rec, "chessId", targetId);
        put(rec, "isDiy", true);
        put(rec, "chessType", "NORMAL");
        put(rec, "visible", true);
        put(ops, targetId, rec);

        try {
            writeCustom(rootObj);
        } catch (Exception e) {
            json(out, 500, "{\"ok\":false,\"error\":\"写入失败\"}");
            return;
        }
        JSONObject ok = new JSONObject();
        put(ok, "ok", true);
        put(ok, "id", targetId);
        json(out, 200, ok.toString());
    }

    // ── 音乐 ───────────────────────────────────────────────────────────

    private String musicJson() {
        File dir = new File(root, "content/music");
        List<String> names = new ArrayList<>();
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                String n = f.getName();
                if (f.isFile() && !n.startsWith(".") && n.toLowerCase(Locale.ROOT).endsWith(".ogg")) names.add(n);
            }
        }
        java.util.Collections.sort(names);
        JSONArray arr = new JSONArray();
        for (String n : names) {
            JSONObject row = new JSONObject();
            put(row, "name", n);
            put(row, "url", "/music/" + encodeComponent(n));
            arr.put(row);
        }
        JSONObject o = new JSONObject();
        put(o, "files", arr);
        return o.toString();
    }

    // ── 静态文件 ───────────────────────────────────────────────────────

    private static final Map<String, String> MOUNTS = new HashMap<>();

    static {
        MOUNTS.put("data", "data");
        MOUNTS.put("shared", "shared");
        MOUNTS.put("sim", "server/sim");
        MOUNTS.put("music", "content/music");
    }

    private void serveStatic(String method, String rawPath, Map<String, String> headers,
                             OutputStream out) throws IOException {
        String pathname;
        try {
            pathname = decodeComponent(rawPath);
        } catch (IllegalArgumentException e) {
            json(out, 400, "{\"ok\":false,\"error\":\"请求地址无效\"}");
            return;
        }
        pathname = pathname.replaceAll("^/(assets|fonts)/~[0-9a-f]{8,64}/", "/$1/");
        boolean media = pathname.startsWith("/media/");
        if (media) {
            pathname = "/assets/audio/" + pathname.substring("/media/".length()).replaceAll("^~[0-9a-f]{8,64}/", "");
        }
        String[] segments = pathname.split("/", -1);
        // segments[0] 是前导空串
        List<String> segs = new ArrayList<>();
        for (int i = 1; i < segments.length; i++) {
            String s = segments[i];
            if (s.isEmpty() || s.startsWith(".") || s.contains("\\") || s.contains(":")) {
                notFound(out);
                return;
            }
            segs.add(s);
        }
        if (segs.isEmpty()) {
            notFound(out);
            return;
        }

        String mountName = MOUNTS.containsKey(segs.get(0)) ? segs.get(0) : "public";
        File mountRoot = mountName.equals("public") ? publicDir : new File(root, MOUNTS.get(mountName));
        List<String> relative = mountName.equals("public") ? segs : segs.subList(1, segs.size());
        String lower = pathname.toLowerCase(Locale.ROOT);

        if (mountName.equals("music")) {
            if (!relative.isEmpty() && relative.get(0).equalsIgnoreCase("original")) {
                notFound(out);
                return;
            }
            if (!lower.endsWith(".ogg")) {
                notFound(out);
                return;
            }
        }
        if (mountName.equals("sim") && (!lower.endsWith(".js") || lower.matches(".*nodedata\\.js$"))) {
            notFound(out);
            return;
        }
        if (mountName.equals("data") && !lower.endsWith(".json")) {
            notFound(out);
            return;
        }

        String dest = headers.get("sec-fetch-dest");
        boolean musicShell = mountName.equals("public") && "document".equals(dest)
                && pathname.matches("^/studio/(home|console|play|level)\\.html$");

        List<String> target = musicShell ? Arrays.asList("studio", "music-shell.html") : relative;
        File candidate = join(mountRoot, target);

        List<File> files = new ArrayList<>();
        if (media && !hasExtension(candidate.getName())) {
            files.add(new File(candidate.getPath() + ".mp3"));
            files.add(new File(candidate.getPath() + ".ogg"));
        } else {
            files.add(candidate);
        }

        for (File f : files) {
            if (!f.isFile()) continue;
            String realRoot = mountRoot.getCanonicalPath();
            String real;
            try {
                real = f.getCanonicalPath();
            } catch (IOException e) {
                continue;
            }
            if (!real.startsWith(realRoot + File.separator)) continue;
            if (mountName.equals("music")) {
                String rel = real.substring(realRoot.length() + 1);
                String head = rel.split(File.separator)[0];
                if (head.equalsIgnoreCase("original")) continue;
                if (!real.toLowerCase(Locale.ROOT).endsWith(".ogg")) continue;
            }
            sendFile(method, f, headers, out);
            return;
        }
        notFound(out);
    }

    private void sendFile(String method, File file, Map<String, String> headers,
                          OutputStream out) throws IOException {
        long total = file.length();
        String mime = mimeOf(file.getName());
        boolean head = method.equals("HEAD");

        String rangeHeader = headers.get("range");
        long start = 0;
        long end = total - 1;
        boolean partial = false;
        if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
            String spec = rangeHeader.substring(6).trim();
            int dash = spec.indexOf('-');
            if (dash >= 0) {
                try {
                    String a = spec.substring(0, dash).trim();
                    String b = spec.substring(dash + 1).trim();
                    if (!a.isEmpty()) {
                        start = Long.parseLong(a);
                        if (!b.isEmpty()) end = Long.parseLong(b);
                    } else if (!b.isEmpty()) {
                        start = Math.max(0, total - Long.parseLong(b));
                    }
                    if (start < 0 || start >= total || end >= total || start > end) {
                        StringBuilder sb = new StringBuilder();
                        sb.append("HTTP/1.1 416 Range Not Satisfiable\r\n");
                        sb.append("Content-Range: bytes */").append(total).append("\r\n");
                        sb.append("Content-Length: 0\r\nConnection: close\r\n\r\n");
                        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
                        return;
                    }
                    partial = true;
                } catch (NumberFormatException ignored) {
                    start = 0;
                    end = total - 1;
                    partial = false;
                }
            }
        }

        long length = end - start + 1;
        StringBuilder sb = new StringBuilder();
        sb.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        sb.append("Content-Type: ").append(mime).append("\r\n");
        sb.append("Content-Length: ").append(length).append("\r\n");
        sb.append("Accept-Ranges: bytes\r\n");
        sb.append("Cache-Control: no-cache\r\n");
        sb.append("X-Content-Type-Options: nosniff\r\n");
        if (partial) sb.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(total).append("\r\n");
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        if (head) return;

        try (FileInputStream fis = new FileInputStream(file)) {
            long skipped = 0;
            while (skipped < start) {
                long n = fis.skip(start - skipped);
                if (n <= 0) break;
                skipped += n;
            }
            byte[] buf = new byte[64 * 1024];
            long left = length;
            while (left > 0) {
                int want = (int) Math.min(buf.length, left);
                int read = fis.read(buf, 0, want);
                if (read <= 0) break;
                out.write(buf, 0, read);
                left -= read;
            }
        }
    }

    private static File join(File base, List<String> parts) {
        File f = base;
        for (String p : parts) f = new File(f, p);
        return f;
    }

    private static boolean hasExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 && dot < name.length() - 1;
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        int dot = n.lastIndexOf('.');
        String ext = dot >= 0 ? n.substring(dot) : "";
        switch (ext) {
            case ".html": case ".htm": return "text/html; charset=utf-8";
            case ".js": case ".mjs": return "text/javascript; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".json": case ".map": return "application/json; charset=utf-8";
            case ".webmanifest": return "application/manifest+json; charset=utf-8";
            case ".txt": case ".atlas": return "text/plain; charset=utf-8";
            case ".md": return "text/markdown; charset=utf-8";
            case ".csv": return "text/csv; charset=utf-8";
            case ".xml": return "application/xml; charset=utf-8";
            case ".skel": case ".bin": return "application/octet-stream";
            case ".wasm": return "application/wasm";
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".gif": return "image/gif";
            case ".webp": return "image/webp";
            case ".avif": return "image/avif";
            case ".svg": return "image/svg+xml; charset=utf-8";
            case ".ico": return "image/x-icon";
            case ".mp3": return "audio/mpeg";
            case ".ogg": case ".oga": case ".opus": return "audio/ogg";
            case ".wav": return "audio/wav";
            case ".m4a": return "audio/mp4";
            case ".aac": return "audio/aac";
            case ".webm": return "video/webm";
            case ".mp4": return "video/mp4";
            case ".woff2": return "font/woff2";
            case ".woff": return "font/woff";
            case ".otf": return "font/otf";
            case ".ttf": return "font/ttf";
            default: return "application/octet-stream";
        }
    }

    // ── HTTP 小工具 ────────────────────────────────────────────────────

    private static void notFound(OutputStream out) throws IOException {
        writeResponse(out, 404, "text/html; charset=utf-8",
                "<!doctype html><meta charset=\"utf-8\"><title>404</title>"
                        .concat("<body style=\"background:#111614;color:#d8e3de;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0\">")
                        .concat("<div style=\"text-align:center\"><h1 style=\"color:#4ed8af;font-size:56px;margin:0\">404</h1><p>文件不存在</p></div>")
                        .getBytes(StandardCharsets.UTF_8), false, null);
    }

    private static void json(OutputStream out, int status, String body) throws IOException {
        writeResponse(out, status, "application/json; charset=utf-8", body.getBytes(StandardCharsets.UTF_8), false, null);
    }

    private static void redirect(OutputStream out, String location) throws IOException {
        String s = "HTTP/1.1 302 Found\r\nLocation: " + location + "\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(s.getBytes(StandardCharsets.UTF_8));
    }

    private static void writeResponse(OutputStream out, int status, String type, byte[] body,
                                      boolean head, String extraHeaders) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        sb.append("Content-Type: ").append(type).append("\r\n");
        sb.append("Content-Length: ").append(body.length).append("\r\n");
        sb.append("Cache-Control: no-store\r\n");
        sb.append("X-Content-Type-Options: nosniff\r\n");
        if (extraHeaders != null) sb.append(extraHeaders);
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        if (!head) out.write(body);
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 302: return "Found";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 413: return "Payload Too Large";
            case 414: return "URI Too Long";
            case 500: return "Internal Server Error";
            default: return "Status";
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') bos.write(c);
            if (bos.size() > 8192) break;
        }
        if (c < 0 && bos.size() == 0) return null;
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String readBody(InputStream in, int cap) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            if (bos.size() > cap) return null;
        }
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void drain(InputStream in) throws IOException {
        byte[] buf = new byte[8192];
        while (in.read(buf) > 0) {
            // 丢掉
        }
    }

    private static String readText(File f) throws IOException {
        try (FileInputStream fis = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static String param(String query, String key) {
        if (query == null || query.isEmpty()) return null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) continue;
            if (decodeComponent(pair.substring(0, eq)).equals(key)) return decodeComponent(pair.substring(eq + 1));
        }
        return null;
    }

    /** 百分号解码；非法序列抛 IllegalArgumentException。 */
    static String decodeComponent(String s) {
        if (s.indexOf('%') < 0) return s;
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%') {
                if (i + 2 >= s.length()) throw new IllegalArgumentException("bad escape");
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) throw new IllegalArgumentException("bad escape");
                sb.append((char) ((hi << 4) + lo));
                i += 2;
            } else {
                sb.append(c);
            }
        }
        byte[] raw = sb.toString().getBytes(StandardCharsets.ISO_8859_1);
        return new String(raw, StandardCharsets.UTF_8);
    }

    static String encodeComponent(String s) {
        StringBuilder sb = new StringBuilder();
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '~') {
                sb.append((char) c);
            } else {
                sb.append('%').append(String.format(Locale.ROOT, "%02X", c));
            }
        }
        return sb.toString();
    }

    private static final String DATA_SHIM_JS =
            "// Generated browser stand-in for server/data.js.\n"
                    + "import { getSimData } from './sim/simdata.js';\n"
                    + "export function getData() { return getSimData() || {}; }\n"
                    + "export function resetData() {}\n";
}
