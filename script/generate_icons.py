#!/usr/bin/env python3
"""Genera le icone PWA di Gestione Conti (nessuna dipendenza oltre Pillow).

Uso:
    python3 script/generate_icons.py

Produce in assets/icons/:
    icon-192.png, icon-512.png                    (purpose "any")
    icon-maskable-192.png, icon-maskable-512.png  (purpose "maskable", glifo nel safe zone)
    apple-touch-icon-180.png                      (iOS, full-bleed opaco)
    favicon-32.png, favicon-16.png

Stile "Apple measured": tessera nera con la "€" nel gradiente brand misurato
sul sito (giallo #fdd30f → ciano #90ceee → blu #2789ff).
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "assets" / "icons"

BG_FROM = (36, 36, 38)      # #242426
BG_TO = (0, 0, 0)           # nero
GLYPH_GRADIENT = [(253, 211, 15), (144, 206, 238), (39, 137, 255)]
GLYPH = "\u20ac"            # €

FONT_CANDIDATES = [
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if not Path(path).exists():
            continue
        try:
            font = ImageFont.truetype(path, size)
        except OSError:
            continue
        try:
            font.set_variation_by_name("Bold")
        except Exception:
            pass
        return font
    return ImageFont.load_default(size)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient_square(size: int, start, end) -> Image.Image:
    """Gradiente verticale diagonale (alto-sx -> basso-dx)."""
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        for x in range(size):
            t = (x * 0.55 + y * 0.45) / (size - 1)
            draw.point((x, y), lerp(start, end, t))
    return img


def brand_gradient(size: int) -> Image.Image:
    """Gradiente orizzontale giallo → ciano → blu."""
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    stops = GLYPH_GRADIENT
    segment = (size - 1) / (len(stops) - 1)
    for x in range(size):
        pos = x / segment
        i = min(int(pos), len(stops) - 2)
        color = lerp(stops[i], stops[i + 1], pos - i)
        draw.line([(x, 0), (x, size)], fill=color)
    return img


def glyph_mask(size: int, ratio: float) -> Image.Image:
    """Maschera L con la € centrata otticamente, alta ratio * lato."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    font = load_font(max(8, round(size * ratio)))
    left, top, right, bottom = draw.textbbox((0, 0), GLYPH, font=font)
    w, h = right - left, bottom - top
    x = (size - w) / 2 - left
    y = (size - h) / 2 - top
    draw.text((x, y), GLYPH, font=font, fill=255)
    return mask


def build(size: int, ratio: float, path: Path) -> None:
    img = gradient_square(size, BG_FROM, BG_TO).convert("RGB")
    mask = glyph_mask(size, ratio)
    box = mask.getbbox()
    if box:
        w, h = box[2] - box[0], box[3] - box[1]
        grad = brand_gradient(max(w, h)).crop((0, 0, w, h))
        img.paste(grad, (box[0], box[1]), mask.crop(box))
    img.save(path, "PNG", optimize=True)
    print(f"{path.relative_to(path.parents[2])}  {size}x{size}")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    build(192, 0.56, OUT_DIR / "icon-192.png")
    build(512, 0.56, OUT_DIR / "icon-512.png")
    # "maskable": il contenuto utile deve stare nel cerchio di raggio 40%.
    build(192, 0.46, OUT_DIR / "icon-maskable-192.png")
    build(512, 0.46, OUT_DIR / "icon-maskable-512.png")
    build(180, 0.56, OUT_DIR / "apple-touch-icon-180.png")
    build(32, 0.62, OUT_DIR / "favicon-32.png")
    build(16, 0.64, OUT_DIR / "favicon-16.png")


if __name__ == "__main__":
    main()
