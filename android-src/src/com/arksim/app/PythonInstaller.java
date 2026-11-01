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

/**
 * 首次启动把 APK 里的 Python 运行时（assets/py）和提取器脚本（assets/extract）
 * 释放到 App 专属外部目录。
 *
 * 为什么放外部目录而不是私有目录：提取要跑在 Shizuku 的 shell 身份下，
 * 而 shell 读不到 /data/user/0/<pkg>（父目录 0700）。App 专属外部目录
 * /storage/emulated/0/Android/data/<pkg>/files 是 shell 能读的。
 *
 * 那边是 FUSE、不可执行，所以真正跑之前还要由 shell 拷到 /data/local/tmp。
 */
public final class PythonInstaller {

    /** 改动 assets/py 的内容时递增，触发重新释放。 */
    private static final String VERSION = "py-1";
    private static final String PREFS = "arksim";
    private static final String KEY = "pyVersion";

    private PythonInstaller() {
    }

    /** 返回运行时根目录（内含 py/ 与 extract/）。 */
    public static File ensure(Context ctx, Progress step) throws IOException {
        File base = ctx.getExternalFilesDir(null);
        if (base == null) base = ctx.getFilesDir();
        File dir = new File(base, "rt");

        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (VERSION.equals(prefs.getString(KEY, null)) && new File(dir, "py/python3.14").isFile()) {
            return dir;
        }

        step.on("首次启动：正在释放 Python 运行时…");
        WebInstaller.deleteTree(dir);
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("无法创建目录 " + dir);

        int files = WebInstaller.copyAssetTree(ctx, "py", new File(dir, "py"));
        step.on("Python 运行时就绪（" + files + " 个文件）");
        int tools = WebInstaller.copyAssetTree(ctx, "extract", new File(dir, "extract"));
        step.on("提取器就绪（" + tools + " 个文件）");

        if (!new File(dir, "py/python3.14").isFile()) {
            throw new IOException("运行时释放失败（缺 python3.14）");
        }
        if (!new File(dir, "extract/extract.py").isFile()) {
            throw new IOException("提取器释放失败（缺 extract.py）");
        }

        prefs.edit().putString(KEY, VERSION).apply();
        return dir;
    }

    public interface Progress {
        void on(String message);
    }
}
