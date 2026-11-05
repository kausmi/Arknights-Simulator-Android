#!/usr/bin/env python3
"""批量从 chararts/*.ab 裁出干员头像（128x128 PNG）。

只处理 data/assets.json 里登记了头像路径、但本地文件不存在的那批干员。
源图优先精一全身 `_1`，没有就 `_2` / `_1b` / `_2b`；先按 alpha bbox 去空白，
再按「宽度为边、顶部对齐、水平居中」裁出头肩方形，缩到 128。

输出：<out>/<charId>.png 与 <out>/<charId>_2.png（同图，前端登记的是两个字段）
"""
import json
import os
import sys

sys.path.insert(0, '/data/local/tmp/arkx/extract')
sys.path.insert(0, '/storage/emulated/0/ark/.tools')

import aklz4  # noqa: F401,E402  —— 注册 LZ4AK 解压器
import UnityPy  # noqa: E402
import skin_extract as SE  # noqa: E402
from PIL import Image  # noqa: E402

BUNDLES = '/storage/emulated/0/Android/data/com.hypergryph.arknights/files/Bundles/chararts'
WEB = '/storage/emulated/0/ark/webbuild'
OUT = sys.argv[1] if len(sys.argv) > 1 else '/data/local/tmp/arkavatar'
ONLY = set(sys.argv[2].split(',')) if len(sys.argv) > 2 and sys.argv[2] else None
SIZE = 128


def load(cid):
    env = UnityPy.load(os.path.join(BUNDLES, cid + '.ab'))
    res = SE.resource_stream(env)
    tex = {}
    for obj in env.objects:
        if obj.type.name != 'Texture2D':
            continue
        try:
            t = obj.read()
        except Exception:
            continue
        tex.setdefault(getattr(t, 'm_Name', ''), []).append(t)
    return tex, res


def pick(tex, res, cid):
    for stem in (cid + '_1', cid + '_2', cid + '_1b', cid + '_2b', cid):
        lst = tex.get(stem)
        if not lst:
            continue
        t = max(lst, key=lambda x: int(x.m_Width) * int(x.m_Height))
        try:
            img = SE.decode_texture(t, res)
        except Exception:
            img = None
        if img is None:
            continue
        a = tex.get(stem + '[alpha]')
        if a:
            ai = None
            try:
                ai = SE.decode_texture(max(a, key=lambda x: int(x.m_Width) * int(x.m_Height)), res)
            except Exception:
                ai = None
            if ai is not None:
                if ai.size != img.size:
                    ai = ai.resize(img.size, Image.LANCZOS)
                base = img.convert('RGB')
                base.putalpha(ai.convert('L'))
                img = base
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        return stem, img
    return None, None


def _mask_bbox(img, thresh=24):
    """alpha > thresh 的包围盒。官方贴图放大 alpha 后边缘常有残留，
    直接 getbbox() 会得到整张图，必须卡阈值。"""
    a = img.getchannel('A').point(lambda v: 255 if v > thresh else 0)
    return a.getbbox()


def head(img):
    box = _mask_bbox(img)
    if box:
        l, t, r, b = box
        if r - l >= 8 and b - t >= 8:
            img = img.crop(box)
    w, h = img.size

    # 用「顶部一小段」里不透明像素的水平跨度定位头部，而不是整张图的中心线：
    # 全身立绘里人物常常偏左或偏右，按整图居中会裁到空气或隔壁。
    a = img.getchannel('A')
    band_h = max(8, int(h * 0.22))
    top = a.crop((0, 0, w, band_h))
    tb = top.getbbox()
    if tb:
        tl, tr = tb[0], tb[2]
        cx = (tl + tr) / 2.0
        head_w = max(16, tr - tl)
    else:
        cx = w / 2.0
        head_w = w * 0.5

    side = int(min(w, max(head_w * 1.55, h * 0.24), h * 0.55))
    left = int(round(cx - side / 2.0))
    left = max(0, min(w - side, left))
    top_y = max(0, (tb[1] if tb else 0) - int(side * 0.08))
    return img.crop((left, top_y, left + side, top_y + side))


def main():
    os.makedirs(OUT, exist_ok=True)
    reg = json.load(open(os.path.join(WEB, 'data/assets.json'), encoding='utf-8'))['chars']
    todo = []
    for cid, rec in reg.items():
        av = rec.get('avatar')
        rel = (av or '').lstrip('/')
        if av and os.path.isfile(os.path.join(WEB, 'public', rel)):
            continue
        if not os.path.isfile(os.path.join(BUNDLES, cid + '.ab')):
            continue
        if ONLY and cid not in ONLY:
            continue
        todo.append(cid)
    print('待处理 %d 个' % len(todo))
    ok = fail = 0
    for i, cid in enumerate(todo):
        try:
            tex, res = load(cid)
            stem, img = pick(tex, res, cid)
            if img is None:
                print('  [miss] %s' % cid)
                fail += 1
                continue
            av = head(img).resize((SIZE, SIZE), Image.LANCZOS)
            av.save(os.path.join(OUT, cid + '.png'), 'PNG', optimize=True)
            av.save(os.path.join(OUT, cid + '_2.png'), 'PNG', optimize=True)
            ok += 1
            if i % 20 == 0:
                print('  [%d/%d] %s <- %s %s' % (i + 1, len(todo), cid, stem, img.size))
        except Exception as e:
            print('  [err] %s: %r' % (cid, e))
            fail += 1
    print('完成 ok=%d fail=%d -> %s' % (ok, fail, OUT))


main()
