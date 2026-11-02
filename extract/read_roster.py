#!/usr/bin/env python3
"""读出「本机《明日方舟》当前版本有哪些干员」，并顺手把每个干员的 2D 小人索引出来。

为什么不用 character_table 硬解
------------------------------
官方数据表（Bundles/anon/<hash>.bin 里的 character_table）是 Torappu 的自定义序列化格式，
能读到字节（10193 个中文字符串、98% 的干员名都在），但把「哪条记录属于哪个干员」对上号
需要完整实现它的类型描述，成本远大于收益。

更稳的办法：**客户端把每个干员的 2D 小人单独打成一个 bundle，文件名就是 charId**：
    Bundles/skinpack/char_002_amiya.ab
所以扫这个目录就拿到了「当前版本全部干员 id」——游戏更新后新干员会自动出现，
不需要解析任何数据表。名字则从 character_table 的字符串池里按需匹配（取不到就显示 id）。

产物
----
  <out>/operators-index.json
    {
      "version": 1, "source": "local-client", "count": N,
      "operators": {
        "<charId>": {
          "charId", "bundle", "dir", "skins": [{"name","skel","atlas","pages":[..]},{"..."}],
          "defaultSkin"
        }
      }
    }

用法
----
  python3 read_roster.py --game <Bundles 根> --out <json 路径> [--skins <小人输出目录>]
  python3 read_roster.py --game <Bundles 根> --list          # 只打印有哪些干员
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

CHAR_BUNDLE = re.compile(r'^(char_[0-9]+_[a-z0-9]+)\.ab$')
# Spine 二进制骨骼的魔数（3.x 的 .skel 以 0x1c 开头）
SKEL_MAGIC = (b'\x1c',)


def safe_name(name):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', name)[:120] or 'unnamed'


def is_atlas(blob):
    head = blob[:200]
    return head[:1] == b'\n' and b'size:' in head


def is_skel(blob):
    return blob[:1] in SKEL_MAGIC


def list_roster(ab_root):
    """扫 skinpack/ 得到 (charId, bundle 路径) 列表。这是「当前版本有哪些干员」的真源。"""
    skin = Path(ab_root) / 'skinpack'
    if not skin.is_dir():
        return []
    out = []
    for p in sorted(skin.glob('char_*.ab')):
        m = CHAR_BUNDLE.match(p.name)
        if m:
            out.append((m.group(1), p))
    return out


def names_from_character_table(ab_root, log=print):
    """尽力从 character_table 里收一份「名字池」。

    只取「4 字节长度 + 全可打印 UTF-8」的串里、长得像干员名的那些（2～20 字，含中文或
    常见英文名形），再把它们当候选集返回。取不到也不影响主流程（列表仍按 charId 给全）。
    """
    import aklz4  # noqa: F401
    import UnityPy

    anon = Path(ab_root) / 'anon'
    if not anon.is_dir():
        return []
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
        if not (getattr(d, 'm_Name', '') or '').lower().startswith('character_table'):
            continue
        raw = d.m_Script
        blob = raw.encode('utf-8', 'surrogateescape') if isinstance(raw, str) else bytes(raw)
        out = []
        n, i = len(blob), 0
        while i + 4 <= n:
            ln = int.from_bytes(blob[i:i + 4], 'little')
            if 2 <= ln <= 20 and i + 4 + ln <= n:
                chunk = blob[i + 4:i + 4 + ln]
                try:
                    t = chunk.decode('utf-8')
                except UnicodeDecodeError:
                    t = None
                if t and all(ord(c) >= 32 for c in t) and not t.startswith('char_'):
                    if any('\u4e00' <= c <= '\u9fff' for c in t) or re.fullmatch(r'[A-Za-z][A-Za-z0-9 .\-]*', t):
                        out.append(t)
                        i += 4 + ln
                        continue
            i += 1
        log(f'名字池：从 {d.m_Name} 收到 {len(out)} 个候选')
        return out
    return []


def extract_skins(ab_root, char_id, bundle, out_dir, log):
    """解一个干员的小人：把每套皮肤的 .skel / .atlas / 贴图写进 <out>/<charId>/。"""
    import aklz4  # noqa: F401
    import UnityPy

    try:
        env = UnityPy.load(str(bundle))
    except Exception as e:
        log(f'  FAIL {bundle.name}: {e}')
        return {}

    out = out_dir / char_id
    out.mkdir(parents=True, exist_ok=True)

    textures = {}
    for obj in env.objects:
        if obj.type.name != 'Texture2D':
            continue
        try:
            d = obj.read()
            name = getattr(d, 'm_Name', '') or f'tex_{obj.path_id}'
            img = d.image
            if img is not None and img.width >= 2 and img.height >= 2:
                textures[name] = img
        except Exception:
            pass

    skins = {}
    for obj in env.objects:
        if obj.type.name != 'TextAsset':
            continue
        try:
            d = obj.read()
            name = getattr(d, 'm_Name', '') or f'ta_{obj.path_id}'
            raw = d.m_Script
            blob = raw.encode('utf-8', 'surrogateescape') if isinstance(raw, str) else bytes(raw)
            low = name.lower()
            if low.endswith('.atlas'):
                stem, kind = name[:-6], 'atlas'
            elif low.endswith('.skel'):
                stem, kind = name[:-5], 'skel'
            elif is_atlas(blob):
                stem, kind = name, 'atlas'
            elif is_skel(blob):
                stem, kind = name, 'skel'
            else:
                continue
            stem = re.sub(r'#\d+$', '', stem)
            fname = safe_name(stem) + ('.atlas' if kind == 'atlas' else '.skel')
            (out / fname).write_bytes(blob)
            skins.setdefault(stem, {})[kind] = fname
        except Exception:
            pass

    # atlas 里列的页 → 落盘对应的 png
    for stem, files in list(skins.items()):
        af = files.get('atlas')
        if not af:
            continue
        try:
            text = (out / af).read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        pages = []
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('size:') or ':' in line:
                continue
            if line.endswith('.png'):
                pages.append(line)
        for page in pages:
            img = textures.get(page[:-4]) or textures.get(page)
            if img is None:
                continue
            png = out / safe_name(page)
            try:
                if not png.is_file():
                    img.save(png)
            except Exception:
                continue
            files.setdefault('pages', []).append(safe_name(page))

    return skins


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--game', required=True, help='Bundles 根目录')
    ap.add_argument('--out', default='', help='输出 operators-index.json')
    ap.add_argument('--skins', default='', help='小人输出目录（给了才会真的解包贴图）')
    ap.add_argument('--list', action='store_true', help='只打印干员 id')
    ap.add_argument('--no-names', action='store_true', help='不去 character_table 找名字（更快）')
    args = ap.parse_args()

    roster = list_roster(args.game)
    if not roster:
        print('skinpack/ 里没有 char_*.ab —— 确认《明日方舟》已安装且资源已下载完', file=sys.stderr)
        return 2
    print(f'skinpack：{len(roster)} 个干员 bundle')

    if args.list:
        for cid, _ in roster:
            print(cid)
        return 0

    name_pool = [] if args.no_names else names_from_character_table(args.game)

    out_dir = Path(args.skins) if args.skins else None
    index = {}
    for i, (cid, bundle) in enumerate(roster, 1):
        rec = {'charId': cid, 'bundle': f'skinpack/{bundle.name}'}
        if out_dir is not None:
            skins = extract_skins(args.game, cid, bundle, out_dir, print)
            if skins:
                rec['dir'] = cid
                rec['skins'] = [
                    {'name': stem, 'skel': v.get('skel'), 'atlas': v.get('atlas'), 'pages': v.get('pages', [])}
                    for stem, v in sorted(skins.items())
                ]
                # 默认皮肤：名字与 charId 相同的那套（游戏里的基础立绘）
                rec['defaultSkin'] = cid if cid in skins else (rec['skins'][0]['name'] if rec['skins'] else None)
                print(f'PROGRESS {i}/{len(roster)} skinpack/{cid}.ab')
                sys.stdout.flush()
                print(f'[{i}/{len(roster)}] {cid}: {len(rec["skins"])} 套皮肤')
        index[cid] = rec

    if args.out:
        doc = {'version': 1, 'source': 'local-client', 'count': len(index),
               'namePoolSize': len(name_pool), 'operators': index}
        Path(args.out).write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')),
                                  encoding='utf-8')
        print(f'已写出 {args.out}（{len(index)} 个干员）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
