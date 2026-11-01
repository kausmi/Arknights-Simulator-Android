#!/usr/bin/env python3
"""从本机《明日方舟》客户端读干员表（character_table 等）。

背景
----
官方数据表以「单 TextAsset 的 bundle」形式存在
    Bundles/anon/<hash>.bin
文件名是内容哈希（游戏更新会变），内容既不是 JSON 也不是加密，而是 Torappu 的
自定义序列化格式。所以「读不到」不是权限问题，缺的是一个认这种格式的解析器。

格式（实测确认，数据版本 v079/rel79.0）
------------------------------------
  · 前 128 字节：固定头部，不参与数据
  · 128 字节起：	4 字节 = 表数量?, 之后是「偏移表」——一串 **递减** 的 u32，
    个数 = 记录数（本表 1403）。偏移 v 对应的记录区间是
        [ len(blob) - v_next , len(blob) - v )        （v 递减，所以 v_next > v）
    也就是「从文件末尾往前数」的偏移。
  · 每条记录是一串字段，值的编码是
        [ u32 长度 ][ payload ]     payload 若是可打印 UTF-8 就是字符串，否则按整数看
  · 干员记录的 **最后一个字符串字段是 charId**，它前面紧挨着
        [ u32 名字长度 ][ 名字 ][ 8 字节 0 对齐 ][ u32 charId 长度 ][ charId ]
    实测 Lancet-2 → （名字 8 字节）+ 8 个 0 + （15 字节）char_285_medic2

用法
----
  python3 read_character_table.py --game <Bundles> --out <json>
  python3 read_character_table.py --game <Bundles> --print
"""
import argparse
import json
import re
import sys
from pathlib import Path

# 数据表 bundle 的 TextAsset 名（哈希后缀会随更新变，所以只比对前缀）
KNOWN_TABLES = ('character_table', 'uniequip_table', 'skill_table',
                'battle_equip_table', 'range_table', 'enemy_handbook_table')


def find_table(bundles_root, prefix='character_table'):
    """在 anon/ 里找一个「单 TextAsset、名字以 prefix 开头」的 bundle。

    返回 (bundle 路径, TextAsset 名, 原始字节) 或 None。
    """
    import aklz4  # noqa: F401  注册 LZ4AK 解压器
    import UnityPy

    anon = Path(bundles_root) / 'anon'
    if not anon.is_dir():
        return None
    for p in sorted(anon.glob('*.bin')):
        try:
            env = UnityPy.load(str(p))
        except Exception:
            continue
        tas = [o for o in env.objects if o.type.name == 'TextAsset']
        if len(tas) != 1:
            continue
        try:
            d = tas[0].read()
        except Exception:
            continue
        name = getattr(d, 'm_Name', '') or ''
        if not name.lower().startswith(prefix.lower()):
            continue
        raw = d.m_Script
        blob = raw.encode('utf-8', 'surrogateescape') if isinstance(raw, str) else bytes(raw)
        return p, name, blob
    return None


def read_offsets(blob):
    """读出记录偏移表。返回 (offsets, 数据区起始位置)；offsets 已按记录顺序排列。"""
    n = len(blob)
    # 128 字节头部之后：4 字节（推测是表数量，本表为 4）+ 偏移表
    i = 132
    raw = []
    while i + 4 <= n:
        v = int.from_bytes(blob[i:i + 4], 'little')
        if v == 0 or v > n:
            break
        raw.append(v)
        i += 4
    # 偏移表是递减的；按记录顺序（第一条 → 最后一条）就是升序
    return sorted(raw), i


def decode_fields(segment):
    """把一段记录拆成 (kind, value) 序列，kind 是 'S'（字符串）或 'I'（整数）。"""
    out = []
    pos, L = 0, len(segment)
    while pos + 4 <= L:
        ln = int.from_bytes(segment[pos:pos + 4], 'little')
        if 0 < ln <= 300 and pos + 4 + ln <= L:
            chunk = segment[pos + 4:pos + 4 + ln]
            try:
                txt = chunk.decode('utf-8')
            except UnicodeDecodeError:
                txt = None
            # 可打印才算字符串；否则这 4 字节只是某个整数的高位，按整数走
            if txt is not None and all(ord(c) >= 32 or c in '\n\t' for c in txt):
                out.append(('S', txt))
                pos += 4 + ln
                continue
        out.append(('I', int.from_bytes(segment[pos:pos + 4], 'little')))
        pos += 4
    return out


def name_of_record(segment):
    """从一条记录里取「名字 + charId」。

    规则：charId 是本记录里 **最后一个** 以 char_ 开头的字符串；
    名字是紧挨在它前面的那个字符串（中间隔着 8 个 0 的对其，不影响）。
    """
    fields = decode_fields(segment)
    strings = [v for k, v in fields if k == 'S']
    cid = None
    for s in reversed(strings):
        if re.fullmatch(r'char_[0-9]{3,4}_[a-z0-9_]+', s):
            cid = s
            break
    if not cid:
        return None, None
    idx = strings.index(cid)
    name = None
    for s in reversed(strings[:idx]):
        if not s.startswith('char_') and len(s) <= 32:
            name = s
            break
    return name, cid


def parse_operators(blob, log=print):
    """→ {charId: {'charId', 'name', 'raw'}}"""
    n = len(blob)
    offs, data_start = read_offsets(blob)
    if not offs:
        log('偏移表为空，可能不是 character_table')
        return {}
    log(f'偏移表 {len(offs)} 条，数据区起于 {data_start}')

    ops = {}
    # 偏移 v 指向的区间：[ n - v_next , n - v )；最后一条的上界是 n - 0 = n
    bounds = offs + [0]
    for k in range(len(offs)):
        # bounds 升序，第 k 条记录 = [ n - bounds[k+1], n - bounds[k] )
        hi = n - bounds[k + 1] if k + 1 < len(bounds) else data_start
        lo = n - bounds[k]
        if k == len(offs) - 1:
            hi = n - 0 if False else hi
        if hi >= lo:
            hi = max(data_start, lo - 1)
        if hi >= lo:
            continue
        seg = blob[hi:lo]
        if len(seg) < 16:
            continue
        name, cid = name_of_record(seg)
        if not cid:
            continue
        if cid in ops:
            continue          # 同一干员的重复条目（皮肤/形态），保留第一条
        ops[cid] = {'charId': cid, 'name': name}
    return ops


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--game', required=True, help='Bundles 根目录')
    ap.add_argument('--out', default='', help='输出 json')
    ap.add_argument('--print', action='store_true', help='打印前若干条')
    ap.add_argument('--table', default='character_table', help='表名前缀，默认 character_table')
    args = ap.parse_args()

    found = find_table(args.game, args.table)
    if not found:
        print(f'没找到 {args.table}：anon/ 里没有「单 TextAsset 且名以 {args.table} 开头」的 bundle',
              file=sys.stderr)
        return 2
    path, name, blob = found
    print(f'找到 {name}（{path.name}，{len(blob)} 字节）')

    ops = parse_operators(blob)
    print(f'解析出 {len(ops)} 位干员')
    if args.print:
        for cid, rec in list(ops.items())[:20]:
            print(f'  {cid:28s} {rec["name"]}')

    if args.out:
        doc = {'version': 1, 'source': 'local-client', 'table': name,
               'count': len(ops), 'operators': ops}
        Path(args.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')),
                                  encoding='utf-8')
        print(f'已写出 {args.out}')
    return 0 if ops else 1


if __name__ == '__main__':
    sys.exit(main())
