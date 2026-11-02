#!/usr/bin/env python3
"""从本机《明日方舟》的 chararts/ 解出干员头像与立绘，直接落到网页认的路径上。

为什么要这个脚本
----------------
网页里 `data/assets.json` 给每个干员登记了五个图：头像(avatar/avatarE2)、半身立绘
(portrait/portraitE2)、全身立绘(illust)，路径形如

    /assets/char/avatar/char_003_kalts.png
    /assets/char/avatar/char_003_kalts_2.png
    /assets/char/portrait/char_003_kalts_1.png
    /assets/char/portrait/char_003_kalts_2.png
    /assets/char/illust/char_003_kalts_2.png

官方客户端把每个干员的全部美术资源打成一个 bundle：
    Bundles/chararts/<charId>.ab
里面的 Texture2D 命名规律（实测 char_003_kalts / char_1001_amiya2 一致）：

    <charId>        512×512   图集碎片（一堆头/衣服小图拼在一张），**不能直接当头像**
    <charId>_1      2048×2048 精一全身立绘（四周透明）
    <charId>_1b     1024×1024 精一半身立绘
    <charId>_2      2560×2560 精二全身立绘
    <charId>_2b     1024×1024 精二半身立绘
    build_<charId>  416×416   构建期小图（不用于界面）

所以映射关系是：
    portrait  (精一) ← _1
    portraitE2(精二) ← _2b
    illust    (精二) ← _2
    avatar / avatarE2 ← 从 _1b / _2b 裁上半身方形再缩到 256（本机没有官方 180×180 方头像）

产物直接写进网页目录，前端一行代码都不用改（路径本来就登记好了）。

用法
----
  python3 extract_operator_art.py --game <Bundles 根> --web <web 根目录> [--only char_003_kalts,...] [--limit N]

  --web 就是 APK 解出来的 web 目录；最终写 <web>/public/assets/char/{avatar,portrait,illust}/
"""
import argparse
import re
import sys
from pathlib import Path

# chararts/ 里文件名就是 charId
CHAR_BUNDLE = re.compile(r'^(char_[0-9]+_[a-z0-9]+)\.ab$')

# 各类图的目标长边（px）与 WebP 质量。立绘本身体积很大（2560² PNG 三兆多一张），
# 手机上按实际显示尺寸裁一刀，省空间又不糊。
SIZES = {
    'avatar':    (256, 76),
    'portrait1': (768, 74),
    'portrait2': (768, 72),
    'illust':    (1024, 70),
}


def safe_name(name):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', name)[:120] or 'unnamed'


def trim_alpha(img):
    """按 alpha 通道求不透明区域的包围盒并裁掉四周空白。

    方舟的立绘贴图都是正方形（1024/2048/2560），但人像只占中间一条竖长条，
    四周全是透明。直接按最短边裁头像会裁出一大堆空气。
    """
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    try:
        box = img.getchannel('A').getbbox()
    except Exception:
        box = None
    if not box:
        return img
    # 往里收一点，避开边缘的半透明描边
    l, t, r, b = box
    if r - l < 8 or b - t < 8:
        return img
    return img.crop((l, t, r, b))


def fit(img, long_edge, quality, dest):
    """等比缩到长边 long_edge 以内并存成 WebP（原图本来就比它小就直接用原尺寸）。"""
    from PIL import Image

    w, h = img.size
    scale = long_edge / float(max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                         Image.LANCZOS)
    if img.mode not in ('RGB', 'RGBA'):
        img = img.convert('RGBA')
    dest.parent.mkdir(parents=True, exist_ok=True)
    # 文件扩展名仍然用 .png（data/assets.json 登记的就是 .png，前端不该为一件事改两处），
    # 但内容存 WebP：真 PNG 一张 1200² 就要 800KB，467 个干员乘以四张图能到 1.3GB。
    # 因此 HttpService 发文件时会读文件头，认出 RIFF....WEBP 就发 image/webp。
    # method=0（最快）而不是 4：手机上 375 个干员 × 5 张要压，method=4 的编码时间
    # 是 method=0 的三四倍，而体积差不到 8% —— 提取是用户坐等的那几分钟，省时间更要紧。
    img.save(dest, 'WEBP', quality=quality, method=0)
    return dest


