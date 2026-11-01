package com.arksim.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** 抓一段日志尾部，出错时显示在屏幕上，省得每次都要 adb。 */
public final class Log {

    private Log() {
    }

    public static String tail(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = t; c != null; c = c.getCause()) {
            sb.append(c.getClass().getName()).append(": ").append(c.getMessage()).append('\n');
            StackTraceElement[] st = c.getStackTrace();
            for (int i = 0; i < Math.min(st.length, 12); i++) {
                sb.append("    at ").append(st[i]).append('\n');
            }
        }
        return sb.toString();
    }

    public static String read(InputStream in, int limit) {
        if (in == null) return "";
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > limit) {
                    byte[] all = bos.toByteArray();
                    return new String(all, all.length - limit, limit);
                }
            }
            return bos.toString("UTF-8");
        } catch (IOException e) {
            return "(" + e + ")";
        }
    }
}
