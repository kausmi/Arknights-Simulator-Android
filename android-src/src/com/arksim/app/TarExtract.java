package com.arksim.app;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 极简 tar 解包器（只读，够用就好）。
 *
 * 存在的理由：提取是 Shizuku 的 shell 身份跑的，而**转储目标必须是 App 私有内部目录**
 * （/data/user/0/com.arksim.app），否则提取出来的干员立绘会落在
 * /storage/emulated/0/Android/data/... 底下，被相册 / 文件管理器 / 媒体选择器扫成"照片"。
 * 偏偏 shell 身份写不进私有目录（父目录 0700 + SELinux untrusted_app_data_file）。
 *
 * 所以流程是：python 以 shell 身份把文件写进 /data/local/tmp 暂存，
 * 完了 shell 跑 `tar cf - -C <暂存> .`，本类从 stdout 边读边解到私有目录，最后删掉暂存。
 * 全程没有任何一张图落在媒体可见的位置。
 *
 * 支持：ustar（含 prefix 字段）、GNU 长文件名（typeflag 'L' / 'K'）、PAX（'x' 直接跳过）、
 * 普通文件 '0' / '\0'、目录 '5'、硬链接 '1'、符号链接 '2'（跳过，我们只写普通文件）。
 */
final class TarExtract {

    interface Mapper {
        /**
         * 决定一个条目的落点。
         *
         * @return 目标文件；返回 null 表示跳过这个条目（例如已存在的同尺寸文件）
         */
        File map(String path, long size, long mtimeSec);
    }

    private TarExtract() {
    }

