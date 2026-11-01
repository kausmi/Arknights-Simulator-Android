package com.arksim.app;

import java.util.ArrayList;
import java.util.List;

/**
 * 资源提取任务的进程内状态。
 *
 * 网页那边要能问「现在到底什么情况」：没开始 / 正在跑 / 跑到哪一步 / 成功还是失败。
 * 提取在后台线程跑，所以状态用一个全局单例，网页每次轮询读一份快照。
 *
 * 这里只管状态，真正的活是 {@link Extractor} 干的。
 */
public final class ExtractTask {

    public enum Phase { IDLE, PREPARING, RUNNING, DONE, FAILED }

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

    private ExtractTask() {
    }

    public synchronized void begin() {
        phase = Phase.PREPARING;
        message = "准备中…";
        log.clear();
        lastExit = -1;
        startedAt = System.currentTimeMillis();
        endedAt = 0;
    }

    public void phase(Phase p, String msg) {
        phase = p;
        message = msg == null ? "" : msg;
    }

    public synchronized void line(String text) {
        if (text == null || text.isEmpty()) return;
        log.add(text);
        while (log.size() > LOG_MAX) log.remove(0);
        // 提取器自己会报进度（"xxx.ab: N files -> sub"），这一步直接透出来
        if (text.startsWith("done:")) {
            message = text;
        } else if (text.contains(" files -> ")) {
            message = text.trim();
        }
    }

    public void finish(int exitCode) {
        lastExit = exitCode;
        endedAt = System.currentTimeMillis();
        if (exitCode == 0) {
            phase = Phase.DONE;
            message = "提取完成";
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

    public synchronized String tail(int chars) {
        StringBuilder sb = new StringBuilder();
        for (String l : log) sb.append(l).append('\n');
        String all = sb.toString();
        return all.length() <= chars ? all : all.substring(all.length() - chars);
    }
}
