#!/usr/bin/env python3
"""批量从 chararts/*.ab 导出干员半身立绘（portrait）。

官方列表页的竖版卡片用的是「半身像」：头到腰，正方形画布。包里的命名规律：
  <charId>_1b  1024² 精一半身
  <charId>_2b  1024² 精二半身
很多低星干员没有 _1b/_2b，只有 _1/_2 全身图 —— 这时按 alpha bbox 裁上部 62%
当半身用（头 + 上半身），构图与官方的卡片差不多。

只处理 data/assets.json 里 portrait 路径本地不存在的干员。
输出：<out>/<charId>_1.webp 与 <out>/<charId>_2.webp（同图，前端登记的是两个字段）
"""
import json
import os
import sys

sys.path.insert(0, '/data/local/tmp/arkx/extract')
sys.path.insert(0, '/storage/emulated/0/ark/.tools')

import aklz4  # noqa: F401,E402
import UnityPy  # noqa: E402
import skin_extract as SE  # noqa: E402
from PIL import Image  # noqa: E402

BUNDLES = '/storage/emulated/0/Android/data/com.hypergryph.arknights/files/Bundles/chararts'
WEB = '/storage/emulated/0/ark/webbuild'
OUT = sys.argv[1] if len(sys.argv) > 1 else '/data/local/tmp/arkportrait'
ONLY = set(sys.argv[2].split(',')) if len(sys.argv) > 2 and sys.argv[2] else None
SIZE = 640
QUALITY = 82


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


def decode(tex, res, stem):
    lst = tex.get(stem)
    if not lst:
        return None
    t = max(lst, key=lambda x: int(x.m_Width) * int(x.m_Height))
    try:
        img = SE.decode_texture(t, res)
    except Exception:
        return None
    if img is None:
        return None
    a = tex.get(stem + '[alpha]')
    if a:
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
    return img.convert('RGBA') if img.mode != 'RGBA' else img


def mask_bbox(img, thresh=24):
    return img.getchannel('A').point(lambda v: 255 if v > thresh else 0).getbbox()


def bust(img):
    """裁成半身方形：先去掉透明边，再从顶部往下取一块正方形。"""
    box = mask_bbox(img)
    if box:
        l, t, r, b = box
        if r - l >= 8 and b - t >= 8:
            img = img.crop(box)
    w, h = img.size
    # 半身：高度取宽度的 1.0~1.15 倍，从顶部开始，水平居中到人物。
    a = img.getchannel('A')
    band = a.crop((0, 0, w, max(8, int(h * 0.25))))
    tb = band.getbbox()
    cx = (tb[0] + tb[2]) / 2.0 if tb else w / 2.0
    side = int(min(w, max(w * 0.62, h * 0.5)))
    left = int(round(cx - side / 2.0))
    left = max(0, min(w - side, left))
    return img.crop((left, 0, left + side, min(h, side)))


def main():
    os.makedirs(OUT, exist_ok=True)
    reg = json.load(open(os.path.join(WEB, 'data/assets.json'), encoding='utf-8'))['chars']
    todo = []
    for cid, rec in reg.items():
        p = (rec.get('portrait') or '').lstrip('/')
        if p and os.path.isfile(os.path.join(WEB, 'public', p)):
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
            img = None
            for stem in (cid + '_1b', cid + '_2b', cid + '_1', cid + '_2', cid):
                img = decode(tex, res, stem)
                if img is not None:
                    break
            if img is None:
                print('  [miss] %s' % cid)
                fail += 1
                continue
            out = bust(img)
            if out.size[0] != SIZE:
                out = out.resize((SIZE, SIZE), Image.LANCZOS)
            out.save(os.path.join(OUT, cid + '_1.webp'), 'WEBP', quality=QUALITY, method=2)
            out.save(os.path.join(OUT, cid + '_2.webp'), 'WEBP', quality=QUALITY, method=2)
            ok += 1
            if i % 25 == 0:
                print('  [%d/%d] %s' % (i + 1, len(todo), cid))
        except Exception as e:
            print('  [err] %s: %r' % (cid, e))
            fail += 1
    print('完成 ok=%d fail=%d -> %s' % (ok, fail, OUT))


main()
