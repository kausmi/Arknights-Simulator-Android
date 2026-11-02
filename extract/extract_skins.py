# -*- coding: utf-8 -*-
"""从本机《明日方舟》的 skinpack 里提取干员皮肤立绘。

为什么要单独一步：干员的「精一 / 精二」立绘在 chararts 里，而**官方皮肤**（时装）
只存在于 skinpack 里。chess.json / assets.json 里没有皮肤索引，所以只能扫包。

命名规律（实测 char_003_kalts / char_002_amiya / char_1012_skadi2）：
  skinpack/<charId>.ab 里，每个皮肤是一组同名贴图：
    <charId>_<皮肤名>#<序号>            全身立绘（2048² / 2560² / 512² 都有）
    <charId>_<皮肤名>#<序号>b           半身（1024²）
    <charId>_<皮肤名>#<序号>_sp         竖版（少数皮肤有）
    <charId>_<皮肤名>#<序号>[alpha]     遮罩，跳过
  同一基名下会同时存在多种尺寸，取**最大**那张当立绘。
  DefaultSkin 的基名就是 `<charId>#<n>`，与 chararts 里的 `_1/_2` 重复，跳过。

输出：
  <web>/public/assets/skin/<charId>/<皮肤名>.png     （内容是 WebP，扩展名照旧）
  <web>/data/local-skins.json                        （索引，前端按它列下拉）

命令行：
  --game <Bundles 根>  --web <web 根>
  --only char_003_kalts,char_002_amiya   只解这几个
  --limit N                              只解前 N 个
  --index                                只统计不写图（快，用于先看有多少皮肤）
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

WANTED = {
    'avatar': (256, 76),
    'portrait': (768, 74),
    'illust': (1024, 70),
}

# 一张立绘最多占多少像素（含半身），超过就当异常跳过，避免 OOM
MAX_PIXELS = 32_000_000


def log(msg: str) -> None:
    print(msg, flush=True)


def progress(i: int, n: int, name: str) -> None:
    print(f'PROGRESS {i}/{n} {name}', flush=True)


def _load_unitypy():
    """UnityPy 只在真正要用时 import（--index 之外也要用，所以放这里统一）。"""
    import aklz4  # noqa: F401  注册方舟自研 LZ4AK，不 import 会报 LZHAM NotImplementedError
    import UnityPy
    return UnityPy


def scan_bundle(UnityPy, path: str):
    """扫一个 skinpack bundle。

    返回 {(基名, 是否半身): [(w, h, obj)]}。
    贴图名规则（实测 char_003_kalts）：`<charId>_<皮肤>#<序号>` 全身、
    `<charId>_<皮肤>#<序号>b` 半身、`...#<序号>_sp` 竖版、`...<[alpha]>` 遮罩。
    同一基名下会有多种尺寸（512 / 2048 / 2560），取最大那张。
    """
    env = UnityPy.load(path)
    groups: dict[tuple, list] = {}
    for obj in env.objects:
        if obj.type.name != 'Texture2D':
            continue
        try:
            d = obj.read()
        except Exception:
            continue
        name = getattr(d, 'm_Name', '') or ''
        if not name or '[alpha]' in name or name.endswith('_sp'):
            continue
        w = int(getattr(d, 'm_Width', 0) or 0)
        h = int(getattr(d, 'm_Height', 0) or 0)
        if w <= 0 or h <= 0 or w * h > MAX_PIXELS:
            continue
        base, is_half = split_half(name)
        groups.setdefault((base, is_half), []).append((w, h, obj))
    return groups


def split_half(name: str):
    """`char_003_kalts_boc#6b` -> ('char_003_kalts_boc', True)；`...#6` -> (..., False)。

    关键：半身标记 `b` 挂在**序号后面**（#6b），不是挂在皮肤名后面，
    所以必须先按 `#` 拆出序号段再判断，否则 6b 会被当成序号 6 丢掉。
    """
    if '#' not in name:
        return name, False
    head, tail = name.split('#', 1)
    return head, tail.endswith('b')


def clean_skin_name(base: str, char_id: str) -> str | None:
    """`char_003_kalts_boc#6` -> `boc`；DefaultSkin（`char_003_kalts#1`）返回 None。"""
    b = base
    if '#' in b:
        b = b.split('#', 1)[0]
    if not b.startswith(char_id):
        return None
    rest = b[len(char_id):]
    if rest.startswith('_'):
        rest = rest[1:]
    if not rest:
        return None                      # 默认皮肤，chararts 里已经有了
    return re.sub(r'[^0-9A-Za-z_\u4e00-\u9fff-]', '', rest) or None


def pick_biggest(entries):
    """同一 (基名, 是否半身) 下取像素最多的那张 —— 512 是缩略图，2560 才是立绘。"""
    return max(entries, key=lambda e: e[0] * e[1], default=None)


def tex_to_image(tex_obj):
    from PIL import Image
    d = tex_obj.read()
    try:
        img = d.image
    except Exception:
        return None
    if img is None:
        return None
    if img.mode not in ('RGBA', 'RGB'):
        img = img.convert('RGBA')
    return img


def trim_alpha(img):
    if img.mode != 'RGBA':
        return img
    box = img.getchannel('A').getbbox()
    if not box:
        return img
    w, h = img.size
    # 收缩到 1px 误差内也认为「没裁」，避免把满幅立绘裁掉一两像素导致反复解码
    if box == (0, 0, w, h):
        return img
    return img.crop(box)


def fit(img, long_edge: int, quality: int, dest: str) -> bool:
    w, h = img.size
    scale = min(1.0, long_edge / float(max(w, h) or 1))
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), 1)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        img.save(dest, 'WEBP', quality=quality, method=4)
    except Exception as e:
        log(f'  写图失败 {dest}: {e}')
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', required=True)
    ap.add_argument('--web', required=True)
    ap.add_argument('--only', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--index', action='store_true')
    args = ap.parse_args()

    skin_dir = os.path.join(args.game, 'skinpack')
    if not os.path.isdir(skin_dir):
        log(f'skinpack 目录不存在：{skin_dir}')
        return 1

    names = sorted(n for n in os.listdir(skin_dir) if n.startswith('char_') and n.endswith('.ab'))
    only = {s.strip() for s in args.only.split(',') if s.strip()}
    if only:
        names = [n for n in names if n[:-3] in only]
    if args.limit:
        names = names[:args.limit]
    total = len(names)
    log(f'skinpack：{total} 个干员 bundle')

    UnityPy = _load_unitypy()
    index: dict[str, list] = {}
    out_root = os.path.join(args.web, 'public', 'assets', 'skin')
    n_files = 0
    skipped = 0
    t0 = time.time()

    for i, fn in enumerate(names, 1):
        char_id = fn[:-3]
        progress(i, total, char_id)
        if args.index:
            continue
        try:
            groups = scan_bundle(UnityPy, os.path.join(skin_dir, fn))
        except Exception as e:
            log(f'  [skip] {char_id}: {e}')
            skipped += 1
            continue
        got = []
        by_base: dict[str, dict] = {}
        for (base, is_half), entries in groups.items():
            skin = clean_skin_name(base, char_id)
            if not skin:
                continue
            slot = by_base.setdefault(skin, {})
            best = pick_biggest(entries)
            if not best:
                continue
            key = 'half' if is_half else 'full'
            prev = slot.get(key)
            if prev is None or best[0] * best[1] > prev[0] * prev[1]:
                slot[key] = best
        for skin, slot in by_base.items():
            full = slot.get('full') or slot.get('half')   # 只有半身没有全身的，退回半身
            if not full:
                continue
            try:
                img = tex_to_image(full[2])
            except Exception as e:
                log(f'  [skip] {char_id}/{skin}: {e}')
                continue
            if img is None:
                continue
            img = trim_alpha(img)
            dest_full = os.path.join(out_root, char_id, f'{skin}.png')
            if fit(img, 1024, 70, dest_full):
                n_files += 1
            else:
                continue
            rec = {
                'id': skin,
                'name': skin,
                'art': f'/assets/skin/{char_id}/{skin}.png',
                'w': img.size[0],
                'h': img.size[1],
            }
            half = slot.get('half')
            if half:
                try:
                    himg = tex_to_image(half[2])
                    if himg is not None:
                        himg = trim_alpha(himg)
                        dest_half = os.path.join(out_root, char_id, f'{skin}_b.png')
                        if fit(himg, 640, 72, dest_half):
                            n_files += 1
                            rec['artB'] = f'/assets/skin/{char_id}/{skin}_b.png'
                except Exception:
                    pass
            got.append(rec)
        if got:
            index[char_id] = got
            log(f'  [{i}/{total}] {char_id}: {len(got)} 套皮肤（累计 {n_files} 文件）')

    if not args.index:
        tip = os.path.join(args.web, 'data', 'local-skins.json')
        os.makedirs(os.path.dirname(tip), exist_ok=True)
        # 与已有索引合并：--only 只解几个时不能把别的干员的记录冲掉
        old = {}
        if os.path.isfile(tip):
            try:
                with open(tip, 'r', encoding='utf-8') as f:
                    old = (json.load(f) or {}).get('chars') or {}
            except Exception:
                old = {}
        old.update(index)
        with open(tip, 'w', encoding='utf-8') as f:
            json.dump({'version': 1, 'chars': old}, f, ensure_ascii=False)
        log(f'索引写入 {tip}（{len(old)} 位干员）')

    dt = time.time() - t0
    log(f'done: {n_files} 个文件，{len(index)} 位干员有皮肤，{skipped} 个跳过，用时 {dt:.1f}s')
    return 0


if __name__ == '__main__':
    sys.exit(main())
