package com.arksim.app;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 把「用 Shizuku 身份拉起 python，直读手机本地方舟 bundle，解包进本 App」这套流程包起来。
 *
 * ── 为什么分两步走 ───────────────────────────────────────────────
 * 用户的要求是「直接读取，不要提取到手机任何可读目录，不然手机里全是照片」。
 * 也就是说解出来的干员头像立绘**绝不能**落在
 *   /storage/emulated/0/Android/data/com.arksim.app/files/...
 * 这种相册 / 文件管理器 / 媒体选择器能扫到的地方，而必须进
 *   /data/user/0/com.arksim.app/files/...      （App 私有内部目录，卸载才消失）
 *
 * 可是 python 是 shell 身份（uid 2000）起的，它写不进私有目录（父目录 0700 +
 * SELinux untrusted_app_data_file）。两头卡住，所以走中转：
 *
 *   1) python **直接 open 方舟的 .ab**（不复制、不打包），把解出的图写进
 *      /data/local/tmp/arksim-out（shell 自己的暂存区，不受媒体扫描，也不是
 *      相册 / 媒体选择器能读到的位置）；
 *   2) 解完立刻 `tar cf - -C <暂存> .`，本类从 stdout 流式解进私有目录；
 *   3) 删掉暂存。
 *
 * 中间产物只在一台设备的 shell 临时目录里存在几秒，媒体库里什么都不会出现；
 * 最终产物在 App 私有沙盒内，只有本 App 自己（和 HTTP 服务的 127.0.0.1 端口）能读到。
 */
public final class Extractor {

    /** 提取进度回调。 */
    public interface Progress {
        void onLine(String line);
    }

    private final File runtime;   // <externalFiles>/rt  （含 py/ 与 extract/，shell 可读）
    private final File webDir;    // web 根（私有目录），最终产物与网页资源都在这里

    /** shell 身份可执行的位置：/sdcard 是 FUSE noexec，只有这里能跑 ELF。 */
    private static final File STAGE = new File("/data/local/tmp/arksim-rt");

    /** python 的写盘暂存（shell 暂存区，没有媒体扫描器会看这里）。 */
    private static final File TMP_OUT = new File("/data/local/tmp/arksim-out");

    /**
     * 整条提取链路上是否顺带解全量皮肤。
     *
     * 默认 false：全量 434 个 skinpack 约 11 分钟、多占约 160MB，而绝大多数人一辈子
     * 只看精一精二两张立绘。皮肤的入口是详情页的下拉，点了才解（extractSkins(id)）。
     */
    private static final boolean WANT_SKINS = false;

    /**
     * 版本戳文件名。
     *
     * ⚠️ 戳**不能**放在 STAGE 里面。STAGE 是 shell 身份建的（shell:shell 0755），
     * 应用身份连写一个字节都不行 —— 之前把戳写成 /data/local/tmp/arksim-rt/.stamp，
     * 结果 prepare() 拷完运行时就抛 EACCES，整个流程停在这一步，
     * 界面上看着就是「点了重新提取，转两下没动静」。放到我们自己的 runtime 目录
     * （应用身份可写、shell 也能读）就没这个问题。
     */
    private static final String STAMP_NAME = ".stamp";

    /**
     * @param runtime <externalFiles>/rt
     * @param webDir  web 根（在 App 私有目录里），提取产物最终落它下面的 public/assets
     */
    public Extractor(File runtime, File webDir) {
        this.runtime = runtime;
        this.webDir = webDir;
    }

    public File assetsRoot() {
        return new File(webDir, "public/assets");
    }

    /**
     * 把释放到外部专属目录的运行时（shell 可读但不可执行）搬进 /data/local/tmp，
     * 让 shell 身份能真正跑起来。只有版本戳变了才重搬。
     */
    public File prepare(Progress cb) throws Exception {
        File src = runtime;
        File stampFile = new File(src, STAMP_NAME);
        String stamp = Long.toString(src.lastModified()) + ":" + new File(src, "py/python3.14").length();
        if (stampFile.isFile() && stamp.equals(readText(stampFile).trim())
                && new File(STAGE, "py/python3.14").isFile()) {
            return STAGE;
        }
        cb.onLine("正在准备可执行的 python 环境（首次较慢）…");
        // 先删干净再拷，避免新旧混在一起。
        runShell(new String[]{"sh", "-c", "rm -rf '" + STAGE.getAbsolutePath() + "'"}, cb);
        runShell(new String[]{"sh", "-c",
                "mkdir -p '" + STAGE.getAbsolutePath() + "' && "
                        + "cp -r '" + src.getAbsolutePath() + "/.' '" + STAGE.getAbsolutePath() + "/' && "
                        + "chmod -R 755 '" + STAGE.getAbsolutePath() + "'"}, cb);
        writeText(stampFile, stamp);
        return STAGE;
    }

