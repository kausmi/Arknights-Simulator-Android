package com.arksim.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 首次启动把 APK 里的 web.zip 解到 App 私有内部目录，之后每次启动只校验一个版本戳。
 *
 * 为什么是私有内部目录（/data/user/0/<pkg>/files），而不是外部专属目录
 * （/storage/emulated/0/Android/data/<pkg>/files）：后者虽然也是"应用专属"，但
 * 媒体扫描器、文件管理器、系统相册的「其他文件」分类都能看到里面，
 * 提取出来的上千张干员立绘会以照片的形式出现在用户手机里。私有目录则只有
 * 本 App 自己与 root 能读，卸载即清除。
 */
public final class WebInstaller {

    /**
     * 网页资源版本戳。改动 public/ 下的东西就要 +1，否则老用户不会重新解包。
     *
     * web-3：网页资源与提取产物从「应用专属外部目录」搬到「App 私有内部目录」，
     * 因为放在外部目录时解出来的干员立绘会被相册 / 媒体选择器扫成照片。
     */
    private static final String VERSION = "web-3";
    private static final String PREFS = "arksim";
    private static final String KEY = "webVersion";

    private WebInstaller() {
    }

    /**
     * 返回 web 根目录（内含 public / data / server / shared / content）。
     *
     * @param step 进度回调，可能来自后台线程
     */
    public static File ensure(Context ctx, File base, Progress step) throws IOException {
        File dir = new File(base, "web");
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (VERSION.equals(prefs.getString(KEY, null)) && new File(dir, "public/studio/home.html").isFile()) {
            return dir;
        }

        step.on("首次启动：正在解开网页资源…");
        deleteTree(dir);
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("无法创建目录 " + dir);

        int count = 0;
        try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(ctx.getAssets().open("web.zip"), 64 * 1024))) {
            ZipEntry entry;
            byte[] buf = new byte[64 * 1024];
            while ((entry = zin.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName();
                if (name.startsWith("/") || name.contains("..") || name.contains("\\")) continue;
                File out = new File(dir, name);
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new IOException("无法创建目录 " + parent);
                }
                try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out), 64 * 1024)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
                count++;
            }
        }

        File home = new File(dir, "public/studio/home.html");
        if (!home.isFile()) throw new IOException("网页资源不完整（解出 " + count + " 个文件，缺 home.html）");
        prefs.edit().putString(KEY, VERSION).apply();
        step.on("网页资源就绪（" + count + " 个文件）");
        return dir;
    }

    /**
     * 清掉历史版本留在「应用专属外部目录」里的网页资源与提取产物。
     *
     * 0.1.x 曾经把 web 根放在 getExternalFilesDir(null)，于是
     * /storage/emulated/0/Android/data/com.arksim.app/files/web/public/assets/char/
     * 下堆了上千张干员立绘 —— 相册、文件管理器、媒体选择器都能看到。
     * 升级到私有目录版本后必须主动删掉，否则用户手机里那些图会一直留着。
     *
     * 只删我们自己建的 web/ 与 rt/ 两个子目录（rt 里是 python 运行时，也要重建到新位置），
     * 不碰别的任何东西。
     */
    static void purgeLegacyExternal(Context ctx, Progress step) {
        File ext = ctx.getExternalFilesDir(null);
        if (ext == null) return;
        File legacyWeb = new File(ext, "web");
        if (!legacyWeb.isDirectory()) return;

        step.on("正在清理旧版本留在外部存储里的图片…");

        // 先把路径收集起来：删完之后 MediaStore 里那些行还在，
        // 相册仍会显示成"空白/裂图"的占位。删完补一次扫描，让媒体库把这些条目丢掉。
        java.util.List<String> paths = new java.util.ArrayList<>();
        collectFiles(legacyWeb, paths);

        deleteTree(legacyWeb);

        if (!paths.isEmpty()) {
            try {
                android.media.MediaScannerConnection.scanFile(
                        ctx, paths.toArray(new String[0]), null, null);
            } catch (Throwable ignored) {
                // 尽力而为：扫描失败也不影响文件已被删除这件事。
            }
        }
        step.on("已清理 " + paths.size() + " 个旧文件");
    }

    /** 递归收集目录下的文件绝对路径（只用来通知媒体库刷新）。 */
    private static void collectFiles(File f, java.util.List<String> out) {
        File[] kids = f.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (k.isDirectory()) collectFiles(k, out);
            else out.add(k.getAbsolutePath());
        }
    }

    /** 只在版本变化时用得到：清掉旧的一份，避免残留文件混进去。 */
    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    /** 从 assets 下的某个目录整体复制出来（保留目录结构）。 */
    static int copyAssetTree(Context ctx, String assetDir, File dest) throws IOException {
        String[] list = ctx.getAssets().list(assetDir);
        if (list == null || list.length == 0) {
            copyAssetFile(ctx, assetDir, dest);
            return 1;
        }
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("无法创建 " + dest);
        int total = 0;
        for (String name : list) {
            total += copyAssetTree(ctx, assetDir + "/" + name, new File(dest, name));
        }
        return total;
    }

    private static void copyAssetFile(Context ctx, String assetPath, File dest) throws IOException {
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建 " + parent);
        try (InputStream in = new BufferedInputStream(ctx.getAssets().open(assetPath), 64 * 1024);
             OutputStream out = new BufferedOutputStream(new FileOutputStream(dest), 64 * 1024)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    public interface Progress {
        void on(String message);
    }
}
