#!/usr/bin/env python3
"""从本机的《明日方舟》客户端批量提取干员的 2D 战斗小人（Spine 骨骼）。

和 extract.py 的关系：extract.py 用手写的 JOBS 表去取「卫戍协议」用到的少量素材；
小人不一样 —— 每个干员一个 bundle（skinpack/char_XXX.ab），几百个文件，逐个写在表里不现实。
所以单独一个脚本，把 skinpack/ 整个目录扫一遍，能解的都解出来。

用法：
  python3 extract_operators.py --game <AB root> --out <dir> [--only char_002_amiya,...] [--jobs N]

产物（每个干员一个子目录）：
  <out>/<charId>/<skinName>.skel
  <out>/<charId>/<skinName>.atlas
  <out>/<charId>/<page>.png
  <out>/operators-index.json   ← 干员 → 皮肤 → 文件清单，网页据此做皮肤切换

为什么要分开写：skinpack 目录一共 434 个 bundle，按干员名命名，每个里有 3～10 套皮肤
（默认皮肤 + 各种 epoque/winter/test 皮肤），JOBS 表那种「一条一条列」的方式无法表达。
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# skinpack 里能提取的干员 bundle 名：char_<编号>_<代号>.ab
CHAR_BUNDLE = re.compile(r'^(char_[0-9]+_[a-z0-9]+)\.ab$')
# Spine 3.x 的 .skel 以这些字节开头（二进制 skeleton）；.atlas 是纯文本、以换行加 png 名开头
SKEL_MAGIC = (b'\x1c',)


def safe_name(name):
    """文件名里只留安全字符（和 extract.py 的规则一致）。"""
    return re.sub(r'[^A-Za-z0-9_.-]', '_', name)[:120] or 'unnamed'


def is_atlas(blob):
    head = blob[:200]
    return head[:1] in (b'\n',) and b'size:' in head


def is_skel(blob):
    return blob[:1] in SKEL_MAGIC


def extract_one(ab_root, bundle, out_root, index, log):
    """解一个干员 bundle：把每套皮肤的 .skel/.atlas 与贴图写到 <out>/<charId>/。"""
    import aklz4  # noqa: F401  (registers the LZ4AK decoder)
    import UnityPy

    m = CHAR_BUNDLE.match(bundle.name)
    if not m:
        return 0
    char_id = m.group(1)
    src = ab_root / 'skinpack' / bundle.name
    if not src.is_file():
        return 0

    try:
        env = UnityPy.load(str(src))
    except Exception as e:
        log(f'FAIL load {bundle.name}: {e}')
        return 0

    out_dir = out_root / char_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # 贴图先收集起来：atlas 里写的页名就是这些 Texture2D 的 m_Name
    textures = {}
    for obj in env.objects:
        if obj.type.name != 'Texture2D':
            continue
        try:
            data = obj.read()
            name = getattr(data, 'm_Name', '') or f'tex_{obj.path_id}'
            img = data.image
            if img is None or img.width < 2 or img.height < 2:
                continue
            textures[name] = img
        except Exception as e:
            log(f'  warn {bundle.name} tex #{obj.path_id}: {e}')

    # TextAsset：.skel 与 .atlas 都是（名字里已经带扩展名）
    skins = {}
    n = 0
    for obj in env.objects:
        if obj.type.name != 'TextAsset':
            continue
        try:
            data = obj.read()
            name = getattr(data, 'm_Name', '') or f'ta_{obj.path_id}'
            raw = data.m_Script
            blob = raw.encode('utf-8', 'surrogateescape') if isinstance(raw, str) else bytes(raw)
            lower = name.lower()
            if lower.endswith('.atlas'):
                stem, kind = name[:-6], 'atlas'
            elif lower.endswith('.skel'):
                stem, kind = name[:-5], 'skel'
            elif is_atlas(blob):
                stem, kind = name, 'atlas'
            elif is_skel(blob):
                stem, kind = name, 'skel'
            else:
                continue
            # Spine 的导出名常带 "#<数字>" 后缀（同一 bundle 里同名资源的去重），去掉它
            stem = re.sub(r'#\d+$', '', stem)
            # 带 build_ 前缀的是构建期产物，游戏里不直接用它 —— 但留着也无害
            fname = safe_name(stem) + ('.atlas' if kind == 'atlas' else '.skel')
            (out_dir / fname).write_bytes(blob)
            skins.setdefault(stem, {})[kind] = fname
            n += 1
        except Exception as e:
            log(f'  warn {bundle.name} ta #{obj.path_id}: {e}')

    # atlas 里列的页 → 写出对应的 png
    for stem, files in skins.items():
        atlas_file = files.get('atlas')
        if not atlas_file:
            continue
        try:
            text = (out_dir / atlas_file).read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        pages = []
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('size:') or ':' in line and not line.endswith('.png'):
                continue
            if line.endswith('.png'):
                pages.append(line)
        for page in pages:
            key = page[:-4]
            img = textures.get(key) or textures.get(page)
            if img is None:
                continue
            out_png = out_dir / safe_name(page)
            try:
                if not out_png.is_file():
                    img.save(out_png)
                    n += 1
            except Exception as e:
                log(f'  warn {bundle.name} save {page}: {e}')
            files.setdefault('pages', []).append(safe_name(page))

    if skins:
        index[char_id] = {
            'charId': char_id,
            'bundle': f'skinpack/{bundle.name}',
            'skins': {stem: {'skel': v.get('skel'), 'atlas': v.get('atlas'), 'pages': v.get('pages', [])}
                      for stem, v in sorted(skins.items())},
            # 默认皮肤就是不带皮肤后缀的那套（char_002_amiya 本身）
            'defaultSkin': char_id if char_id in skins else next(iter(sorted(skins)), None),
        }
        rel = out_dir.relative_to(out_root).as_posix()
        index[char_id]['dir'] = rel
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--game', required=True, help='AssetBundle root (…/files/Bundles)')
    ap.add_argument('--out', required=True, help='output directory, e.g. public/assets/local/operators')
    ap.add_argument('--only', default='', help='comma separated charIds to limit to (empty = all)')
    ap.add_argument('--jobs', type=int, default=1, help='worker processes (1 = in-process)')
    args = ap.parse_args()

    ab_root = Path(args.game)
    skin_dir = ab_root / 'skinpack'
    if not skin_dir.is_dir():
        print(f'no skinpack under {ab_root}', file=sys.stderr)
        return 2

    wanted = {s.strip() for s in args.only.split(',') if s.strip()}
    bundles = sorted(p for p in skin_dir.glob('char_*.ab')
                     if not wanted or CHAR_BUNDLE.match(p.name) and CHAR_BUNDLE.match(p.name).group(1) in wanted)
    print(f'{len(bundles)} operator bundles under {skin_dir}')

    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    index = {}
    total = 0
    for i, bundle in enumerate(bundles, 1):
        n = extract_one(ab_root, bundle, out_root, index, print)
        total += n
        if n:
            print(f'[{i}/{len(bundles)}] {bundle.name}: {n} files')
        else:
            print(f'[{i}/{len(bundles)}] {bundle.name}: skipped')

    (out_root / 'operators-index.json').write_text(
        json.dumps({'version': 1, 'count': len(index), 'operators': index},
                   ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8')
    print(f'done: {total} files, {len(index)} operators -> {out_root}')
    return 0 if total else 1


if __name__ == '__main__':
    sys.exit(main())
