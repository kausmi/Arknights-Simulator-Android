package com.arksim.app;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 把「用 Shizuku 身份拉起 python，直读手机本地方舟 bundle，解包到本 App 的 public/assets/local」
 * 这套流程包起来。
 *
 * 关键点：python 进程是 shell 身份起的，所以它 open /storage/emulated/0/Android/data/
 * com.hypergryph.arknights/files/Bundles/... 是**直接读**，中间不写任何压缩包或副本；
 * 产出直接写进 com.arksim.app 自己的外部专属目录（shell 身份对该目录有 ext_data_rw）。
 */
public final class Extractor {

    /** 提取进度回调。 */
    public interface Progress {
        void onLine(String line);
    }

    private final File runtime;   // <externalFiles>/rt  （含 py/ 与 extract/）
    private final File outDir;    // web/public/assets/local
    private final File manifest;  // web/data/local-assets.json

    /** shell 身份可执行的位置：/sdcard 是 FUSE noexec，只有这里能跑 ELF。 */
    private static final File STAGE = new File("/data/local/tmp/arksim-rt");
    private static final File STAMP = new File(STAGE, ".stamp");

    public Extractor(File runtime, File webDir) {
        this.runtime = runtime;
        this.outDir = new File(webDir, "public/assets/local");
        this.manifest = new File(webDir, "data/local-assets.json");
    }

    /**
     * 把释放到外部专属目录的运行时（shell 可读但不可执行）搬进 /data/local/tmp，
     * 让 shell 身份能真正跑起来。只有版本戳变了才重搬。
     */
    public File prepare(Progress cb) throws Exception {
        File src = runtime;
        String stamp = Long.toString(src.lastModified()) + ":" + new File(src, "py/python3.14").length();
        if (STAMP.isFile() && stamp.equals(readText(STAMP).trim())) return STAGE;
        cb.onLine("正在准备可执行的 python 环境（首次较慢）…");
        // 先删干净再拷，避免新旧混在一起。
        runShell(new String[]{"sh", "-c", "rm -rf '" + STAGE.getAbsolutePath() + "'"}, cb);
        runShell(new String[]{"sh", "-c",
                "mkdir -p '" + STAGE.getAbsolutePath() + "' && "
                        + "cp -r '" + src.getAbsolutePath() + "/.' '" + STAGE.getAbsolutePath() + "/' && "
                        + "chmod -R 755 '" + STAGE.getAbsolutePath() + "'"}, cb);
        writeText(STAMP, stamp);
        return STAGE;
    }

