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
    /**
     * 官方全干员牌库（原样，只读）。
     *
     * 为什么需要第二份表：data/aue-operators.json 是模拟器自己的「满配干员」表，只有 259 位
     * （官方池里的 6 星只覆盖到 7 位联动干员，银灰/凯尔希这些全缺）；而沙盒前端实际使用的是
     * data/operator-library.json（202 位官方干员，6 星 140 位）。干员数值页只看第一份，
     * 所以用户会看到「6 星 5 星根本不全」。编辑器必须把两份都列出来、两份都能改。
     */
    private final File libraryFile;
    /** 官方牌库的解析缓存。 */
    private volatile JSONObject libraryCache;
    /**
     * data/chess.json —— 前端 loadAll('chess') 真正用的那份，269 条，含塔露拉（char_1503_talula）、
     * 维娜、结城理这些 aue 表与官方牌库都没有的自设/联动干员。编辑器要能改到它们，
     * 就必须把它也并进来。
     */
    private final File chessFile;
    /** chess.json 的解析缓存。 */
    private volatile JSONObject chessCache;
    /**
     * data/local-skins.json —— extract_skins.py 解出来的皮肤索引（charId -> [{id,name,art,artB}]）。
     *
     * 只在玩家点过「解这个干员的皮肤」之后才存在；不存在就说明一套皮肤都没解，
     * 详情页的立绘下拉只剩精一 / 精二两张。
     */
    private final File skinsFile;
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
        this.libraryFile = new File(root, "data/operator-library.json");
        this.chessFile = new File(root, "data/chess.json");
        this.skinsFile = new File(root, "data/local-skins.json");
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
        // 官方全干员牌库同样要叠覆盖 —— 沙盒里真正生效的是这一份。
        if (rawPath.equals("/data/operator-library.json")) {
            byte[] body = effectiveLibraryJson().getBytes(StandardCharsets.UTF_8);
            writeResponse(out, 200, "application/json; charset=utf-8", body, method.equals("HEAD"), null);
            return;
        }
        if (rawPath.equals("/data/aue-operators.json")) {
            byte[] body = effectiveOperatorsJson().getBytes(StandardCharsets.UTF_8);
            writeResponse(out, 200, "application/json; charset=utf-8", body, method.equals("HEAD"), null);
            return;
        }
        // chess.json 才是沙盒里「真正出战的那份表」（前端 loadAll('chess') 加载它），
        // 里面还有塔露拉这类官方没出的自设干员。改了数值必须让这份也跟着变，
        // 否则编辑器改完、进沙盒发现根本没生效。
        if (rawPath.equals("/data/chess.json")) {
            byte[] body = effectiveChessJson().getBytes(StandardCharsets.UTF_8);
            writeResponse(out, 200, "application/json; charset=utf-8", body, method.equals("HEAD"), null);
            return;
        }
        // 玩家在详情页选的立绘 / 皮肤 + 本机解出来的皮肤索引。
        // 合成一份给前端一步拿全，省得它先读覆盖表、再按 chessId→charId 自己换算。
        if (rawPath.equals("/data/operator-art.json")) {
            byte[] body = operatorArtJson().getBytes(StandardCharsets.UTF_8);
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

    /** 官方全干员牌库（带缓存）。 */
    private JSONObject libraryNative() {
        JSONObject cached = libraryCache;
        if (cached != null) return cached;
        try {
            cached = new JSONObject(readText(libraryFile));
        } catch (Exception e) {
            try {
                cached = new JSONObject("{\"version\":1,\"operators\":{}}");
            } catch (Exception ignored) {
                cached = null;
            }
        }
        libraryCache = cached;
        return cached;
    }

    /**
     * data/chess.json（带缓存）。
     *
     * 这份是「扁平表」——顶层直接是 chessId -> 记录，没有 operators 包一层。
     * 前端 data.loadAll('chess') 读的就是它，所以编辑器要对齐到「实际在用的那份」。
     */
    private JSONObject chessNative() {
        JSONObject cached = chessCache;
        if (cached != null) return cached;
        try {
            cached = new JSONObject(readText(chessFile));
        } catch (Exception e) {
            try {
                cached = new JSONObject("{}");
            } catch (Exception ignored) {
                cached = null;
            }
        }
        chessCache = cached;
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
        JSONObject table;
        try {
            // 用合并表：覆盖表里可能出现官方牌库的键（si_char_003_kalts），
            // 只用 aue 表的话那些改动永远叠不上去。
            JSONObject ops = mergedOperators();
            table = new JSONObject();
            put(table, "version", 1);
            put(table, "operators", ops);
        } catch (Exception e) {
            table = null;
        }
        JSONObject overrides = readOverrides();
        return new OperatorStore(table, overrides);
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

    /**
     * GET /api/operators → { version, operators: 合并后的原表, edited: 覆盖表, categories }
     *
     * operators 里是**两份表合并**的结果：官方牌库（operator-library.json，202 位真干员）
     * 打底，模拟器自己的满配表（aue-operators.json，259 位，含联动）覆盖同名项。
     * 只给一份的话，编辑器里 6 星只剩 7 位联动干员 —— 那正是用户说的「根本不全」。
     */
    private String operatorsJson() {
        JSONObject merged = mergedOperators();
        JSONObject overrides = readOverrides();
        JSONObject out = new JSONObject();
        put(out, "version", 1);
        put(out, "operators", merged);
        put(out, "edited", overrides != null ? overrides.optJSONObject("operators") : new JSONObject());
        put(out, "categories", CATEGORIES_JSON);
        return out.toString();
    }

    /**
     * 两份原表合并成一份，键统一成「编辑器/覆盖表用的 id」。
     *
     * 键的选择是有讲究的：
     *   - aue 表的键（aue_char_002_amiya）本来就是沙盒前端认的 id（chessId）；
     *   - 官方牌库的键是 si_char_003_kalts / chess_char_1_01_a 这种，前端通过
     *     aue-operators.json 与 operator-library.json 自己的合并逻辑认它，
     *     所以这里**保留牌库原键**，只补上 chessId 缺省等于键本身。
     * 同名键由 aue 表胜出（它带模拟器需要的满配/技能字段）。
     */
    private JSONObject mergedOperators() {
        JSONObject out = new JSONObject();

        // ① 先铺 chess.json（前端真正加载的那份，269 条，含塔露拉 / 自设干员这些
        //    aue 与牌库都没有的；键是 chess_char_5_99_talula_a 这类）。
        JSONObject chess = chessNative();
        if (chess != null) {
            java.util.Iterator<String> it = chess.keys();
            while (it.hasNext()) {
                String id = it.next();
                JSONObject rec = chess.optJSONObject(id);
                if (rec == null) continue;
                put(out, id, rec);
            }
        }

        // ② 再铺官方牌库（面大：202 位真干员），覆盖 chess 里的同名键。
        JSONObject lib = libraryNative();
        JSONObject libOps = lib != null ? lib.optJSONObject("operators") : null;
        if (libOps != null) {
            java.util.Iterator<String> it = libOps.keys();
            while (it.hasNext()) {
                String id = it.next();
                JSONObject rec = libOps.optJSONObject(id);
                if (rec == null) continue;
                put(out, id, rec);
            }
        }

        // ③ 最后盖 aue 表（259 条，含联动干员与模拟器侧字段），优先级最高。
        //    这个顺序与前端 operator-library.js 的
        //    `operators: {...native.operators, ...local.operators}` 完全一致，
        //    所以编辑器里看到的数值就是实际游玩用的数值。
        JSONObject aue = operatorsNative();
        JSONObject aueOps = aue != null ? aue.optJSONObject("operators") : null;
        if (aueOps != null) {
            java.util.Iterator<String> it = aueOps.keys();
            while (it.hasNext()) {
                String id = it.next();
                JSONObject rec = aueOps.optJSONObject(id);
                if (rec == null) continue;
                put(out, id, rec);
            }
        }
        return out;
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

    /**
     * chess.json + 玩家覆盖 -> 前端 data.loadAll('chess') 实际拿到的那份（/data/chess.json）。
     *
     * chess.json 顶层就是扁平表。这里对每个键查覆盖表（按 chessId 与 charId 两种键都试），
     * 命中就用 OperatorStore.patchRecord 叠上去，所以改了塔露拉的攻击力，进沙盒立刻生效。
     */
    /**
     * /data/operator-art.json → {"picks":{"<charId>":"e0|e2|<skinId>"},"skins":{"<charId>":[{id,name,art,artB}]}}
     *
     * 两件事一次给全：
     *   picks —— 玩家在详情页「立绘 / 皮肤」里选的那张，存在覆盖表的 loadout.art 上。
     *            覆盖表按 chessId 存，而前端画图是按 charId 取的，所以这里要顺着
     *            chess → 牌库 → aue 三张表把 chessId 翻成 charId 再吐出去。
     *   skins —— 本机 skinpack 解出来的皮肤索引（extract_skins.py 写的 local-skins.json）。
     *
     * 前端 asset-urls.js 的 useArtState() 一次吃下这份，手牌头像 / 详情立绘就都跟着变。
     */
    private String operatorArtJson() {
        JSONObject out = new JSONObject();
        JSONObject picks = new JSONObject();
        OperatorStore st = operatorStore();
        JSONObject edits = st.edits();
        java.util.Iterator<String> keys = edits.keys();
        while (keys.hasNext()) {
            String id = keys.next();
            JSONObject part = edits.optJSONObject(id);
            JSONObject loadout = part == null ? null : part.optJSONObject("loadout");
            if (loadout == null) continue;
            String art = loadout.optString("art", "");
            if (art.isEmpty()) continue;
            String charId = charIdOf(id);
            if (charId != null) put(picks, charId, art);
        }
        put(out, "picks", picks);

        JSONObject skins = new JSONObject();
        if (skinsFile.isFile()) {
            try {
                JSONObject idx = new JSONObject(readText(skinsFile));
                JSONObject chars = idx.optJSONObject("chars");
                if (chars != null) skins = chars;
            } catch (Exception ignored) {
            }
        }
        put(out, "skins", skins);
        return out.toString();
    }

    /** chessId / aueId → charId，三张表都查一遍；查不到返回 null。 */
    private String charIdOf(String id) {
        JSONObject chess = chessNative().optJSONObject(id);
        if (chess != null) {
            String c = chess.optString("charId", "");
            if (!c.isEmpty()) return c;
        }
        JSONObject lib = libraryNative().optJSONObject("operators");
        JSONObject lrec = lib == null ? null : lib.optJSONObject(id);
        if (lrec != null) {
            String c = lrec.optString("charId", "");
            if (!c.isEmpty()) return c;
        }
        JSONObject aue = operatorsNative().optJSONObject("operators");
        JSONObject arec = aue == null ? null : aue.optJSONObject(id);
        if (arec != null) {
            String c = arec.optString("charId", "");
            if (!c.isEmpty()) return c;
        }
        // 本身就是 charId 的情况（自定义干员可能这样存）
        if (id.startsWith("char_")) return id;
        return null;
    }

    private String effectiveChessJson() {
        JSONObject chess = chessNative();
        if (chess == null) return "{}";
        JSONObject overrides = readOverrides();
        JSONObject ovs = overrides != null ? overrides.optJSONObject("operators") : null;
        JSONObject out = new JSONObject();
        java.util.Iterator<String> it = chess.keys();
        while (it.hasNext()) {
            String id = it.next();
            JSONObject rec = chess.optJSONObject(id);
            if (rec == null) {
                put(out, id, chess.opt(id));
                continue;
            }
            JSONObject patch = null;
            if (ovs != null) {
                patch = ovs.optJSONObject(id);
                if (patch == null) {
                    String cid = rec.optString("charId", "");
                    if (!cid.isEmpty()) patch = ovs.optJSONObject(cid);
                }
            }
            put(out, id, patch == null ? rec : OperatorStore.patchRecord(rec, patch));
        }
        return out.toString();
    }

    /**
     * 官方牌库 + 玩家覆盖 → 沙盒实际使用的那份（/data/operator-library.json）。
     *
     * 只对牌库里存在的键叠覆盖，其余原样返回；覆盖表里 aue 侧的键不在这里出现，
     * 那些由 /data/aue-operators.json 那条路由负责。
     */
    private String effectiveLibraryJson() {
        JSONObject lib = libraryNative();
        if (lib == null) return "{\"version\":1,\"operators\":{}}";
        JSONObject out;
        try {
            out = new JSONObject(lib.toString());
        } catch (Exception e) {
            return "{\"version\":1,\"operators\":{}}";
        }
        JSONObject ops = out.optJSONObject("operators");
        if (ops == null) return out.toString();

        JSONObject overrides = readOverrides();
        JSONObject edited = overrides != null ? overrides.optJSONObject("operators") : null;
        if (edited == null) return out.toString();

        java.util.Iterator<String> it = edited.keys();
        while (it.hasNext()) {
            String id = it.next();
            JSONObject rec = ops.optJSONObject(id);
            if (rec == null) continue;                    // 不是牌库里的键，跳过
            JSONObject patch = edited.optJSONObject(id);
            if (patch == null) continue;
            JSONObject patched = OperatorStore.patchRecord(rec, patch);
            if (patched != null) put(ops, id, patched);
        }
        return out.toString();
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
        // 图片缺失时回一张灰底剪影，而不是 404。
        // data/assets.json 登记的是「官方客户端全量素材」的路径，本机能提取到的只有
        // chararts/ 里真实存在的 bundle；阿米娅的老 id（char_002_amiya）、自设干员
        // （char_1503_talula 等）根本没有对应 bundle，文件不存在是常态。
        // <img> 收到 404 会画「图片损坏」，所以这里回 200 的占位 SVG。
        if (isImagePath(pathname)) {
            writeResponse(out, 200, "image/svg+xml; charset=utf-8",
                    PLACEHOLDER_SVG.getBytes(StandardCharsets.UTF_8),
                    "HEAD".equals(method), "Cache-Control: no-store\r\n");
            return;
        }
        notFound(out);
    }

    /** 只对图片扩展名回占位图；脚本 / 样式 / JSON 仍然是 404。 */
    private static boolean isImagePath(String pathname) {
        String lower = pathname.toLowerCase(Locale.ROOT);
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                || lower.endsWith(".webp") || lower.endsWith(".gif") || lower.endsWith(".avif")
                || lower.endsWith(".svg") || lower.endsWith(".ico");
    }

    /** 灰色人形剪影（与前端 asset-urls.js 的 FD_AVATAR 同款）。 */
    private static final String PLACEHOLDER_SVG =
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='xMidYMid slice'>"
            + "<rect width='100' height='100' fill='#1c2024'/>"
            + "<circle cx='50' cy='37' r='15' fill='#3a4046'/>"
            + "<path d='M17 100c0-18 14-31 33-31s33 13 33 31z' fill='#3a4046'/></svg>";

    private void sendFile(String method, File file, Map<String, String> headers,
                          OutputStream out) throws IOException {
        long total = file.length();
        String mime = mimeOf(file.getName());
        // 本地提取出来的干员图为了不改 data/assets.json 的登记路径，文件名一律是 .png，
        // 但内容存的是 WebP（同样的画质体积只有一半）。这里按文件头校正 Content-Type，
        // 否则浏览器拿 image/png 去解 WebP 会直接显示裂图。
        if (mime.startsWith("image/")) mime = sniffImageMime(file, mime);
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

    /**
     * 按文件头认图片格式。本地提取的干员图沿用了 .png 的登记路径，内容却是 WebP。
     * 只读头 16 字节，代价可以忽略；认不出就沿用扩展名推出来的那个。
     */
    private static String sniffImageMime(File file, String fallback) {
        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] h = new byte[16];
            int n = fis.read(h);
            if (n >= 12) {
                // RIFF....WEBP
                if (h[0] == 'R' && h[1] == 'I' && h[2] == 'F' && h[3] == 'F'
                        && h[8] == 'W' && h[9] == 'E' && h[10] == 'B' && h[11] == 'P') return "image/webp";
                // AVIF / HEIF: ....ftyp
                if (h[4] == 'f' && h[5] == 't' && h[6] == 'y' && h[7] == 'p') return "image/avif";
            }
            if (n >= 3 && (h[0] & 0xFF) == 0xFF && (h[1] & 0xFF) == 0xD8 && (h[2] & 0xFF) == 0xFF) return "image/jpeg";
        } catch (IOException ignored) {
            // 读不到头就按扩展名走
        }
        return fallback;
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
