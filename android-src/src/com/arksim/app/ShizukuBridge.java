package com.arksim.app;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.IBinder;

import java.lang.reflect.Method;

import rikka.shizuku.Shizuku;

/**
 * Shizuku 通道：借 shell 身份（uid 2000）去读《明日方舟》自己的资源目录。
 *
 * /storage/emulated/0/Android/data/com.hypergryph.arknights/files/Bundles 是那个 App 的
 * 专属目录，普通应用连「所有文件访问权限」也读不到，只有 shell / root 身份能进。
 *
 * 这里用 Shizuku 起一个 shell 身份的进程（python）直接 open 那些 bundle ——
 * 全程直读，不先复制成别的压缩包或副本。
 */
public final class ShizukuBridge {

    /** 《明日方舟》的 AssetBundle 根目录。 */
    public static final String ARK_BUNDLES =
            "/storage/emulated/0/Android/data/com.hypergryph.arknights/files/Bundles";

    private static final int REQUEST_CODE = 4213;

    private ShizukuBridge() {
    }

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

    /** 弹系统的 Shizuku 授权框。 */
    public static void request(Activity act) {
        try {
            if (Shizuku.shouldShowRequestPermissionRationale()) {
                // 用户之前拒过，只能回 Shizuku App 里手动授权。
                return;
            }
            Shizuku.requestPermission(REQUEST_CODE);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 以 shell 身份起一个进程。
     *
     * Shizuku 公开 API 里没有起进程的入口（只有 bindUserService），
     * 唯一能用的是这个私有静态方法，所以反射调它。签名：
     * private static ShizukuRemoteProcess newProcess(String[] cmd, String[] env, String dir)
     *
     * @return 进程对象，调用方可直接拿 getInputStream()/getErrorStream()/waitFor()
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

    /** 方舟资源目录能不能读到（需要 Shizuku 已授权且服务在跑）。 */
    public static boolean arkDirReadable() {
        try {
            return new java.io.File(ARK_BUNDLES).canRead();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 给设置页的状态徽章用：一段 JSON，说明 Shizuku 装没装、服务跑没跑、本应用有没有被授权。
     * 页面据此显示「已就绪 / 需要授权 / 需要启动 Shizuku / 没装 Shizuku」。
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
        boolean installed;
        try {
            installed = installed_();
        } catch (Throwable t) {
            installed = false;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("{\"installed\":").append(installed)
          .append(",\"alive\":").append(alive)
          .append(",\"granted\":").append(granted)
          .append(",\"uid\":").append(uid)
          .append(",\"version\":").append(ver)
          .append(",\"arkReadable\":").append(arkDirReadable())
          .append('}');
        return sb.toString();
    }

    private static boolean installed_() {
        // Shizuku 的包名是 moe.shizuku.privileged.api；Sui 是 moe.shizuku.sui。
        // 用 PackageManager 查，不引入额外的 Context 参数。
        try {
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            Object app = atClass.getMethod("currentApplication").invoke(null);
            if (app == null) return false;
            android.content.Context ctx = (android.content.Context) app;
            android.content.pm.PackageManager pm = ctx.getPackageManager();
            pm.getPackageInfo("moe.shizuku.privileged.api", 0);
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