    private static String readText(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
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
        return p.waitFor();
    }

    /**
     * 跑一次完整提取：方舟 bundle → 暂存 → tar 流 → App 私有目录。
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

        String libPath = py.getAbsolutePath() + ":" + new File(py, "lib").getAbsolutePath();
        String[] env = {
                "PYTHONHOME=" + py.getAbsolutePath(),
                "LD_LIBRARY_PATH=" + libPath,
                "PYTHONPATH=" + ex.getAbsolutePath(),
                "HOME=" + py.getAbsolutePath(),
                "PATH=/system/bin:/system/xbin",
                "PYTHONDONTWRITEBYTECODE=1",
        };

        // 暂存先清空，保证这次 tar 回流的东西全是本次产物。
        runShell(new String[]{"sh", "-c", "rm -rf '" + TMP_OUT.getAbsolutePath() + "'"}, cb);
        runShell(new String[]{"sh", "-c", "mkdir -p '" + TMP_OUT.getAbsolutePath() + "'"}, cb);

        // ── 第一步：棋盘 / UI / 弹道 / 模块这几类美术 ─────────────────
        ExtractTask.get().step(ExtractTask.Step.MAP, "正在读取棋盘与界面美术…");
        List<String> cmd = new ArrayList<>();
        cmd.add(pyBin.getAbsolutePath());
        cmd.add(new File(ex, "extract.py").getAbsolutePath());
        cmd.add("--game");
        cmd.add(ShizukuBridge.arkBundles());
        cmd.add("--out");
        cmd.add(new File(TMP_OUT, "local").getAbsolutePath());
        cmd.add("--manifest");
        cmd.add(new File(TMP_OUT, "local-assets.json").getAbsolutePath());
        for (String g : groups) {
            cmd.add("--only");
            cmd.add(g);
        }
        int code = exec(py, cmd, env, cb);
        if (code != 0) {
            drainTmp(cb);
            return code;
        }

        // ── 第二步：干员列表（扫 skinpack/ 文件名，秒级） ──────────────
        //
        // 源是 skinpack/（文件名就是 charId），不依赖解析数据表，
        // 游戏一出新干员就自动出现在列表里。
        //
        // ⚠️ 后两步失败**不能**让整次提取判失败。用户真正要的是「棋盘能显示」，
        // 干员名单和立绘是加分项；任何一步抛异常都把已经解出来的美术一起废掉，
        // 体验上就是「明明等了很久结果告诉我失败了」。所以这里吞掉异常，只在日志里留痕。
        ExtractTask.get().step(ExtractTask.Step.ROSTER, "正在扫描干员名单…");
        try {
            int roster = readRoster(py, ex, env, cb);
            if (roster != 0) cb.onLine("warn: 干员名单提取退出码 " + roster + "（不影响棋盘美术）");
        } catch (Exception e) {
            cb.onLine("warn: 干员名单提取失败 — " + e);
        }

        // ── 第三步：干员头像 / 立绘 ─────────────────────────────────
        // 网页的 data/assets.json 给每个干员登记了
        // /assets/char/{avatar,portrait,illust}/<id>[_1|_2].png，但这些目录原先根本不存在，
        // 于是所有人都是灰剪影。这里从 chararts/<charId>.ab 把 Texture2D 解出来按登记路径写。
        ExtractTask.get().step(ExtractTask.Step.ART, "正在解干员立绘…");
        try {
            int art = extractOperatorArt(py, ex, env, cb);
            if (art != 0) cb.onLine("warn: 干员立绘提取退出码 " + art + "（不影响棋盘美术）");
        } catch (Exception e) {
            cb.onLine("warn: 干员立绘提取失败 — " + e);
        }

        // ── 第四步：干员皮肤（skinpack） ───────────────────────────
        // 精一 / 精二立绘在 chararts 里，**官方时装只在 skinpack 里**。
        // 实测 20 个干员约 32 秒、每个约 370KB，全量 434 个约 11 分钟 / 160MB，
        // 所以默认**不跑**：只有用户第一次在详情页里点了「皮肤」才按需解一个干员。
        // （见 extractSkins(charId)：同样的脚本，--only 限定一个 bundle，约 1~2 秒。）
        ExtractTask.get().step(ExtractTask.Step.SKIN, "正在检查皮肤索引…");
        if (WANT_SKINS) {
            try {
                int sk = extractSkins(py, ex, env, cb, null);
                if (sk != 0) cb.onLine("warn: 皮肤提取退出码 " + sk + "（不影响其它美术）");
            } catch (Exception e) {
                cb.onLine("warn: 皮肤提取失败 — " + e);
            }
        } else {
            cb.onLine("skip: 皮肤索引按需解包（详情页点「皮肤」时才解，全量约 11 分钟）");
        }

        // 全部写完，把暂存整体搬进私有目录并清空。
        ExtractTask.get().step(ExtractTask.Step.DUMP, "正在写入应用目录…");
        drainTmp(cb);

        return 0;
    }

    private int exec(File py, List<String> cmd, String[] env, Progress cb) throws Exception {
        Process p = ShizukuBridge.process(cmd.toArray(new String[0]), env, py.getAbsolutePath());
        pump(p.getInputStream(), cb);
        pump(p.getErrorStream(), cb);
        return p.waitFor();
    }

    /**
     * 把 /data/local/tmp/arksim-out 整个 tar 回收到 App 私有目录，然后删掉暂存。
     *
     * <p>tar 由 shell 身份跑（它能读暂存、能读方舟 bundle），解包由本 App 自己写私有目录。
     * 全过程不产生任何媒体可见文件。
     */
    private void drainTmp(Progress cb) throws Exception {
        if (!TMP_OUT.isDirectory()) return;

        cb.onLine("正在把提取结果转储进 App 私有目录…");
        String[] cmd = {"sh", "-c", "cd '" + TMP_OUT.getAbsolutePath() + "' && tar cf - ."};
        Process p = ShizukuBridge.process(cmd, new String[]{"PATH=/system/bin:/system/xbin"}, "/data/local/tmp");

        final int[] wrote = {0};
        try (InputStream raw = p.getInputStream()) {
            wrote[0] = TarExtract.untar(raw, (path, size, mtime) -> mapEntry(path, size));
        } catch (IOException e) {
            cb.onLine("转储告警：" + e.getMessage());
        }

        int exit = p.waitFor();
        if (exit != 0) cb.onLine("tar 退出码 " + exit + "（已转储 " + wrote[0] + " 个文件）");

        cb.onLine("提取结果已转储进 App 私有目录（" + wrote[0] + " 个文件）");
        runShell(new String[]{"sh", "-c", "rm -rf '" + TMP_OUT.getAbsolutePath() + "'"}, cb);
    }

