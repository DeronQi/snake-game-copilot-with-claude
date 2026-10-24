#!/usr/bin/env python3
"""
tools/make_icons.py —— 用 Pillow 生成 PWA 图标（可重复执行，输出确定）

输出：
  icons/icon-192.png           普通图标（圆角方形，透明圆角）
  icons/icon-512.png           普通图标
  icons/icon-maskable-512.png  maskable 图标（满版背景，主体位于 80% 安全区内）

用法：python tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SS = 4  # 超采样倍数，绘制后缩小以获得平滑边缘

BG_TOP = (14, 30, 58)
BG_BOTTOM = (5, 8, 15)
TAIL = (16, 110, 78)
NECK = (88, 255, 170)
HEAD = (214, 255, 240)
EYE = (6, 32, 20)
FOOD = (255, 59, 92)

# 5×5 小网格上的蛇（尾 → 头），头朝右
SNAKE = [(0, 4), (0, 3), (0, 2), (1, 2), (2, 2), (2, 1), (2, 0), (3, 0)]
HEAD_DIR = (1, 0)
FRUIT = (3, 3)
GRID = 5


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_bg(size):
    img = Image.new("RGB", (size, size), BG_BOTTOM)
    draw = ImageDraw.Draw(img)
    for y in range(size):
        draw.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / max(1, size - 1)))
    return img


def draw_scene(size, content_ratio):
    """在 size×size 画布中央绘制蛇与果实，主体占 content_ratio 的边长"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    box = size * content_ratio
    origin = (size - box) / 2
    cell = box / GRID
    pad = cell * 0.1
    bridge = cell * 0.76

    def center(c):
        return origin + (c[0] + 0.5) * cell, origin + (c[1] + 0.5) * cell

    n = len(SNAKE)
    # 身体：尾暗头亮，连接桥 + 圆角方块
    for i in range(n - 1):
        t = i / max(1, n - 2)
        color = lerp(TAIL, NECK, t) + (255,)
        ax, ay = center(SNAKE[i])
        bx, by = center(SNAKE[i + 1])
        if ay == by:
            d.rectangle([min(ax, bx), ay - bridge / 2, max(ax, bx), ay + bridge / 2], fill=color)
        else:
            d.rectangle([ax - bridge / 2, min(ay, by), ax + bridge / 2, max(ay, by)], fill=color)
        d.rounded_rectangle([ax - cell / 2 + pad, ay - cell / 2 + pad, ax + cell / 2 - pad, ay + cell / 2 - pad], radius=cell * 0.3, fill=color)

    # 头
    hx, hy = center(SNAKE[-1])
    hp = pad * 0.7
    d.rounded_rectangle([hx - cell / 2 + hp, hy - cell / 2 + hp, hx + cell / 2 - hp, hy + cell / 2 - hp], radius=cell * 0.34, fill=HEAD + (255,))
    dx, dy = HEAD_DIR
    px, py = -dy, dx
    er = cell * 0.09
    for side in (-1, 1):
        ex = hx + dx * cell * 0.16 + px * cell * 0.21 * side
        ey = hy + dy * cell * 0.16 + py * cell * 0.21 * side
        d.ellipse([ex - er, ey - er, ex + er, ey + er], fill=EYE + (255,))

    # 果实
    fx, fy = center(FRUIT)
    fr = cell * 0.36
    d.ellipse([fx - fr, fy - fr, fx + fr, fy + fr], fill=FOOD + (255,))
    hr = fr * 0.22
    d.ellipse([fx - fr * 0.38 - hr, fy - fr * 0.38 - hr, fx - fr * 0.38 + hr, fy - fr * 0.38 + hr], fill=(255, 255, 255, 150))
    d.ellipse([fx + fr * 0.05, fy - fr * 1.2, fx + fr * 0.7, fy - fr * 0.85], fill=(79, 209, 139, 255))
    return layer


def glow(layer, size):
    """主体发光：取 alpha 生成模糊光晕"""
    alpha = layer.split()[3]
    blurred = alpha.filter(ImageFilter.GaussianBlur(size * 0.025))
    halo = Image.new("RGBA", layer.size, (57, 255, 159, 0))
    halo.putalpha(blurred.point(lambda v: int(v * 0.55)))
    return halo


def make_icon(px, maskable):
    size = px * SS
    bg = gradient_bg(size).convert("RGBA")
    # 淡淡的网格底纹（单独图层再合成，ImageDraw 直接画不会做 alpha 混合）
    grid_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grid = ImageDraw.Draw(grid_layer)
    step = size / 10
    for i in range(1, 10):
        p = round(i * step)
        grid.line([(p, 0), (p, size)], fill=(120, 180, 255, 22), width=max(1, SS))
        grid.line([(0, p), (size, p)], fill=(120, 180, 255, 22), width=max(1, SS))
    bg = Image.alpha_composite(bg, grid_layer)

    scene = draw_scene(size, 0.56 if maskable else 0.72)
    bg = Image.alpha_composite(bg, glow(scene, size))
    bg = Image.alpha_composite(bg, scene)

    if not maskable:
        # 普通图标：圆角方形，圆角外透明
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=255)
        bg.putalpha(mask)

    return bg.resize((px, px), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ]
    for name, px, maskable in targets:
        img = make_icon(px, maskable)
        path = OUT / name
        img.save(path, "PNG", optimize=True)
        print(f"✓ {path.relative_to(ROOT).as_posix()}  {img.size[0]}×{img.size[1]}  {'maskable' if maskable else 'any'}  {path.stat().st_size} B")


if __name__ == "__main__":
    main()
