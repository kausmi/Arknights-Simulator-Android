package com.arksim.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.IBinder;

import java.io.File;
import java.lang.reflect.Method;

import rikka.shizuku.Shizuku;

/**
 * Shizuku 通道：借 shell 身份（uid 2000）去读《明日方舟》自己的资源目录。
 *
 * 方舟把资源放在 <包名>/files/Bundles 这一类专属目录里，别的应用（连拿到
 * 「所有文件访问权限」也不行）读不到，只有 shell / root 能进。这里用 Shizuku
 * 起一个 shell 身份的进程（python）直接 open 那些 bundle —— 全程直读，
 * 不先复制成别的压缩包或副本。
 *
 * 包体：不同服/渠道的方舟是不同的包名，资源目录也随之不同。这里列了一张
 * 包体表（{@link #FLAVORS}），设置里可以切换；当前实际能用的只有官服与 B 服，
 * 其它语言服的包名先登记好，但标记为「暂不可用」。
 *
 * <p><b>两条提权通道</b>：本机能拿到的最高身份其实有两种 ——
 * <ul>
 *   <li>{@link #CHANNEL_SHIZUKU}：借 Shizuku 的 shell 身份（uid 2000），不用 root；</li>
 *   <li>{@link #CHANNEL_ROOT}：走 {@code su}，直接拿 uid 0，权限更大（能读其它应用的
 *       私有目录、能看 /data 下的东西），代价是手机必须已经 root 且授权给本应用。</li>
 * </ul>
 * 两者对外暴露同一个 {@link #process(String[], String[], String)}，
 * 上层（Extractor / MainActivity）完全不用关心当前走的是哪条。
 * 通道选择存在 SharedPreferences 里，用户可以随时在设置里切。
 */
public final class ShizukuBridge {

    private static final int REQUEST_CODE = 4213;
    private static final String PREFS = "arksim";
    private static final String KEY_FLAVOR = "arkFlavor";
    private static final String KEY_CHANNEL = "extractChannel";

    /** 借 Shizuku 的 shell 身份（uid 2000）。 */
    public static final String CHANNEL_SHIZUKU = "shizuku";
    /** 走 su 直接拿 root（uid 0）。 */
    public static final String CHANNEL_ROOT = "root";

    /**
     * 一个包体（一个服的客户端）。
     *
     * @param id      内部 id，存进 SharedPreferences
     * @param label   设置里显示的名字
     * @param pkg     应用包名
     * @param usable  当前是否支持读取（其它语言服先登记，暂不可用）
     */
    public static final class Flavor {
        public final String id;
        public final String label;
        public final String pkg;
        public final boolean usable;

        Flavor(String id, String label, String pkg, boolean usable) {
            this.id = id;
            this.label = label;
            this.pkg = pkg;
            this.usable = usable;
        }

        /** 这个包体「若已安装」的资源根目录。 */
        public String bundlesPath() {
            return "/storage/emulated/0/Android/data/" + pkg + "/files/Bundles";
        }
    }

    /**
     * 包体表。
     *
     * 官服（简中）：com.hypergryph.arknights
     * B 服（简中）：com.hypergryph.arknights.bilibili
     * 其它语言服：先登记包名，读取逻辑暂未适配（目录结构与资源命名可能有差异），
     * 所以标成 usable=false，界面上会显示「暂不可用」而不是让人白试。
     */
    public static final Flavor[] FLAVORS = {
            new Flavor("cn", "简中 · 官服", "com.hypergryph.arknights", true),
            new Flavor("bilibili", "简中 · B 服", "com.hypergryph.arknights.bilibili", true),
            new Flavor("en", "国际服 · 英文", "com.YoStarEN.Arknights", false),
            new Flavor("jp", "日服", "com.YoStarJP.Arknights", false),
            new Flavor("kr", "韩服", "com.YoStarKR.Arknights", false),
            new Flavor("tw", "繁中服", "tw.com.hypergryph.arknights", false),
    };

    private ShizukuBridge() {
    }

    // ── 提权通道（Shizuku / root）────────────────────────────────────────

