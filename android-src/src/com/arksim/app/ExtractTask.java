package com.arksim.app;

import java.util.ArrayList;
import java.util.List;

/**
 * 资源提取任务的进程内状态。
 *
 * 网页那边要能问「现在到底什么情况」：没开始 / 正在跑 / 跑到哪一步 / 成功还是失败。
 * 提取在后台线程跑，所以状态用一个全局单例，网页每次轮询读一份快照。
 *
 * 进度分两层：
 *   - 阶段（{@link Step}）：准备运行时 → 棋盘美术 → 干员名单 → 干员立绘 → 转储。
 *     每个阶段在总时长里占一个权重，跨阶段时进度条才不会在第二步开头又跳回 0。
 *   - 阶段内进度：python 脚本会打 `PROGRESS 3/12 rel/path.ab`，这里解析成 0~1。
 *
 * 预计剩余时间不做花哨的模型，就是「已用时间 ÷ 已完成比例 × 剩余比例」——
 * 各阶段吞吐差很多，但同一阶段内是稳定的，分段算已经够准。
 */
public final class ExtractTask {

    public enum Phase { IDLE, PREPARING, RUNNING, DONE, FAILED }

    /** 提取的各阶段，weight 是它在总时长里的占比（加起来 1.0）。 */
    public enum Step {
        PREPARE("准备运行时", 0.06),
        MAP("棋盘与界面美术", 0.36),
        ROSTER("干员名单", 0.05),
        ART("干员立绘", 0.30),
        SKIN("干员皮肤", 0.15),
        DUMP("写入应用目录", 0.08);

        public final String label;
        public final double weight;

        Step(String label, double weight) {
            this.label = label;
            this.weight = weight;
        }

        /** 这步之前的阶段加起来占多少（进度条的起点）。 */
        public double base() {
            double sum = 0;
            for (Step s : values()) {
                if (s == this) break;
                sum += s.weight;
            }
            return sum;
        }
    }

    private static final ExtractTask INSTANCE = new ExtractTask();

    public static ExtractTask get() {
        return INSTANCE;
    }

    private volatile Phase phase = Phase.IDLE;
    private volatile String message = "";
    /** 提取器的原始输出尾部（失败时给用户看原因）。 */
    private final List<String> log = new ArrayList<>();
    private static final int LOG_MAX = 40;
    /** 上次跑完的退出码；-1 表示还没跑过。 */
    private volatile int lastExit = -1;
    private volatile long startedAt = 0;
    private volatile long endedAt = 0;

    /** 当前阶段与阶段内的完成度（0~1）。 */
    private volatile Step step = Step.PREPARE;
    private volatile double stepProgress = 0;
    /** 阶段内已处理的件数 / 总件数（0 表示这步还没报过）。 */
    private volatile int itemDone = 0;
    private volatile int itemTotal = 0;

    private ExtractTask() {
    }

    public synchronized void begin() {
        phase = Phase.PREPARING;
        message = "准备中…";
        log.clear();
        lastExit = -1;
        startedAt = System.currentTimeMillis();
        endedAt = 0;
        step = Step.PREPARE;
        stepProgress = 0;
        itemDone = 0;
        itemTotal = 0;
    }

    public void phase(Phase p, String msg) {
        phase = p;
        message = msg == null ? "" : msg;
    }

    /** 切到某个阶段（阶段内进度归零）。 */
    public void step(Step s, String msg) {
        step = s;
        stepProgress = 0;
        itemDone = 0;
        itemTotal = 0;
        if (msg != null && !msg.isEmpty()) message = msg;
    }

    public synchronized void line(String text) {
        if (text == null || text.isEmpty()) return;
        log.add(text);
        while (log.size() > LOG_MAX) log.remove(0);
        // python 侧的进度行：PROGRESS <已完成>/<总数> <bundle 相对路径>
        if (text.startsWith("PROGRESS ")) {
            String rest = text.substring(9).trim();
            int sp = rest.indexOf(' ');
            String frac = sp > 0 ? rest.substring(0, sp) : rest;
            int slash = frac.indexOf('/');
            if (slash > 0) {
                try {
                    int done = Integer.parseInt(frac.substring(0, slash));
                    int all = Integer.parseInt(frac.substring(slash + 1));
                    if (all > 0) {
                        itemTotal = all;
                        itemDone = Math.min(done, all);
                        stepProgress = Math.min(1, (double) itemDone / all);
                        String name = sp > 0 ? rest.substring(sp + 1) : "";
                        message = step.label + " · " + itemDone + "/" + all
                                + (name.isEmpty() ? "" : " · " + name);
                    }
                } catch (NumberFormatException ignored) {
                    // 解析不了就当普通日志
                }
            }
            return;
        }
        // 提取器自己会报进度（"xxx.ab: N files -> sub"），这一步直接透出来
        if (text.startsWith("done:")) {
            message = text;
        } else if (text.contains(" files -> ")) {
            message = text.trim();
        }
    }

    /** 阶段内进度直接设（准备 / 转储这些没有件数的步骤用）。 */
    public void stepFraction(double frac, String msg) {
        stepProgress = Math.max(0, Math.min(1, frac));
        if (msg != null && !msg.isEmpty()) message = msg;
    }

    public void finish(int exitCode) {
        lastExit = exitCode;
        endedAt = System.currentTimeMillis();
        if (exitCode == 0) {
            phase = Phase.DONE;
            message = "提取完成";
            stepProgress = 1;
        } else {
            phase = Phase.FAILED;
            message = "提取失败（退出码 " + exitCode + "）";
        }
    }

    public void fail(String reason) {
        lastExit = 1;
        endedAt = System.currentTimeMillis();
        phase = Phase.FAILED;
        message = reason == null ? "提取失败" : reason;
    }

    public boolean running() {
        return phase == Phase.PREPARING || phase == Phase.RUNNING;
    }

    public Phase phase() {
        return phase;
    }

    public String message() {
        return message;
    }

    public int lastExit() {
        return lastExit;
    }

    public long startedAt() {
        return startedAt;
    }

    public long endedAt() {
        return endedAt;
    }

    public Step step() {
        return step;
    }

    /** 整体完成度 0~1（按各阶段权重折算）。 */
    public double percent() {
        if (phase == Phase.DONE) return 1;
        if (phase == Phase.IDLE) return 0;
        double v = step.base() + step.weight * Math.max(0, Math.min(1, stepProgress));
        return Math.max(0, Math.min(1, v));
    }

    /**
     * 预计剩余秒数；-1 表示还估不出来（刚起步、比例太小，推算会离谱到几小时）。
     *
     * 用「已用 ÷ 已完成 × 剩余」，完成度低于 2% 时不给数字 —— 那时候分母太小，
     * 说「还剩 3 小时」只会吓人，实际往往几分钟就好了。
     */
    public long etaSeconds() {
        long now = phase == Phase.DONE || phase == Phase.FAILED ? endedAt : System.currentTimeMillis();
        if (startedAt <= 0 || now <= startedAt) return -1;
        double p = percent();
        if (p >= 0.999) return 0;
        if (p < 0.02) return -1;
        double elapsed = (now - startedAt) / 1000.0;
        double remain = elapsed / p - elapsed;
        if (remain < 0) remain = 0;
        // 超过两小时的估计没有意义，直接告诉调用方「估不出来」
        return remain > 7200 ? -1 : Math.round(remain);
    }

    public synchronized String tail(int chars) {
        StringBuilder sb = new StringBuilder();
        for (String l : log) sb.append(l).append('\n');
        String all = sb.toString();
        return all.length() <= chars ? all : all.substring(all.length() - chars);
    }
}
