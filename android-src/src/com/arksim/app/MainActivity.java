package com.arksim.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.provider.MediaStore;
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
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
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
    /** 上次成功提取时记下的方舟资源指纹，用来判断「游戏更新了没」。 */
    private static final String KEY_ARK_FP = "arkAssetFingerprint";
    /** 用户在这一版里点过「稍后再说」的那次提醒，按指纹区分，游戏一更新就重新提醒。 */
    private static final String KEY_ARK_FP_SNOOZE = "arkAssetSnoozeFp";

    private WebView web;
    private TextView status;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private HttpService server;
    private File webDir;

    /** 最近一次量到的安全边距（px）。页面每次加载完都重新灌一遍。 */
    private int insetT = 0, insetR = 0, insetB = 0, insetL = 0;

    /** WindowInsetsController（API 30+）。 */
    private Object controller;

    /** <input type="file"> 的回调；WebView 不实现 onShowFileChooser 时点它完全没反应。 */
    private ValueCallback<Uri[]> fileChooserCallback;
    private static final int REQ_FILE_CHOOSER = 4301;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ShizukuBridge.setAppContext(this);
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
        // 视口策略（全站字号的总开关，别乱动）：
        //   setUseWideViewPort(true)  —— 让页面里 <meta viewport> 生效，布局视口 = 设备 CSS 宽度；
        //     关掉它 WebView 会退回 980px 的桌面视口，theme.css 的 100vw 就变成 980，
        //     1rem 被算成 ~51px（手机本该 ~33px），整套 rem 布局等比放大 → 看起来「整个页面都很大」。
        //   setLoadWithOverviewMode(false) —— 不要为了「一眼看全」把整页再缩放一次；
        //     手机横屏时它会把 441px 高的布局压进 360px 的可视区，字号跟着一起缩，反而更小更难读。
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        // 初始缩放交给 WebView 按视口自己算（v.setInitialScale 默认就是 0），不必显式调。
        v.setBackgroundColor(Color.BLACK);
        v.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // 每次导航后重新灌一遍安全边距（新文档的 CSS 变量是干净的）
                pushInsetsToPage();
            }
        });
        v.addJavascriptInterface(new ShellBridge(), "AndroidShell");
        // 必须给 WebChromeClient —— WebView 默认不带，window.alert/confirm/prompt
        // 会被静默当成「用户点了取消」。页面里所有 confirm 包着的操作（重置演练、
        // 新建空白沙盒、删除此存档、覆盖存档……）看起来就是「点了没反应」。
        v.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                jsDialog(message, result, null);
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                jsDialog(message, result, null);
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                      JsPromptResult result) {
                jsDialog(message, null, new Object[]{result, defaultValue == null ? "" : defaultValue});
                return true;
            }

            /**
             * 关卡制作器的「导入 JSON」是 <input type="file">。
             * WebView 默认不实现这个回调，点上去毫无反应 —— 所以必须接出来，
             * 用系统文件选择器挑一个 json，再把 Uri 交回去。
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain"});
                try {
                    startActivityForResult(Intent.createChooser(pick, "选择关卡 JSON"), REQ_FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    fileChooserCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });
    }

    /**
     * 网页里的 alert / confirm / prompt 统一走这里。
     *
     * 显式指定 Theme_Material_Dialog_Alert：本 Activity 的 windowTheme 是
     * Theme.Black.NoTitleBar.Fullscreen，用默认构造的 AlertDialog 会继承它，
     * 在 Android 12+ 上退化成远古安卓 2.3 那套观感。
     */
    private void jsDialog(String message, final JsResult result, final Object[] prompt) {
        final JsPromptResult pr = prompt != null ? (JsPromptResult) prompt[0] : null;
        EditText input = null;
        if (pr != null) {
            input = new EditText(this);
            input.setText((String) prompt[1]);
            input.setSingleLine(true);
            input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        }
        android.app.AlertDialog.Builder b =
                new android.app.AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert);
        if (message != null && message.length() > 0) b.setMessage(message);
        if (input != null) b.setView(input);
        b.setCancelable(false);
        if (pr != null) {
            final EditText box = input;
            b.setPositiveButton("确定", (d, w) -> pr.confirm(box.getText().toString()));
            b.setNegativeButton("取消", (d, w) -> pr.cancel());
        } else if (result != null) {
            b.setPositiveButton("确定", (d, w) -> result.confirm());
            b.setNegativeButton("取消", (d, w) -> result.cancel());
        } else {
            b.setPositiveButton("好", null);
        }
        b.show();
    }

    private void bootstrap() {
        // web 资源与提取产物全部放 **App 私有内部目录**（getFilesDir）。
        //
        // 曾经放在「应用专属外部目录」/storage/emulated/0/Android/data/<pkg>/files，
        // 因为提取是 Shizuku 的 shell 身份跑的、它写不进私有目录。但那样做的后果是
        // 解出来的干员头像立绘会被相册 / 文件管理器 / 媒体选择器扫成"照片"，
        // 用户手机里凭空多出上千张图 —— 这不能接受。
        //
        // 现在改成：python 只写 /data/local/tmp 暂存（shell 区，不进媒体库），
        // 解完由本进程用 tar 流式搬进这里。见 Extractor 的类注释。
        final File base = getFilesDir();
        new Thread(() -> {
            String failure = null;
            try {
                step("正在准备网页资源（首次启动较慢）…");
                // 先清掉 0.1.x 留在外部存储里的那堆干员立绘（相册能扫到的），
                // 再把网页资源解到私有目录。
                WebInstaller.purgeLegacyExternal(this, msg -> step(msg));
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
            if (!ShizukuBridge.alive()) return "Shizuku 没有在运行，请先启动 Shizuku";
            if (!ShizukuBridge.granted()) {
                ui.post(() -> ShizukuBridge.request(MainActivity.this, ok -> {
                    ExtractTask.get().phase(ExtractTask.Phase.IDLE,
                            ok ? "Shizuku 已授权，可以点「开始提取」了" : "授权被拒绝，可以再点一次重试");
                }));
                return "已弹出 Shizuku 授权框，请选「允许」，然后回来点「开始提取」";
            }
            // 先实测目录能不能读（force：用户主动点的，绕过缓存重新探）。
            // 这一步比查 PackageManager 靠谱得多 —— Android 11+ 的包可见性会让
            // getPackageInfo() 对没在 <queries> 里声明的包直接抛异常，
            // 而 shell 身份 ls 一下目录是骗不了人的。
            if (!ShizukuBridge.arkDirReadable(true)) {
                String probe = ShizukuBridge.arkDirProbe();
                if (probe.contains("目录不存在") || probe.contains("没下载完")) {
                    if (!ShizukuBridge.flavorInstalled(f)) {
                        return "没检测到" + f.label + "（" + f.pkg + "），请先安装并下载完资源";
                    }
                    return "读不到 " + f.label + " 的资源目录：确认游戏内已下载完「完整资源包」，或换到正确的客户端";
                }
                return "读不到 " + f.label + " 的资源目录";
            }
            ui.post(() -> startExtraction(true));
            return "已开始提取 " + f.label + " 的资源";
        }

        /**
         * 解一个干员的皮肤（详情页把下拉拉开时调）。
         *
         * <p>为什么不在主提取里一起解：全量 434 个 skinpack 约 11 分钟、多占 160MB，
         * 而绝大多数干员用户一辈子不换皮肤。这里只解当前这位，1~2 秒出结果，
         * 解完前端重新拉一次 /data/local-skins.json 就能看到新皮肤。
         *
         * <p>返回一行状态文字（前端直接 toast）。
         */
        @JavascriptInterface
        public String extractSkins(String charId) {
            if (charId == null || !charId.matches("^char_[0-9A-Za-z_]+$")) return "干员 id 不对";
            if (!ShizukuBridge.alive()) return "Shizuku 没在跑，先去设置里授权";
            if (!ShizukuBridge.granted()) {
                ui.post(() -> ShizukuBridge.request(MainActivity.this, ok -> {
                }));
                return "已弹出 Shizuku 授权框";
            }
            if (!ShizukuBridge.arkDirReadable(true)) return "读不到方舟资源目录";
            new Thread(() -> {
                try {
                    File rt = PythonInstaller.ensure(MainActivity.this, MainActivity.this::step);
                    Extractor ex = new Extractor(rt, webDir);
                    File py = new File(rt, "py");
                    File exDir = new File(rt, "extract");
                    String libPath = py.getAbsolutePath() + ":" + new File(py, "lib").getAbsolutePath();
                    String[] env = {
                            "PYTHONHOME=" + py.getAbsolutePath(),
                            "LD_LIBRARY_PATH=" + libPath,
                            "PYTHONPATH=" + exDir.getAbsolutePath(),
                            "HOME=" + py.getAbsolutePath(),
                            "PATH=/system/bin:/system/xbin",
                            "PYTHONDONTWRITEBYTECODE=1",
                    };
                    ExtractTask task = ExtractTask.get();
                    task.begin();
                    task.phase(ExtractTask.Phase.RUNNING, "正在解 " + charId + " 的皮肤…");
                    int code = ex.extractSkins(py, exDir, env, task::line, charId);
                    task.finish(code);
                    ui.post(() -> toastOnPage(code == 0 ? "皮肤已解好" : "皮肤解包失败（退出码 " + code + "）"));
                } catch (Throwable t) {
                    ExtractTask.get().fail(t.toString());
                    ui.post(() -> toastOnPage("皮肤解包失败：" + t));
                }
            }, "arksim-skin").start();
            return "正在解 " + charId + " 的皮肤…";
        }

        /** 皮肤索引是否已经解过（前端据此决定按钮文案）。 */
        @JavascriptInterface
        public boolean skinsReady() {
            return new Extractor(runtimeDir(), webDir).hasSkins();
        }

        /** 提取是否已经有产物（manifest 存在即视为跑过）。 */
        @JavascriptInterface
        public boolean assetsReady() {
            return new Extractor(runtimeDir(), webDir).hasOutput();
        }

        /**
         * 提取产物落地位置摘要：让用户在设置页能确认「图存在 App 私有目录里，
         * 手机相册 / 文件管理器看不到」。返回人类可读的一行。
         */
        @JavascriptInterface
        public String storageInfo() {
            File web = webDir == null ? getFilesDir() : webDir;
            long local = dirSize(new File(web, "public/assets/local"));
            long art = dirSize(new File(web, "public/assets/char"));
            return "{\"root\":\"app-private\",\"path\":" + quote(web.getAbsolutePath())
                    + ",\"localBytes\":" + local + ",\"charBytes\":" + art + "}";
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

        /**
         * 资源要不要更新？—— 首次进入、游戏热更之后都要问一次。
         *
         * 判据三件事同时成立才算「该更新」：
         *   1. Shizuku 通道能用（否则根本读不了方舟目录，提醒也没意义）
         *   2. 从没提取过（ready=false）→ 首次进入
         *   3. 现在方舟资源的指纹和上次提取时记下的不一样 → 游戏更新了
         *
         * 返回 {"need":bool,"reason":"first|updated|noready|","ready":bool,"bytes":n,
         *       "snoozed":bool}。snoozed=true 表示用户已经对这一次说过「稍后再说」。
         */
        @JavascriptInterface
        public String assetUpdateHint() {
            boolean ready = new Extractor(runtimeDir(), webDir).hasOutput();
            long bytes = assetsBytes();
            boolean channel = ShizukuBridge.alive() && ShizukuBridge.granted();
            String fp = channel ? ShizukuBridge.arkAssetFingerprint() : "";
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            String lastFp = p.getString(KEY_ARK_FP, "");
            String snoozeFp = p.getString(KEY_ARK_FP_SNOOZE, "");
            String reason = "";
            if (ShizukuBridge.alive() && ShizukuBridge.granted()) {
                if (!ready) reason = "first";
                else if (!fp.isEmpty() && !lastFp.isEmpty() && !fp.equals(lastFp)) reason = "updated";
            }
            boolean need = !reason.isEmpty();
            boolean snoozed = need && !snoozeFp.isEmpty() && snoozeFp.equals(fp);
            return "{\"need\":" + need + ",\"reason\":\"" + reason + "\""
                    + ",\"ready\":" + ready + ",\"bytes\":" + bytes
                    + ",\"snoozed\":" + snoozed
                    + ",\"fingerprint\":\"" + quote(fp).replace("\"", "") + "\""
                    + "}";
        }

        /** 用户点「稍后再说」：记住这一次的指纹，同一版本不再烦他；游戏一更新又会提醒。 */
        @JavascriptInterface
        public void suppressAssetHint() {
            String fp = ShizukuBridge.alive() && ShizukuBridge.granted()
                    ? ShizukuBridge.arkAssetFingerprint() : "";
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_ARK_FP_SNOOZE, fp).apply();
        }

        /** 提取任务快照（网页轮询它画进度）。 */
        @JavascriptInterface
        public String extractStatus() {
            ExtractTask t = ExtractTask.get();
            long bytes = assetsBytes();
            StringBuilder sb = new StringBuilder();
            sb.append("{\"phase\":\"").append(t.phase().name()).append("\",")
              .append("\"running\":").append(t.running()).append(',')
              .append("\"message\":").append(quote(t.message())).append(',')
              .append("\"exit\":").append(t.lastExit()).append(',')
              .append("\"startedAt\":").append(t.startedAt()).append(',')
              .append("\"endedAt\":").append(t.endedAt()).append(',')
              .append("\"ready\":").append(new Extractor(runtimeDir(), webDir).hasOutput()).append(',')
              .append("\"bytes\":").append(bytes).append(',')
              .append("\"tail\":").append(quote(t.tail(2400))).append(',')
              .append("\"percent\":").append(Math.round(t.percent() * 1000) / 10.0).append(',')
              .append("\"step\":").append(quote(t.step().label)).append(',')
              .append("\"eta\":").append(t.etaSeconds())
              .append('}');
            return sb.toString();
        }

        /** 提取产物的体积（网页上显示「已提取 xx MB」）。 */
        @JavascriptInterface
        public long assetsBytes() {
            File root = new File(webDir, "public/assets");
            long n = dirSize(new File(root, "local"));
            n += dirSize(new File(root, "char"));
            return n;
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

        /**
         * 关卡制作器的「导出」。
         *
         * 网页里 `a[download] + Blob` 那套在 WebView 里不会真正落盘（没有
         * DownloadListener，也不会弹任何东西），点了像没反应。所以走这里：
         * API 29+ 用 MediaStore 写进系统「下载」目录（文件管理器里能找到），
         * 更老的系统写进应用专属外部目录。返回一句话给页面 toast。
         */
        @JavascriptInterface
        public String saveText(String name, String text) {
            String safe = name == null || name.trim().isEmpty() ? "level" : name.trim();
            safe = safe.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
            if (!safe.endsWith(".json")) safe += ".json";
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    cv.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, "Download");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return "保存失败：系统没有给出可写的下载位置";
                    try (java.io.OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) return "保存失败：写不进下载目录";
                        out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        out.flush();
                    }
                    return "已保存到「下载」：" + safe;
                }
                File dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = getFilesDir();
                if (!dir.exists() && !dir.mkdirs()) return "保存失败：建不了目录";
                File out = new File(dir, safe);
                try (java.io.OutputStreamWriter w = new java.io.OutputStreamWriter(
                        new java.io.FileOutputStream(out), java.nio.charset.StandardCharsets.UTF_8)) {
                    w.write(text);
                }
                return "已保存到：" + out.getAbsolutePath();
            } catch (Throwable t) {
                return "保存失败：" + t.getMessage();
            }
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

    /**
     * python 运行时放哪。
     *
     * 依旧放**外部**专属目录：里面的 python3.14 与 .so 只是运行时，不是图片，
     * 媒体库不会把它们当照片；而且 shell 身份能直接读（私有目录它读不到），
     * Extractor.prepare() 要 cp 到 /data/local/tmp 才跑得起来。
     */
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
                task.step(ExtractTask.Step.PREPARE, "释放 python 运行时…");
                File rt = PythonInstaller.ensure(this, this::step);
                task.phase(ExtractTask.Phase.RUNNING, "正在读取方舟资源…");
                step("正在提取《明日方舟》资源（Shizuku 直读）…");
                Extractor ex = new Extractor(rt, webDir);
                int code = ex.run(null, line -> {
                    task.line(line);
                    if (line.startsWith("done:")) ui.post(() -> status.setText(line));
                });
                task.finish(code);
                if (code == 0) rememberAssetFingerprint();
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

    /** 提取成功后记下方舟资源的指纹，下次用它判断游戏有没有更新。 */
    private void rememberAssetFingerprint() {
        try {
            final String fp = ShizukuBridge.arkAssetFingerprint();
            if (fp == null || fp.isEmpty()) return;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_ARK_FP, fp)
                    .remove(KEY_ARK_FP_SNOOZE)
                    .apply();
        } catch (Throwable ignored) {
        }
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
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(result);
                fileChooserCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
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