    /** 当前选中的提权通道 id。默认 Shizuku（不用 root，门槛最低）。 */
    public static String channelId() {
        try {
            Context ctx = appContext();
            if (ctx == null) return CHANNEL_SHIZUKU;
            String id = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_CHANNEL, CHANNEL_SHIZUKU);
            return CHANNEL_ROOT.equals(id) ? CHANNEL_ROOT : CHANNEL_SHIZUKU;
        } catch (Throwable t) {
            return CHANNEL_SHIZUKU;
        }
    }

    public static boolean isRootChannel() {
        return CHANNEL_ROOT.equals(channelId());
    }

    /**
     * 切换提权通道。
     *
     * <p>切完要把所有跟「能不能读」有关的缓存全清掉 —— 两条通道的可读性完全独立
     * （Shizuku 授权了不代表 su 能给 root，反过来也一样），留着旧缓存会让界面
     * 显示上一个通道的结论。
     */
    public static void setChannelId(String id) {
        try {
            Context ctx = appContext();
            if (ctx == null) return;
            String v = CHANNEL_ROOT.equals(id) ? CHANNEL_ROOT : CHANNEL_SHIZUKU;
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_CHANNEL, v).apply();
            dirCheckedAt = 0;
            dirCached = false;
            rootCheckedAt = 0;
            rootCached = false;
            rootProbeOut = "";
        } catch (Throwable ignored) {
        }
    }

    /** root 探测的缓存：起一次 su 要几百毫秒，设置页轮询不能每次都起。 */
    private static volatile long rootCheckedAt = 0;
    private static volatile boolean rootCached = false;
    private static volatile String rootProbeOut = "";
    private static final long ROOT_CACHE_MS = 5000;

    /**
     * root 到底能不能用 —— 真的起一次 {@code su -c id} 看回的是不是 uid=0。
     *
     * <p>为什么不查「有没有 su 文件」：Magisk / KernelSU / APatch 的 su 路径各不相同
     * （/system/bin/su、/system/xbin/su、/debug_ramdisk/su…），而且有 su 文件不代表
     * 我们能拿到 root（授权被拒、超时都会失败）。只有真跑一次 `id` 才算数。
     */
    public static boolean rootAvailable() {
        return rootAvailable(false);
    }

    public static boolean rootAvailable(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && (now - rootCheckedAt) < ROOT_CACHE_MS) return rootCached;
        boolean ok = false;
        String out = "";
        try {
            Process p = new ProcessBuilder("sh", "-c", "su -c id 2>&1").redirectErrorStream(true).start();
            java.io.InputStream in = p.getInputStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[256];
            int n;
            long deadline = System.currentTimeMillis() + 12000;
            while ((n = in.read(buf)) > 0) {
                bo.write(buf, 0, n);
                if (System.currentTimeMillis() > deadline) break;
            }
            p.waitFor();
            out = bo.toString("UTF-8").trim();
            ok = out.contains("uid=0");
        } catch (Throwable t) {
            out = t.toString();
        }
        rootCached = ok;
        rootProbeOut = out;
        rootCheckedAt = now;
        return ok;
    }

    /** 上一次 root 探测的原始输出（设置页显示「为什么拿不到 root」用）。 */
    public static String rootProbeOutput() {
        return rootProbeOut;
    }

    /**
     * 主动弹一次 root 授权框。
     *
     * <p>su 的授权框由 root 管理器（Magisk 等）自己弹，Java 这边只能通过「执行一条
     * 无害命令」把它引出来。执行成功说明已经授权；没弹或没点，就看 rootAvailable 的结果。
     */
    public static boolean requestRoot() {
        try {
            Process p = new ProcessBuilder("sh", "-c", "su -c true 2>&1").redirectErrorStream(true).start();
            p.waitFor();
        } catch (Throwable ignored) {
        }
        return rootAvailable(true);
    }

    /**
     * 当前通道能不能用（用于「开始提取」前的门禁）。
     *
     * <p>Shizuku 通道：服务在跑 + 已授权；
     * root 通道：su 能拿到 uid 0。
     */
    public static boolean channelReady() {
        if (isRootChannel()) return rootAvailable();
        return alive() && granted();
    }

    /**
     * 当前通道不可用时，给用户一句人话。
     */
    public static String channelBlockReason() {
        if (isRootChannel()) {
            if (rootAvailable()) return "";
            String out = rootProbeOut;
            if (out == null || out.isEmpty()) return "拿不到 root 权限：手机可能没有 root，或授权框超时";
            if (out.toLowerCase().contains("not found") || out.contains("inaccessible"))
                return "这台设备上没有 su，用不了 ROOT 提取，请切回 Shizuku 通道";
            if (out.toLowerCase().contains("denied")) return "root 授权被拒绝了，请在 root 管理器里允许本应用";
            return "拿不到 root 权限：" + out;
        }
        if (!alive()) return "Shizuku 没有在运行，请先启动 Shizuku";
        if (!granted()) return "还没有授权本应用使用 Shizuku";
        return "";
    }

    // ── 包体切换 ────────────────────────────────────────────────────────

    /** 当前选中的包体 id（默认简中官服）。 */
    public static String currentFlavorId() {
        try {
            Context ctx = appContext();
            if (ctx == null) return "cn";
            String id = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_FLAVOR, "cn");
            return findFlavor(id) != null ? id : "cn";
        } catch (Throwable t) {
            return "cn";
        }
    }

    public static void setFlavorId(String id) {
        try {
            Context ctx = appContext();
            if (ctx == null) return;
            if (findFlavor(id) == null) return;
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_FLAVOR, id).apply();
            dirCheckedAt = 0;      // 换包体了：路径变了，缓存作废
        } catch (Throwable ignored) {
        }
    }

    public static Flavor findFlavor(String id) {
        for (Flavor f : FLAVORS) if (f.id.equals(id)) return f;
        return null;
    }

    public static Flavor currentFlavor() {
        Flavor f = findFlavor(currentFlavorId());
        return f == null ? FLAVORS[0] : f;
    }

    /** 当前包体的资源根目录。所有读资源的地方都用它，而不是写死官服路径。 */
    public static String arkBundles() {
        return currentFlavor().bundlesPath();
    }

    /** 这个包体对应的 App 装没装。 */
    public static boolean flavorInstalled(Flavor f) {
        try {
            Context ctx = appContext();
            if (ctx == null) return false;
            ctx.getPackageManager().getPackageInfo(f.pkg, 0);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 各包体的完整状态（给设置页画那张切换列表）。 */
    public static String flavorsJson() {
        String current = currentFlavorId();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"current\":\"").append(current).append("\",\"flavors\":[");
        for (int i = 0; i < FLAVORS.length; i++) {
            Flavor f = FLAVORS[i];
            boolean installed = flavorInstalled(f);
            if (i > 0) sb.append(',');
            sb.append("{\"id\":\"").append(f.id).append('"')
              .append(",\"label\":\"").append(f.label).append('"')
              .append(",\"pkg\":\"").append(f.pkg).append('"')
              .append(",\"usable\":").append(f.usable)
              .append(",\"installed\":").append(installed)
              .append(",\"path\":\"").append(f.bundlesPath()).append('"')
              .append('}');
        }
        sb.append("]}");
        return sb.toString();
    }

    // ── Shizuku ─────────────────────────────────────────────────────────

    /** Shizuku 服务是否在跑（binder 已拿到）。 */
    public static boolean alive() {
        try {
            return Shizuku.pingBinder();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 是否已经授权本应用使用 Shizuku。 */
    public static boolean granted() {
        try {
            if (!alive()) return false;
            return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 授权结果回调，给 Activity 拿来做提示。 */
    public interface PermissionCallback {
        void onResult(boolean granted);
    }

    private static PermissionCallback pendingCallback;
    private static boolean listenerRegistered;

    /**
     * 弹 Shizuku 的应用内授权框。
     *
     * 要点：必须先用 addRequestPermissionResultListener 注册回调，系统弹窗答复后
     * 结果才会异步回到应用；不注册的话 requestPermission 发出去就没回音，
     * 界面上看着像「授权了没反应」。
     */
    public static void request(Activity act, PermissionCallback cb) {
        pendingCallback = cb;
        try {
            ensurePermissionListener();
            if (!alive()) {
                if (cb != null) cb.onResult(false);
                return;
            }
            if (granted()) {
                if (cb != null) cb.onResult(true);
                return;
            }
            if (Shizuku.shouldShowRequestPermissionRationale()) {
                // 之前被拒过：系统不会再弹窗，只能回 Shizuku App 里手动改授权
                if (cb != null) cb.onResult(false);
                return;
            }
            Shizuku.requestPermission(REQUEST_CODE);
        } catch (Throwable t) {
            if (cb != null) cb.onResult(false);
        }
    }

    /** 兼容旧签名（不需要结果回调的调用点）。 */
    public static void request(Activity act) {
        request(act, null);
    }

    private static void ensurePermissionListener() {
        if (listenerRegistered) return;
        listenerRegistered = true;
        try {
            Shizuku.addRequestPermissionResultListener((requestCode, grantResult) -> {
                if (requestCode != REQUEST_CODE) return;
                PermissionCallback cb = pendingCallback;
                pendingCallback = null;
                if (cb != null) cb.onResult(grantResult == PackageManager.PERMISSION_GRANTED);
            });
        } catch (Throwable ignored) {
        }
    }

    /**
     * 以 shell 身份起一个进程。
     *
     * Shizuku 公开 API 里没有起进程的入口（只有 bindUserService），唯一能用的是这个
     * 私有静态方法，所以反射调它。签名：
     * private static ShizukuRemoteProcess newProcess(String[] cmd, String[] env, String dir)
     */
    public static Process process(String[] cmd, String[] env, String dir) throws Exception {
        if (isRootChannel()) return rootProcess(cmd, env, dir);
        if (!alive()) throw new IllegalStateException("Shizuku 服务没有在运行");
        if (!granted()) throw new IllegalStateException("还没有授予 Shizuku 权限");
        Method m = Shizuku.class.getDeclaredMethod(
                "newProcess", String[].class, String[].class, String.class);
        m.setAccessible(true);
        Object out = m.invoke(null, cmd, env, dir);
        if (!(out instanceof Process)) throw new IllegalStateException("Shizuku 返回了非进程对象");
        return (Process) out;
    }

    /**
     * ROOT 通道起进程：{@code sh -c "su -c '<拼好的命令>'" }。
     *
     * <p>为什么要把 argv 拼成一条字符串：{@code su -c} 只接受一条命令串
     * （su -c "cmd arg1 arg2"），没有 argv 版。所以这里必须自己做 shell 转义 ——
     * 每个参数用单引号包起来，参数里的单引号换成 {@code '\''}。
     * 路径里带空格、括号、中文（方舟的资源目录就有）都能安全通过。
     *
     * <p>env 同理：{@code su -c} 不会继承我们的环境变量，得自己在命令前面 export。
     * python 运行时强依赖 PYTHONHOME / LD_LIBRARY_PATH，漏了就直接跑不起来。
     */
    private static Process rootProcess(String[] cmd, String[] env, String dir) throws Exception {
        if (!rootAvailable()) {
            String why = channelBlockReason();
            throw new IllegalStateException(why.isEmpty() ? "拿不到 root 权限" : why);
        }
        if (cmd == null || cmd.length == 0) throw new IllegalArgumentException("空命令");
        StringBuilder sc = new StringBuilder();
        if (dir != null && !dir.isEmpty()) {
            sc.append("cd ").append(shQuote(dir)).append(" && ");
        }
        if (env != null) {
            boolean first = true;
            for (String kv : env) {
                if (kv == null || kv.isEmpty()) continue;
                int eq = kv.indexOf('=');
                if (eq <= 0) continue;
                if (first) { sc.append("export "); first = false; } else sc.append(' ');
                sc.append(shQuote(kv.substring(0, eq)))
                  .append('=')
                  .append(shQuote(kv.substring(eq + 1)));
            }
            if (!first) sc.append(" && ");
        }
        sc.append("exec");
        for (String a : cmd) sc.append(' ').append(shQuote(a));

        // 外层走 su -c "<整条命令>"：把整条命令再转义一次交给 su 的 sh。
        String suCmd = "su -c " + shQuote(sc.toString());
        return new ProcessBuilder("sh", "-c", suCmd).redirectErrorStream(false).start();
    }

    /**
     * 提权后进程用的暂存目录。
     *
     * <p>两条通道各用一个，不能共用：目录所有者不同（shell 的 0700 目录 root 能进，
     * 但反过来 root 建的目录属主是 root、shell 未必有写权限），混用会出现
     * 「换通道后 rm -rf 删不掉」这种莫名其妙的问题。
     */
    public static String stagingRoot() {
        return isRootChannel() ? "/data/local/tmp/arksim-rt-su" : "/data/local/tmp/arksim-rt";
    }

    /** 提取结果的中转目录（同样按通道分开）。 */
    public static String outputRoot() {
        return isRootChannel() ? "/data/local/tmp/arksim-out-su" : "/data/local/tmp/arksim-out";
    }

    /** POSIX 单引号转义：a'b → 'a'\''b'。 */
    private static String shQuote(String s) {
        if (s == null) return "''";
        return "'" + s.replace("'", "'\\''") + "'";
    }

    /** 把任意字符串塞进 JSON 字符串字面量（引号、反斜杠、换行都要转义）。 */
    static String jsonEsc(String s) {
        if (s == null || s.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * 当前包体的资源目录能不能读到。
     *
     * 注意：这里**不能**用 File.canRead()。那个方法按「本应用自己的 uid」判断权限，
     * 而应用身份读不到方舟的专属目录（那是设计如此），所以即使 Shizuku 已授权、
     * shell 明明能读，canRead() 也永远返回 false —— 之前「授权了还是进不去」
     * 就是这个假阴性造成的。
     *
     * 正确做法：让 shell 身份（uid 2000）自己去试一次。真能读到才算数。
     */
    /** 目录可读性的缓存：起一次 shell 进程不便宜，设置页每秒轮询不能每次都起。 */
    private static volatile long dirCheckedAt = 0;
    private static volatile boolean dirCached = false;
    private static volatile String dirCachePath = "";
    private static final long DIR_CACHE_MS = 8000;   // 8 秒内复用同一次探测结果

    public static boolean arkDirReadable() {
        return arkDirReadable(false);
    }

    /**
     * @param force true = 忽略缓存重新探测（用户点「开始提取」时才需要）
     */
    public static boolean arkDirReadable(boolean force) {
        if (!channelReady()) return false;
        String path = arkBundles();
        long now = System.currentTimeMillis();
        if (!force && dirCachePath.equals(path) && (now - dirCheckedAt) < DIR_CACHE_MS) return dirCached;
        boolean ok = probeDir(path);
        dirCached = ok;
        dirCachePath = path;
        dirCheckedAt = now;
        return ok;
    }

    /** 真正起一个 shell 去试读（结果由 arkDirReadable 缓存）。 */
    private static boolean probeDir(String path) {
        try {
            // test -r 只检查可读，不列目录、不读内容，开销可以忽略
            Process p = process(
                    new String[]{"sh", "-c", "test -r '" + path + "' && echo OK"},
                    new String[]{"PATH=/system/bin:/system/xbin"},
                    "/data/local/tmp");
            java.io.InputStream in = p.getInputStream();
            byte[] buf = new byte[64];
            int n = in.read(buf);
            p.waitFor();
            return n > 0 && new String(buf, 0, n, "UTF-8").contains("OK");
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 用 shell 身份把资源目录的状态读成一句话，给设置页显示「为什么读不到」。
     * 返回形如 {"ok":true,"entries":12} 或 {"ok":false,"reason":"..."} 的 JSON。
     */
    public static String arkDirProbe() {
        String path = arkBundles();
        if (!channelReady()) {
            String why = channelBlockReason();
            if (why.isEmpty()) why = "提权通道不可用";
            return "{\"ok\":false,\"reason\":\"" + why.replace("\"", "'") + "\"}";
        }
        try {
            // 同时给出「能不能进、里面有没有东西」，这样设置页能说清楚是哪一步卡住
            String script = "if [ -r '" + path + "' ]; then "
                    + "  n=$(ls '" + path + "' 2>/dev/null | wc -l); echo \"OK $n\"; "
                    + "else echo \"NOREAD\"; fi";
            Process p = process(new String[]{"sh", "-c", script},
                    new String[]{"PATH=/system/bin:/system/xbin"}, "/data/local/tmp");
            java.io.InputStream in = p.getInputStream();
            byte[] buf = new byte[128];
            int n = in.read(buf);
            p.waitFor();
            String out = n > 0 ? new String(buf, 0, n, "UTF-8").trim() : "";
            if (out.startsWith("OK")) {
                String cnt = out.substring(2).trim();
                return "{\"ok\":true,\"entries\":\"" + cnt + "\",\"path\":\"" + path + "\"}";
            }
            return "{\"ok\":false,\"reason\":\"shell 身份也读不到这个目录：目录不存在，或游戏资源没下载完\",\"path\":\"" + path + "\"}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"reason\":\"" + t.toString().replace("\"", "'") + "\"}";
        }
    }

    /**
     * 给设置页的状态徽章用：一段 JSON，说明 Shizuku 装没装、服务跑没跑、本应用有没有被授权。
     */
    public static String statusJson() {
        boolean alive = alive();
        boolean granted = granted();
        int uid = -1, ver = -1;
        try {
            if (alive) {
                uid = Shizuku.getUid();
                ver = Shizuku.getVersion();
            }
        } catch (Throwable ignored) {
        }
        Flavor f = currentFlavor();
        String channel = channelId();
        boolean chReady = channelReady();
        String chReason = channelBlockReason();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"installed\":").append(installed_())
          .append(",\"alive\":").append(alive)
          .append(",\"granted\":").append(granted)
          .append(",\"uid\":").append(uid)
          .append(",\"version\":").append(ver)
          .append(",\"channel\":\"").append(channel).append('"')
          .append(",\"channelReady\":").append(chReady)
          .append(",\"channelReason\":\"").append(jsonEsc(chReason)).append('"')
          .append(",\"rootAvailable\":").append(rootAvailable(false))
          .append(",\"rootProbe\":\"").append(jsonEsc(rootProbeOut)).append('"')
          .append(",\"arkReadable\":").append(arkDirReadable(false))
          .append(",\"flavor\":\"").append(f.id).append('"')
          .append(",\"flavorLabel\":\"").append(f.label).append('"')
          .append(",\"flavorInstalled\":").append(flavorInstalled(f))
          .append(",\"flavorUsable\":").append(f.usable)
          .append(",\"bundles\":\"").append(arkBundles()).append('"')
          .append('}');
        return sb.toString();
    }

    private static volatile Context appCtx;

    /** Activity 起来时把 Application 存进来，别每次都靠反射去捞。 */
    public static void setAppContext(Context ctx) {
        if (ctx != null) appCtx = ctx.getApplicationContext();
    }

    private static Context appContext() {
        Context cached = appCtx;
        if (cached != null) return cached;
        try {
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            Object app = atClass.getMethod("currentApplication").invoke(null);
            if (app instanceof Context) {
                appCtx = (Context) app;
                return appCtx;
            }
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    private static boolean installed_() {
        // Shizuku 的包名是 moe.shizuku.privileged.api；Sui 是 moe.shizuku.sui。
        try {
            Context ctx = appContext();
            if (ctx == null) return false;
            ctx.getPackageManager().getPackageInfo("moe.shizuku.privileged.api", 0);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 方舟资源包（chararts / skinpack 这些目录）的版本指纹。
     *
     * 用来判断「游戏更新了，本地提取的美术是不是过期了」。做法只看目录的 mtime 与文件数：
     * `find <dir> -newer <marker>` 那种精确比对要走 shell 遍历 17G，慢到不可接受；
     * 而方舟每次热更都会重写这些目录里的文件，目录 mtime 一定会变，够用了。
     *
     * 返回形如 "chararts:467:1730000000|skinpack:434:1729999999"；读不到返回 ""。
     */
    public static String arkAssetFingerprint() {
        if (!channelReady()) return "";
        String root = arkBundles();
        try {
            String script = "cd '" + root + "' 2>/dev/null || exit 0; "
                    + "for d in chararts skinpack skinpack_dyn; do "
                    + "  if [ -d \"$d\" ]; then "
                    + "    n=$(ls \"$d\" 2>/dev/null | wc -l); "
                    + "    t=$(stat -c %Y \"$d\" 2>/dev/null || echo 0); "
                    + "    echo -n \"$d:$n:$t|\"; "
                    + "  fi; "
                    + "done";
            Process p = process(new String[]{"sh", "-c", script},
                    new String[]{"PATH=/system/bin:/system/xbin"}, "/data/local/tmp");
            java.io.InputStream in = p.getInputStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[512];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            p.waitFor();
            return bo.toString("UTF-8").trim();
        } catch (Throwable t) {
            return "";
        }
    }

    /** 供调试：拿 binder 看看到底连上没有。 */
    public static String describe() {
        try {
            IBinder b = Shizuku.getBinder();
            return "binder=" + (b != null) + " uid=" + Shizuku.getUid()
                    + " ver=" + Shizuku.getVersion();
        } catch (Throwable t) {
            return "unavailable: " + t;
        }
    }
}