    /**
     * tar 条目的落点映射。暂存目录结构是：
     * <pre>
     *   local/...                    提取出的美术      → public/assets/local/...
     *   public/assets/char/...       干员头像立绘      → public/assets/char/...
     *   local-assets.json            manifest         → data/local-assets.json
     *   operators-index.json         干员列表          → data/operators-index.json
     * </pre>
     *
     * @return 目标文件；null 表示跳过（已存在且大小一致）
     */
    private File mapEntry(String path, long size) {
        String p = path;
        while (p.startsWith("./")) p = p.substring(2);

        File target;
        if (p.startsWith("local/")) {
            target = new File(webDir, "public/assets/" + p);
        } else if (p.startsWith("public/")) {
            target = new File(webDir, p);
        } else if (p.endsWith(".json") && !p.contains("/")) {
            target = new File(webDir, "data/" + p);
        } else {
            // 其它（例如 skins/ 下的零散文件）：仍然进私有区，不丢。
            target = new File(webDir, "public/assets/local/" + p);
        }

        if (target.isFile() && target.length() == size) return null;
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();
        return target;
    }

    /** 提取是否已经有产出（manifest 存在即视为跑过）。 */
    public boolean hasOutput() {
        File f = new File(webDir, "data/local-assets.json");
        return f.isFile() && f.length() > 0;
    }