def head_square(img):
    """从（已去空白的）立绘里裁「头部」方形当头像。

    人像高度约等于身高，头大约占顶部 1/4～1/5。取宽度为边、从顶部往下量，
    左右以人物中心线对齐 —— 比「取最短边居中」靠谱得多。
    """
    w, h = img.size
    side = min(w, max(1, int(h * 0.42)))   # 头+肩，别把整条腿收入
    left = max(0, (w - side) // 2)
    box = (left, 0, left + side, side)
    return img.crop(box)


def pick(textures, char_id):
    """按命名规律从一批 Texture2D 里挑出需要的那几张。"""
    keys = {
        'p1': f'{char_id}_1',
        'p1b': f'{char_id}_1b',
        'p2': f'{char_id}_2',
        'p2b': f'{char_id}_2b',
    }
    return {k: textures.get(v) for k, v in keys.items()}


def extract_one(ab_root, char_id, web_root, log=print):
    """解一个干员，返回 (写出的文件数, 说明)。"""
    import aklz4  # noqa: F401  —— 注册 LZ4AK 解压器，否则 UnityPy 读方舟的包会抛 LZHAM
    import UnityPy

    src = Path(ab_root) / 'chararts' / f'{char_id}.ab'
    if not src.is_file():
        return 0, 'missing bundle'

    try:
        env = UnityPy.load(str(src))
    except Exception as e:
        return 0, f'load failed: {e}'

    textures = {}
    for obj in env.objects:
        if obj.type.name != 'Texture2D':
            continue
        try:
            d = obj.read()
            name = getattr(d, 'm_Name', '') or ''
            if not name or '[alpha]' in name or name.startswith('build_'):
                continue
            img = d.image
            if img is None or img.width < 8 or img.height < 8:
                continue
            textures[name] = img
        except Exception:
            continue

    got = pick(textures, char_id)
    if not any(got.values()):
        return 0, 'no usable texture'

    # 立绘贴图都是大方块，人像只占中间一条 —— 先按 alpha 去空白，后面裁头像才准
    for k in list(got):
        if got[k] is not None:
            try:
                got[k] = trim_alpha(got[k])
            except Exception:
                pass

    art = Path(web_root) / 'public' / 'assets' / 'char'
    n = 0

    # 精一半身立绘：portrait/<id>_1
    src1 = got['p1b'] or got['p1']
    if src1 is not None:
        fit(src1, *SIZES['portrait1'], art / 'portrait' / f'{char_id}_1.png')
        n += 1
        # 头像：从半身图裁上半
        try:
            fit(head_square(src1), *SIZES['avatar'], art / 'avatar' / f'{char_id}.png')
            n += 1
        except Exception:
            pass

    # 精二：portrait/<id>_2 与 illust/<id>_2
    src2b = got['p2b']
    src2 = got['p2']
    if src2b is not None:
        fit(src2b, *SIZES['portrait2'], art / 'portrait' / f'{char_id}_2.png')
        n += 1
        # 精二头像：精二立绘的构图通常是「特效在上、人在中下」，从顶部裁会裁到特效，
        # 所以精二头像直接复用精一那张 —— 玩家认脸用，精一/精二差别只在服装。
        try:
            import shutil
            src_av = art / 'avatar' / f'{char_id}.png'
            if src_av.is_file():
                shutil.copyfile(src_av, art / 'avatar' / f'{char_id}_2.png')
                n += 1
        except Exception:
            pass
    elif src2 is not None:
        # 没有 _2b 就用全身图顶
        try:
            fit(src2, *SIZES['portrait2'], art / 'portrait' / f'{char_id}_2.png')
            n += 1
            fit(head_square(src2), *SIZES['avatar'], art / 'avatar' / f'{char_id}_2.png')
            n += 1
        except Exception:
            pass

    if src2 is not None:
        try:
            fit(src2, *SIZES['illust'], art / 'illust' / f'{char_id}_2.png')
            n += 1
        except Exception:
            pass

    return n, 'ok' if n else 'nothing written'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--game', required=True, help='Bundles 根目录')
    ap.add_argument('--web', required=True, help='web 根目录（里面有 public/）')
    ap.add_argument('--only', default='', help='逗号分隔的 charId，只解这些')
    ap.add_argument('--limit', type=int, default=0, help='最多解几个（调试用，0=全部）')
    args = ap.parse_args()

    chars_dir = Path(args.game) / 'chararts'
    if not chars_dir.is_dir():
        print(f'chararts/ 不存在：{chars_dir}', file=sys.stderr)
        return 2

    wanted = {s.strip() for s in args.only.split(',') if s.strip()}
    bundles = []
    for p in sorted(chars_dir.glob('char_*.ab')):
        m = CHAR_BUNDLE.match(p.name)
        if not m:
            continue
        cid = m.group(1)
        if wanted and cid not in wanted:
            continue
        bundles.append(cid)

    if args.limit > 0:
        bundles = bundles[:args.limit]

    print(f'chararts：{len(bundles)} 个干员待解 -> {Path(args.web) / "public" / "assets" / "char"}')

    total = 0
    done = 0
    failed = 0
    for i, cid in enumerate(bundles, 1):
        try:
            n, why = extract_one(args.game, cid, args.web, print)
        except Exception as e:
            n, why = 0, f'exception: {e}'
        total += n
        if n:
            done += 1
        else:
            failed += 1
        if i % 25 == 0 or i == len(bundles):
            print(f'[{i}/{len(bundles)}] {cid}: {n} files ({why}) — 累计 {total} 文件 / {done} 干员')

    print(f'done: {total} 个文件，{done} 个干员解出，{failed} 个跳过')
    return 0 if total else 1


if __name__ == '__main__':
    sys.exit(main())