    /**
     * 把 tar 流解到 dest 下。
     *
     * @return 实际写出的文件数
     */
    static int untar(InputStream in, Mapper mapper) throws IOException {
        byte[] header = new byte[512];
        byte[] copyBuf = new byte[64 * 1024];
        int written = 0;
        String pendingLongName = null;

        while (true) {
            if (!readFully(in, header, 512)) break;
            if (isZeroBlock(header)) break;

            String name = pendingLongName != null ? pendingLongName : readName(header);
            pendingLongName = null;
            long size = readOctal(header, 124, 12);
            long mtime = readOctal(header, 136, 12);
            char type = (char) (header[156] & 0xFF);
            if (type == 0) type = '0';

            // GNU 长名：这一段的数据就是下一个条目的真名。
            if (type == 'L') {
                byte[] buf = new byte[(int) size];
                if (!readFully(in, buf, buf.length)) break;
                int end = buf.length;
                for (int i = 0; i < buf.length; i++) {
                    if (buf[i] == 0) {
                        end = i;
                        break;
                    }
                }
                pendingLongName = new String(buf, 0, end, StandardCharsets.UTF_8);
                skipPadding(in, size);
                continue;
            }
            // GNU 长链接名：我们用不到，读掉即可。
            if (type == 'K') {
                skipExactly(in, size);
                skipPadding(in, size);
                continue;
            }
            // PAX 扩展头：内容是 "len key=value\n" 序列。Android 的 toybox tar 在
            // 路径含非 ASCII（中文、emoji）或超长时会改用 PAX 存 path=，此时头里的
            // name 字段是被截断的占位符 —— 必须从扩展头里取真名，否则文件名会变成垃圾。
            if (type == 'x') {
                byte[] buf = new byte[(int) size];
                if (!readFully(in, buf, buf.length)) break;
                String paxPath = paxValue(buf, "path");
                if (paxPath != null) pendingLongName = paxPath;
                skipPadding(in, size);
                continue;
            }
            // 全局扩展头 'g' 我们不需要，读掉。
            if (type == 'g') {
                skipExactly(in, size);
                skipPadding(in, size);
                continue;
            }

            String path = normalize(name);
            boolean wantFile = (type == '0') && path != null && !path.isEmpty();

            if (wantFile) {
                File out = mapper == null ? null : mapper.map(path, size, mtime);
                if (out == null) {
                    skipExactly(in, size);
                } else {
                    File parent = out.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
                        throw new IOException("无法创建目录 " + parent);
                    }
                    try (OutputStream os = new BufferedOutputStream(new FileOutputStream(out), 64 * 1024)) {
                        long left = size;
                        while (left > 0) {
                            int want = (int) Math.min(copyBuf.length, left);
                            int n = in.read(copyBuf, 0, want);
                            if (n < 0) throw new IOException("tar 流提前结束：" + path);
                            os.write(copyBuf, 0, n);
                            left -= n;
                        }
                    }
                    written++;
                }
            } else {
                skipExactly(in, size);
            }
            skipPadding(in, size);
        }
        return written;
    }

    /**
     * 从 PAX 扩展头里取一个 key 的值。
     *
     * 每条记录是 {@code "<len> <key>=<value>\n"}，len 是整条记录（含 len 本身与换行）的字节数。
     * 我们只关心 path。
     */
    private static String paxValue(byte[] buf, String key) {
        int i = 0;
        String prefix = key + "=";
        while (i < buf.length) {
            // 读十进制长度
            int len = 0;
            int start = i;
            while (i < buf.length && buf[i] >= '0' && buf[i] <= '9') {
                len = len * 10 + (buf[i] - '0');
                i++;
            }
            if (len <= 0 || start == i) break;
            if (i < buf.length && buf[i] == ' ') i++;
            int recordEnd = start + len;
            if (recordEnd > buf.length) recordEnd = buf.length;
            int valueStart = i;
            int valueEnd = recordEnd;
            // 去掉行尾的 \n
            while (valueEnd > valueStart && (buf[valueEnd - 1] == '\n' || buf[valueEnd - 1] == 0)) valueEnd--;
            int plen = prefix.length();
            if (valueEnd - valueStart >= plen) {
                boolean match = true;
                for (int k = 0; k < plen; k++) {
                    if ((char) (buf[valueStart + k] & 0xFF) != prefix.charAt(k)) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    return new String(buf, valueStart + plen, valueEnd - valueStart - plen, StandardCharsets.UTF_8);
                }
            }
            i = recordEnd;
        }
        return null;
    }

    /** ustar 的 name(100) + prefix(155)，两者拼起来才是完整路径。 */
    private static String readName(byte[] h) {
        String name = cstr(h, 0, 100);
        String prefix = cstr(h, 345, 155);
        if (!prefix.isEmpty()) return prefix + "/" + name;
        return name;
    }

    private static String cstr(byte[] b, int off, int len) {
        int end = off;
        int max = off + len;
        while (end < max && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    private static long readOctal(byte[] b, int off, int len) {
        // GNU tar 对大文件会用 base-256（首字节最高位为 1）。
        if ((b[off] & 0x80) != 0) {
            long v = b[off] & 0x7F;
            for (int i = 1; i < len; i++) v = (v << 8) | (b[off + i] & 0xFF);
            return v;
        }
        long v = 0;
        for (int i = 0; i < len; i++) {
            byte c = b[off + i];
            if (c == 0 || c == ' ') continue;
            if (c < '0' || c > '7') continue;
            v = v * 8 + (c - '0');
        }
        return v;
    }

    private static boolean isZeroBlock(byte[] h) {
        for (byte b : h) {
            if (b != 0) return false;
        }
        return true;
    }

    /** 只保留相对路径，挡掉绝对路径与 .. （tar 也可能带 "./" 前缀）。 */
    private static String normalize(String raw) {
        String p = raw.replace('\\', '/');
        while (p.startsWith("./")) p = p.substring(2);
        while (p.startsWith("/")) p = p.substring(1);
        if (p.isEmpty() || p.endsWith("/")) return null;
        String[] parts = p.split("/");
        StringBuilder sb = new StringBuilder();
        for (String s : parts) {
            if (s.isEmpty() || s.equals(".")) continue;
            if (s.equals("..")) return null;
            if (sb.length() > 0) sb.append('/');
            sb.append(s);
        }
        return sb.toString();
    }

    private static void skipPadding(InputStream in, long size) throws IOException {
        long pad = (512 - (size % 512)) % 512;
        skipExactly(in, pad);
    }

    private static void skipExactly(InputStream in, long n) throws IOException {
        long left = n;
        byte[] buf = new byte[8192];
        while (left > 0) {
            int want = (int) Math.min(buf.length, left);
            int got = in.read(buf, 0, want);
            if (got < 0) return;
            left -= got;
        }
    }

    private static boolean readFully(InputStream in, byte[] buf, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) return off > 0 && off == len;
            off += n;
        }
        return true;
    }
}
