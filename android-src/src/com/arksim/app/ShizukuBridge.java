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
 */
public final class ShizukuBridge {

    private static final int REQUEST_CODE = 4213;
    private static final String PREFS = "arksim";
    private static final String KEY_FLAVOR = "arkFlavor";

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
     * 当前包体的资源目录能不能读到。
     *
     * 注意：这里**不能**用 File.canRead()。那个方法按「本应用自己的 uid」判断权限，
     * 而应用身份读不到方舟的专属目录（那是设计如此），所以即使 Shizuku 已授权、
     * shell 明明能读，canRead() 也永远返回 false —— 之前「授权了还是进不去」
     * 就是这个假阴性造成的。
     *
     * 正确做法：让 shell 身份（uid 2000）自己去试一次。真能读到才算数。
     */
    public static boolean arkDirReadable() {
        if (!alive() || !granted()) return false;
        try {
            // test -r 只检查可读，不列目录、不读内容，开销可以忽略
            Process p = process(
                    new String[]{"sh", "-c", "test -r '" + arkBundles() + "' && echo OK"},
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
        if (!alive()) return "{\"ok\":false,\"reason\":\"Shizuku 服务没有在运行\"}";
        if (!granted()) return "{\"ok\":false,\"reason\":\"还没有授权本应用使用 Shizuku\"}";
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
        StringBuilder sb = new StringBuilder();
        sb.append("{\"installed\":").append(installed_())
          .append(",\"alive\":").append(alive)
          .append(",\"granted\":").append(granted)
          .append(",\"uid\":").append(uid)
          .append(",\"version\":").append(ver)
          .append(",\"arkReadable\":").append(arkDirReadable())
          .append(",\"flavor\":\"").append(f.id).append('"')
          .append(",\"flavorLabel\":\"").append(f.label).append('"')
          .append(",\"flavorInstalled\":").append(flavorInstalled(f))
          .append(",\"flavorUsable\":").append(f.usable)
          .append(",\"bundles\":\"").append(arkBundles()).append('"')
          .append('}');
        return sb.toString();
    }

    private static Context appContext() {
        try {
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            Object app = atClass.getMethod("currentApplication").invoke(null);
            return app instanceof Context ? (Context) app : null;
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
