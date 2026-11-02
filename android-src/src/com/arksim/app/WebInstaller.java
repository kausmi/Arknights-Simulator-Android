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
 * 首次启动把 APK 里的 web.zip 解到私有目录，之后每次启动只校验一个版本戳。
 *
 * 放私有目录的原因：FUSE 共享存储（/sdcard）不可执行也不稳定，服务端要在这里跑。
 */
public final class WebInstaller {

    private static final String VERSION = "web-2";
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