    /** 是否已经解过皮肤索引（详情页据此决定要不要显示「去解皮肤」按钮）。 */
    public boolean hasSkins() {
        File f = new File(webDir, "data/local-skins.json");
        return f.isFile() && f.length() > 0;
    }

    public File manifestFile() {
        return new File(webDir, "data/local-assets.json");
    }

    /** 调 extract_operator_art.py：把干员头像/立绘解到暂存。 */
    private int extractOperatorArt(File py, File ex, String[] env, Progress cb) throws Exception {
        File script = new File(ex, "extract_operator_art.py");
        if (!script.isFile()) {
            cb.onLine("skip: extract_operator_art.py 不在提取器目录里");
            return 0;
        }
        String[] cmd = {
                new File(py, "python3.14").getAbsolutePath(),
                script.getAbsolutePath(),
                "--game", ShizukuBridge.arkBundles(),
                "--web", TMP_OUT.getAbsolutePath(),
        };
        Process p = ShizukuBridge.process(cmd, env, py.getAbsolutePath());
        pump(p.getInputStream(), cb);
        pump(p.getErrorStream(), cb);
        return p.waitFor();
    }

    /**
     * 解皮肤：`--only <charId>` 时只解这一个干员的 skinpack（约 1~2 秒），
     * 不传则全量（约 11 分钟）。
     *
     * <p>皮肤是「按需」的：详情页里把下拉拉开才调这个方法，用户没点就一个字节都不解。
     * 索引写在 data/local-skins.json，前端读它列下拉。
     */
    public int extractSkins(File py, File ex, String[] env, Progress cb, String charId) throws Exception {
        File script = new File(ex, "extract_skins.py");
        if (!script.isFile()) {
            if (cb != null) cb.onLine("skip: extract_skins.py 不在提取器目录里");
            return 0;
        }
        // 皮肤脚本自己写 public/assets/skin 与 data/local-skins.json，
        // 同样先落 shell 暂存，最后 tar 回流（不产生媒体可见文件）。
        runShell(new String[]{"sh", "-c", "mkdir -p '" + TMP_OUT.getAbsolutePath() + "'"}, cb);
        List<String> cmd = new ArrayList<>();
        cmd.add(new File(py, "python3.14").getAbsolutePath());
        cmd.add(script.getAbsolutePath());
        cmd.add("--game");
        cmd.add(ShizukuBridge.arkBundles());
        cmd.add("--web");
        cmd.add(TMP_OUT.getAbsolutePath());
        if (charId != null && !charId.isEmpty()) {
            cmd.add("--only");
            cmd.add(charId);
        }
        Process p = ShizukuBridge.process(cmd.toArray(new String[0]), env, py.getAbsolutePath());
        pump(p.getInputStream(), cb);
        pump(p.getErrorStream(), cb);
        int code = p.waitFor();
        drainTmp(cb);
        return code;
    }

    /** 调 read_roster.py：扫 skinpack 得到干员列表 + 小人索引。 */
    private int readRoster(File py, File ex, String[] env, Progress cb) throws Exception {
        File script = new File(ex, "read_roster.py");
        if (!script.isFile()) {
            cb.onLine("skip: read_roster.py 不在提取器目录里");
            return 0;
        }
        File indexFile = new File(TMP_OUT, "operators-index.json");

        // ⚠️ 这里**不能**传 --skins。
        // 加了它 read_roster.py 会逐个 UnityPy.load 375 个 skinpack bundle 并解出 Spine
        // 骨骼/图集/贴图，实测要跑几十分钟，而且 astc_encoder 在个别贴图上会直接
        // SIGILL —— 在 subprocess 里表现为退出码 132（128+4）。用户看到的
        // 「根本提取不了会弹退出码132」就是这个。
        // 干员「名单」其实只要扫一遍 skinpack/ 的文件名，秒级就能完成；
        // 2D 小人可以以后单独按需提，不该挡在整条提取链路上。
        String[] cmd = {
                new File(py, "python3.14").getAbsolutePath(),
                script.getAbsolutePath(),
                "--game", ShizukuBridge.arkBundles(),
                "--out", indexFile.getAbsolutePath(),
        };
        Process p = ShizukuBridge.process(cmd, env, py.getAbsolutePath());
        pump(p.getInputStream(), cb);
        pump(p.getErrorStream(), cb);
        return p.waitFor();
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
