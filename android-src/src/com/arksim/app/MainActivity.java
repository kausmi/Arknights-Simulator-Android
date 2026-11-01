package com.arksim.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.DisplayCutout;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.File;

/**
 * 明日方舟沙盒 · Android 壳。
 *
 * 启动顺序：解开 web 资源 → 起本机 HTTP 服务 → 装载 WebView。
 * 全程本机，不联网；服务端是 Java 手写的，不再内置 node。
 *
 * 方舟的资源用 Shizuku 以 shell 身份直读（见 {@link ShizukuBridge} / {@link Extractor}）。
 *
 * 屏幕：内容铺满整块屏幕（状态栏 / 导航栏 / 挖孔区都算在内，不留任何黑边），
 * 同时把挖孔与手势条的真实尺寸通过 CSS 变量喂给页面，让界面自己躲开它们。
 */
public class MainActivity extends Activity {

    public static final int PORT = 3100;
    private static final String PREFS = "arksim";
    private static final String KEY_ORIENTATION = "battleOrientation";

    private WebView web;
    private TextView status;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private HttpService server;
    private File webDir;

    /** 最近一次量到的安全边距（px）。页面每次加载完都重新灌一遍。 */
    private int insetT = 0, insetR = 0, insetB = 0, insetL = 0;

    /** WindowInsetsController（API 30+）。 */
    private Object controller;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        edgeToEdge();
        applyOrientation(readOrientation());

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        configureWeb(web);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setBackgroundColor(Color.BLACK);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        status.setPadding(48, 64, 48, 48);
        status.setText("正在准备…");
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);
        watchInsets(root);
        bootstrap();
    }

    // ── 铺满全屏 + 挖孔避让 ────────────────────────────────────────────

    /**
     * 去掉一切系统装饰带来的黑边：
     *  - 内容铺到状态栏、导航栏、挖孔区底下
     *  - 系统栏本身隐藏（沉浸式粘滞），下滑一次才露面
     *  - 刘海/挖孔允许内容进入（SHORT_EDGES），再由 insets 告诉页面躲开多少
     */
    private void edgeToEdge() {
        Window w = getWindow();
        w.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }

        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            w.setDecorFitsSystemWindows(false);
        }
        hideSystemBars();
    }

    private void hideSystemBars() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // getWindow().getInsetsController() 在 setContentView 之前会 NPE（mDecor 还没建），
                // 所以每次都从 DecorView 现取 —— getDecorView() 本身会保证它存在。
                android.view.WindowInsetsController c =
                        getWindow().getDecorView().getWindowInsetsController();
                if (c == null) c = getWindow().getInsetsController();
                controller = c;
                if (c == null) throw new IllegalStateException("no insets controller");
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * 量出「界面不能画进来」的区域：挖孔（刘海）与手势条。
     *
     * 沉浸式下状态栏是隐藏的，但它底下那块挖孔仍然真真切切挡着屏幕，
     * 所以要单独从 DisplayCutout 取 top/left/right；底部还要合并手势条的 inset，
     * 否则最下面一排按钮会被系统手势条压住。
     */
    private void watchInsets(View root) {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int cutT = 0, cutR = 0, cutB = 0, cutL = 0;
            int sysT = 0, sysR = 0, sysB = 0, sysL = 0;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                DisplayCutout dc = insets.getDisplayCutout();
                if (dc != null) {
                    cutT = dc.getSafeInsetTop();
                    cutR = dc.getSafeInsetRight();
                    cutB = dc.getSafeInsetBottom();
                    cutL = dc.getSafeInsetLeft();
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets nav = insets.getInsets(WindowInsets.Type.navigationBars());
                sysB = nav.bottom;
                sysL = nav.left;
                sysR = nav.right;
            } else {
                sysT = insets.getSystemWindowInsetTop();
                sysR = insets.getSystemWindowInsetRight();
                sysB = insets.getSystemWindowInsetBottom();
                sysL = insets.getSystemWindowInsetLeft();
            }

            // 状态栏被我们隐藏了，所以上方只看挖孔；底部取挖孔与手势条的较大值。
            int t = Math.max(cutT, 0);
            int b = Math.max(cutB, sysB);
            int l = Math.max(cutL, sysL);
            int r = Math.max(cutR, sysR);
            if (t != insetT || b != insetB || l != insetL || r != insetR) {
                insetT = t;
                insetB = b;
                insetL = l;
                insetR = r;
                pushInsetsToPage();
            }
            return insets;
        });
        root.requestApplyInsets();
    }

    /** 把量到的 px 值写成 CSS 变量，页面里的 --sa-* 就会用它们排 UI。 */
    private void pushInsetsToPage() {
        if (web == null) return;
        float d = getResources().getDisplayMetrics().density;
        String js = "(function(){var s=document.documentElement.style;"
                + "s.setProperty('--sa-t','" + (insetT / d) + "px');"
                + "s.setProperty('--sa-r','" + (insetR / d) + "px');"
                + "s.setProperty('--sa-b','" + (insetB / d) + "px');"
                + "s.setProperty('--sa-l','" + (insetL / d) + "px');"
                + "})();";
        ui.post(() -> {
            try {
                web.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
            }
        });
    }

    // ── Web ──────────────────────────────────────────────────────────

    private void configureWeb(WebView v) {
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 让 WebView 自己横向撑满，别按内容宽度收缩留边
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        v.setBackgroundColor(Color.BLACK);
        v.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // 每次导航后重新灌一遍安全边距（新文档的 CSS 变量是干净的）
                pushInsetsToPage();
            }
        });
        v.addJavascriptInterface(new ShellBridge(), "AndroidShell");
    }

    private void bootstrap() {
        final File base = getFilesDir();
        new Thread(() -> {
            String failure = null;
            try {
                step("正在准备网页资源（首次启动较慢）…");
                webDir = WebInstaller.ensure(this, base, this::step);

                step("正在启动本地服务…");
                server = new HttpService(webDir, PORT);
                server.start();

                step("正在等待服务就绪…");
                if (!waitPort(PORT, 20000)) {
                    failure = "本地服务未在超时内就绪（端口 " + PORT + "）。";
                }
            } catch (Throwable t) {
                failure = "启动失败：" + t + "\n\n" + Log.tail(t);
            }
            final String f = failure;
            ui.post(() -> {
                if (f == null) {
                    status.setVisibility(View.GONE);
                    web.loadUrl("http://127.0.0.1:" + PORT + "/studio/home.html");
                } else {
                    status.setText(f);
                }
            });
        }, "arksim-bootstrap").start();
    }

    private void step(String msg) {
        ui.post(() -> status.setText(msg));
    }

    /** 轮询端口，直到本机服务接受连接。 */
    static boolean waitPort(int port, long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 500);
                return true;
            } catch (Throwable ignored) {
            }
            try {
                Thread.sleep(120);
            } catch (InterruptedException e) {
                return false;
            }
        }
        return false;
    }

    // ── 战斗界面屏幕方向 ─────────────────────────────────────────────
    // landscape 横屏（默认） / auto 跟随系统 / portrait 竖屏

    private String readOrientation() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        return p.getString(KEY_ORIENTATION, "landscape");
    }

    private void writeOrientation(String mode) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_ORIENTATION, mode).apply();
    }

    private void applyOrientation(String mode) {
        int o;
        if ("portrait".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
        else if ("auto".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        else o = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        try {
            setRequestedOrientation(o);
        } catch (Throwable ignored) {
        }
    }

    /** 暴露给网页的桥。 */
    public class ShellBridge {
        @JavascriptInterface
        public void setBattleOrientation(final String mode) {
            final String m = mode == null ? "landscape" : mode;
            ui.post(() -> {
                writeOrientation(m);
                applyOrientation(m);
            });
        }

        @JavascriptInterface
        public String getBattleOrientation() {
            return readOrientation();
        }

        /** 供页面查询当前的安全边距（已按 density 换算成 CSS px）。 */
        @JavascriptInterface
        public String safeInsets() {
            float d = getResources().getDisplayMetrics().density;
            return "{\"top\":" + (insetT / d) + ",\"right\":" + (insetR / d)
                    + ",\"bottom\":" + (insetB / d) + ",\"left\":" + (insetL / d) + "}";
        }

        @JavascriptInterface
        public String runtimeInfo() {
            return "arksim/" + PORT + "/" + Build.VERSION.SDK_INT;
        }

        @JavascriptInterface
        public String shizukuState() {
            return ShizukuBridge.describe();
        }

        /** 网页侧点「提取方舟资源」时调用；返回一句立即给用户看的话。 */
        @JavascriptInterface
        public String extractAssets() {
            ShizukuBridge.Flavor f = ShizukuBridge.currentFlavor();
            if (!f.usable) return f.label + " 暂时还用不了（目录结构还没适配），请切到简中官服或 B 服";
            if (!ShizukuBridge.flavorInstalled(f)) return "没检测到" + f.label + "（" + f.pkg + "），请先安装并下载完资源";
            if (!ShizukuBridge.alive()) return "Shizuku 没有在运行，请先启动 Shizuku";
            if (!ShizukuBridge.granted()) {
                ui.post(() -> ShizukuBridge.request(MainActivity.this, ok -> {
                    ExtractTask.get().phase(ExtractTask.Phase.IDLE,
                            ok ? "Shizuku 已授权，可以点「开始提取」了" : "授权被拒绝，可以再点一次重试");
                }));
                return "已弹出 Shizuku 授权框，请选「允许」，然后回来点「开始提取」";
            }
            // 授权了但目录还是读不到：多半是资源没下完，或者选错了服
            if (!ShizukuBridge.arkDirReadable()) {
                String probe = ShizukuBridge.arkDirProbe();
                if (probe.contains("目录不存在") || probe.contains("没下载完")) {
                    return "读不到 " + f.label + " 的资源目录：确认游戏内已下载完「完整资源包」，或换到正确的客户端";
                }
                return "读不到 " + f.label + " 的资源目录";
            }
            ui.post(() -> startExtraction(true));
            return "已开始提取 " + f.label + " 的资源";
        }

        /** 提取是否已经有产物（manifest 存在即视为跑过）。 */
        @JavascriptInterface
        public boolean assetsReady() {
            return new Extractor(runtimeDir(), webDir).hasOutput();
        }

        /** 资源在不在本机：方舟资源目录能不能读到（需要 Shizuku）。 */
        @JavascriptInterface
        public boolean arkAssetsPresent() {
            return ShizukuBridge.arkDirReadable();
        }

        /** Shizuku 的完整状态，给设置页显示徽章用。 */
        @JavascriptInterface
        public String shizukuStatus() {
            return ShizukuBridge.statusJson();
        }

        /** 各包体（官服 / B 服 / 其它语言服）的状态与当前选中项。 */
        @JavascriptInterface
        public String arkFlavors() {
            return ShizukuBridge.flavorsJson();
        }

        /** 切换要读哪个包体（"cn" / "bilibili" / ...）。返回切换后的状态 JSON。 */
        @JavascriptInterface
        public String selectArkFlavor(String id) {
            ShizukuBridge.setFlavorId(id == null ? "cn" : id);
            return ShizukuBridge.flavorsJson();
        }

        /** 提取任务快照（网页轮询它画进度）。 */
        @JavascriptInterface
        public String extractStatus() {
            ExtractTask t = ExtractTask.get();
            File outDir = new File(webDir, "public/assets/local");
            long bytes = outDir.isDirectory() ? dirSize(outDir) : 0;
            StringBuilder sb = new StringBuilder();
            sb.append("{\"phase\":\"").append(t.phase().name()).append("\",")
              .append("\"running\":").append(t.running()).append(',')
              .append("\"message\":").append(quote(t.message())).append(',')
              .append("\"exit\":").append(t.lastExit()).append(',')
              .append("\"startedAt\":").append(t.startedAt()).append(',')
              .append("\"endedAt\":").append(t.endedAt()).append(',')
              .append("\"ready\":").append(new Extractor(runtimeDir(), webDir).hasOutput()).append(',')
              .append("\"bytes\":").append(bytes).append(',')
              .append("\"tail\":").append(quote(t.tail(2400)))
              .append('}');
            return sb.toString();
        }

        /** 提取产物的体积（网页上显示「已提取 xx MB」）。 */
        @JavascriptInterface
        public long assetsBytes() {
            File outDir = new File(webDir, "public/assets/local");
            return outDir.isDirectory() ? dirSize(outDir) : 0;
        }

        /**
         * 「授权教程」：交给网页自己画（终端风，跟整体界面一致）。
         * 之前这里是原生 AlertDialog，它套用了 Theme.Black.NoTitleBar.Fullscreen，
         * 在 Android 12+ 上会退化成很老的方框样式，观感上像安卓 2.3 —— 所以不再用原生弹窗。
         */
        @JavascriptInterface
        public void showShizukuHelp() {
            ui.post(() -> {
                if (web != null) web.evaluateJavascript(
                        "window.__arksimShowShizukuHelp && window.__arksimShowShizukuHelp();", null);
            });
        }

        /** 用 shell 身份实测资源目录状态，给「为什么读不到」一个确切原因。 */
        @JavascriptInterface
        public String arkDirProbe() {
            return ShizukuBridge.arkDirProbe();
        }
    }

    private static String quote(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    private static long dirSize(File dir) {
        long total = 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;
        for (File f : files) {
            if (f.isDirectory()) total += dirSize(f);
            else total += f.length();
        }
        return total;
    }

    private File runtimeDir() {
        File base = getExternalFilesDir(null);
        return new File(base == null ? getFilesDir() : base, "rt");
    }

    /** 跑提取（后台线程），进度写进 status 与日志。 */
    private void startExtraction(boolean notify) {
        new Thread(() -> {
            try {
                ExtractTask task = ExtractTask.get();
                task.begin();
                step("正在释放 python 运行时（首次较慢）…");
                task.phase(ExtractTask.Phase.PREPARING, "释放 python 运行时…");
                File rt = PythonInstaller.ensure(this, this::step);
                task.phase(ExtractTask.Phase.RUNNING, "正在读取方舟资源…");
                step("正在提取《明日方舟》资源（Shizuku 直读）…");
                Extractor ex = new Extractor(rt, webDir);
                int code = ex.run(null, line -> {
                    task.line(line);
                    if (line.startsWith("done:")) ui.post(() -> status.setText(line));
                });
                task.finish(code);
                if (notify) {
                    toastOnPage(code == 0
                            ? "资源提取完成"
                            : "资源提取失败（退出码 " + code + "）" + task.tail(400));
                }
            } catch (Throwable t) {
                ExtractTask.get().fail(t.toString());
                if (notify) toastOnPage("提取失败：" + t);
            }
        }, "arksim-extract").start();
    }

    /**
     * 在网页上弹一个终端风提示，而不是原生 AlertDialog。
     *
     * 原生 AlertDialog 套的是 Theme.Black.NoTitleBar.Fullscreen，在 Android 12+ 上会退化成
     * 老式方框（观感像安卓 2.3），和整体界面完全不搭 —— 所以壳里不再用原生弹窗，
     * 统一让网页画（window.__arksimToast）。
     */
    private void toastOnPage(String text) {
        if (web == null) return;
        final String js = "(function(){var t=" + jsonString(text) + ";"
                + "if(window.__arksimToast){window.__arksimToast(t);}"
                + "else if(window.__arksimShowShizukuHelp){window.__arksimShowShizukuHelp();}"
                + "})();";
        ui.post(() -> {
            try {
                web.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
            }
        });
    }

    /** 把任意字符串转成 JS 字符串字面量（含引号）。 */
    private static String jsonString(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 系统栏被临时唤出来后（下滑），重新回到沉浸式
        if (hasFocus) hideSystemBars();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        super.onDestroy();
    }
}