    private static String readText(File f) {
        try (java.io.InputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[256];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File f, String text) throws IOException {
        try (java.io.OutputStream out = new java.io.FileOutputStream(f)) {
            out.write(text.getBytes("UTF-8"));
        }
    }

    /** 用 shell 身份执行一条命令，把输出打到回调里。 */
    private static int runShell(String[] cmd, Progress cb) throws Exception {
        Process p = ShizukuBridge.process(cmd, new String[]{"PATH=/system/bin:/system/xbin"}, "/data/local/tmp");
        pump(p.getInputStream(), cb);
        pump(p.getErrorStream(), cb);
        int code = p.waitFor();
        if (code != 0) throw new IOException("shell 命令失败（退出码 " + code + "）：" + String.join(" ", cmd));
        return code;
    }

    /**
     * 跑一次完整提取（默认那套 --only 组合，覆盖沙盒用到的全部美术）。
     *
     * @param only 附加的 --only 组；传空则用默认组合
     * @return 进程退出码（0 表示成功）
     */
    public int run(List<String> only, Progress cb) throws Exception {
        File stage = prepare(cb);
        File py = new File(stage, "py");
        File ex = new File(stage, "extract");
        File pyBin = new File(py, "python3.14");
        if (!pyBin.isFile()) throw new IOException("python 运行时不完整：" + pyBin);
        if (!new File(ex, "extract.py").isFile()) throw new IOException("提取脚本缺失：" + ex);

        List<String> groups = new ArrayList<>();
        if (only == null || only.isEmpty()) {
            groups.add("map/autochess");
            groups.add("map/autochesssand");
            groups.add("ui");
            groups.add("projectiles");
            groups.add("module");
        } else {
            groups.addAll(only);
        }

        List<String> cmd = new ArrayList<>();
        cmd.add(pyBin.getAbsolutePath());
        cmd.add(new File(ex, "extract.py").getAbsolutePath());
        cmd.add("--game");
        cmd.add(ShizukuBridge.arkBundles());
        cmd.add("--out");
        cmd.add(outDir.getAbsolutePath());
        cmd.add("--manifest");
        cmd.add(manifest.getAbsolutePath());
        for (String g : groups) {
            cmd.add("--only");
            cmd.add(g);
        }

        String libPath = py.getAbsolutePath() + ":" + new File(py, "lib").getAbsolutePath();
        String[] env = {
                "PYTHONHOME=" + py.getAbsolutePath(),
                "LD_LIBRARY_PATH=" + libPath,
                "PYTHONPATH=" + ex.getAbsolutePath(),
                "HOME=" + py.getAbsolutePath(),
                "PATH=/system/bin:/system/xbin",
                "PYTHONDONTWRITEBYTECODE=1",
        };

        if (!outDir.isDirectory() && !outDir.mkdirs()) {
            throw new IOException("建不出输出目录：" + outDir);
        }
        File parent = manifest.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();

        Process p = ShizukuBridge.process(cmd.toArray(new String[0]), env, py.getAbsolutePath());
        pump(p.getInputStream(), cb);
        pump(p.getErrorStream(), cb);
        int code = p.waitFor();
        if (code != 0) return code;

        // 第二步：读「本机当前版本有哪些干员」，并把 2D 小人索引出来。
        // 这一步让干员列表跟着游戏更新走 —— 源是 skinpack/（文件名就是 charId），
        // 不依赖解析数据表，游戏一出新干员就自动出现在列表里。
        return readRoster(py, ex, env, cb);
    }

    /** 调 read_roster.py：扫 skinpack 得到干员列表 + 小人索引。 */
    private int readRoster(File py, File ex, String[] env, Progress cb) throws Exception {
        File script = new File(ex, "read_roster.py");
        if (!script.isFile()) {
            cb.onLine("skip: read_roster.py 不在提取器目录里");
            return 0;
        }
        File rosterDir = new File(outDir, "operators");
        File indexFile = new File(dataDir(), "operators-index.json");
        File parent = indexFile.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();

        String[] cmd = {
                new File(py, "python3.14").getAbsolutePath(),
                script.getAbsolutePath(),
                "--game", ShizukuBridge.arkBundles(),
                "--out", indexFile.getAbsolutePath(),
                "--skins", rosterDir.getAbsolutePath(),
        };
        Process p = ShizukuBridge.process(cmd, env, py.getAbsolutePath());
        pump(p.getInputStream(), cb);
        pump(p.getErrorStream(), cb);
        return p.waitFor();
    }

    /** 索引文件要写进 web 的 data 目录（服务端挂载点），不是提取产物目录。 */
    private File dataDir() {
        // manifest 在 <web>/data/local-assets.json，它的父目录就是 <web>/data
        File parent = manifest.getParentFile();
        return parent == null ? manifest : parent;
    }

    /** 提取是否已经有产出（manifest 存在即视为跑过）。 */
    public boolean hasOutput() {
        return manifest.isFile() && manifest.length() > 0;
    }

    public File manifestFile() {
        return manifest;
    }

    private static void pump(final InputStream in, final Progress cb) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[4096];
            StringBuilder line = new StringBuilder();
            try {
                int n;
                while ((n = in.read(buf)) > 0) {
                    for (int i = 0; i < n; i++) {
                        char c = (char) (buf[i] & 0xFF);
                        if (c == '\n') {
                            if (cb != null) cb.onLine(line.toString());
                            line.setLength(0);
                        } else if (line.length() < 4096) {
                            line.append(c);
                        }
                    }
                }
                if (line.length() > 0 && cb != null) cb.onLine(line.toString());
            } catch (IOException ignored) {
            } finally {
                try {
                    in.close();
                } catch (IOException ignored) {
                }
            }
        }, "arksim-extract-log");
        t.setDaemon(true);
        t.start();
    }
}
