#!/usr/bin/env python3
"""把 generated-illustrations.js 里登记的干员立绘，从本机 chararts/*.ab 重新解出来。

为什么要这个脚本：早先那批立绘是用 UnityPy 的 tex.image 出的，
在安卓包（ASTC / ETC2 + resS 流）上它会抛 ValueError 或给出长度 0 的图，
于是界面上出现「颜色不对 / 整块色块 / 头朝下」。这里统一走
resS 切片 + texture2ddecoder 解码，并补上 Unity 需要的 FLIP_TOP_BOTTOM。

用法：
  python3 .tools/illust_extract.py <Bundles 根> <web 根> [--only char_a,char_b] [--limit N]
输出：<web>/public/assets/char/illust/<贴图名>.webp，并把 generated-illustrations.js
      里对应的 .png 地址改成 .webp。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image  # noqa: E402

import skin_extract as SE  # noqa: E402  （复用它的 resS 取流 + 解码 + FLIP）

MAX_EDGE = 1024
QUALITY = 88


def load_registry(js_path):
    text = open(js_path, encoding='utf-8').read()
    m = re.search(r'Object\.freeze\((\{.*\})\)\s*;?\s*$', text, re.S)
    if not m:
        raise SystemExit('解析不到 generated-illustrations.js 的数据体')
    return json.loads(m.group(1))


def merge_alpha(img, alpha_img):
    """方舟的 ETC1 贴图（fmt 34）不带 alpha，透明度存在同名的 `<贴图名>[alpha]`
    灰度图里。不合并的话透明区会变成一整块不透明的白/黑方块 —— 就是界面上那种
    「诡异色块」。这里把 alpha 图的灰度当透明度贴回去。"""
    if alpha_img.size != img.size:
        alpha_img = alpha_img.resize(img.size, Image.LANCZOS)
    out = img.convert('RGB')
    out.putalpha(alpha_img.convert('L'))
    return out


def shrink(img):
    w, h = img.size
    long_edge = max(w, h)
    if long_edge <= MAX_EDGE:
        return img
    k = MAX_EDGE / float(long_edge)
    return img.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)


def main(argv):
    args = [a for a in argv[1:] if not a.startswith('--')]
    opts = [a for a in argv[1:] if a.startswith('--')]
    if len(args) < 2:
        print(__doc__)
        return 1
    bundles_root, web_root = args[0], args[1]
    only = set()
    limit = 0
    for o in opts:
        if o.startswith('--only='):
            only = {x.strip() for x in o.split('=', 1)[1].split(',') if x.strip()}
        elif o.startswith('--limit='):
            limit = int(o.split('=', 1)[1])

    js_path = os.path.join(web_root, 'public', 'sandbox', 'js', 'generated-illustrations.js')
    out_root = os.path.join(web_root, 'public', 'assets', 'char', 'illust')
    os.makedirs(out_root, exist_ok=True)
    reg = load_registry(js_path)

    done = fail = 0
    e2 = '--e2' in opts
    for char_id, spec in reg.items():
        if only and char_id not in only:
            continue
        if limit and done >= limit:
            break
        url = spec.get('url') or ''
        name = os.path.basename(url)
        stem = os.path.splitext(name)[0]
        ab = os.path.join(bundles_root, 'chararts', char_id + '.ab')
        dest = os.path.join(out_root, stem + '.webp')
        if not os.path.exists(ab):
            print('  [skip] %s: 没有 %s.ab' % (char_id, char_id))
            fail += 1
            continue
        try:
            import UnityPy
            env = UnityPy.load(ab)
            res = SE.resource_stream(env)
            tex_map = {}
            for obj in env.objects:
                if obj.type.name != 'Texture2D':
                    continue
                tex = obj.read()
                tex_map[getattr(tex, 'm_Name', '')] = tex
            # 默认用精一立绘（用户要求）：登记表里写的是 _2（精二），
            # 但包里同时有 _1，先试 _1，没有再退回 _2。
            use_stem = stem
            if not e2 and stem.endswith('_2'):
                cand = stem[:-2] + '_1'
                if tex_map.get(cand) is not None:
                    use_stem = cand
            tex = tex_map.get(use_stem)
            if tex is None:
                tex = tex_map.get(stem)
                use_stem = stem
            if tex is None:
                print('  [miss] %s: 包里没有贴图 %s' % (char_id, stem))
                fail += 1
                continue
            img = SE.decode_texture(tex, res)
            if img is None:
                print('  [miss] %s: 贴图 %s 解不出来' % (char_id, stem))
                fail += 1
                continue
            atex = tex_map.get(use_stem + '[alpha]')
            if atex is not None:
                try:
                    aimg = SE.decode_texture(atex, res)
                    if aimg is not None:
                        img = merge_alpha(img, aimg)
                except Exception as e:
                    print('  [warn] %s: alpha 合并失败 %r' % (char_id, e))
            if img.mode != 'RGBA':
                img = img.convert('RGBA')
            img = shrink(img)
            img.save(dest, 'WEBP', quality=QUALITY, method=4)
            done += 1
            print('  [ok] %s -> %s (%dx%d)' % (char_id, os.path.basename(dest), img.size[0], img.size[1]))
        except Exception as e:
            print('  [err] %s: %r' % (char_id, e))
            fail += 1

    # 把登记表里的 .png 地址换成 .webp（前端不再拿到「扩展名是 png、内容是 webp」的文件）
    text = open(js_path, encoding='utf-8').read()
    text = re.sub(r'(/assets/char/illust/[^"\']+)\.png', r'\1.webp', text)
    open(js_path, 'w', encoding='utf-8').write(text)

    print('done: %d 立绘，失败 %d，输出 %s' % (done, fail, out_root))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
