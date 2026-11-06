#!/usr/bin/env python3
"""Genera le icone PWA di Gestione Conti (nessuna dipendenza oltre Pillow).

Uso:
    python3 script/generate_icons.py

Produce in assets/icons/:
    icon-192.png, icon-512.png                 (purpose "any")
    icon-maskable-192.png, icon-maskable-512.png (purpose "maskable", logo nel safe zone)
    apple-touch-icon-180.png                   (iOS, full-bleed opaco)
    favicon-32.png, favicon-16.png

Il disegno replica il logo dell'app (.app-logo): quadrato con gradiente
indigo #6366f1 -> #4338ca e la "€" bianca al centro.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "assets" / "icons"

BG_FROM = (99, 102, 241)    # #6366f1
BG_TO = (67, 56, 202)       # #4338ca
FG = (255, 255, 255)
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
        # SFNS/SFCompact sono variable font: chiediamo il peso Bold se disponibile.
        try:
            font.set_variation_by_name("Bold")
        except Exception:
            pass
        return font
    return ImageFont.load_default(size)


def gradient_square(size: int) -> Image.Image:
    """Gradiente diagonale (alto-sx -> basso-dx) senza banding visibile."""
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            draw.point(
                (x, y),
                tuple(round(a + (b - a) * t) for a, b in zip(BG_FROM, BG_TO)),
            )
    return img


def draw_glyph(img: Image.Image, size: int, ratio: float) -> None:
    """Centra la € otticamente con dimensione = ratio * lato."""
    draw = ImageDraw.Draw(img)
    font = load_font(max(8, round(size * ratio)))
    left, top, right, bottom = draw.textbbox((0, 0), GLYPH, font=font)
    w, h = right - left, bottom - top
    x = (size - w) / 2 - left
    y = (size - h) / 2 - top
    draw.text((x, y), GLYPH, font=font, fill=FG)


def build(size: int, ratio: float, path: Path) -> None:
    img = gradient_square(size)
    draw_glyph(img, size, ratio)
    img.save(path, "PNG", optimize=True)
    print(f"{path.relative_to(path.parents[2])}  {size}x{size}")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # "any": la € può occupare più spazio (nessun ritaglio aggressivo).
    build(192, 0.56, OUT_DIR / "icon-192.png")
    build(512, 0.56, OUT_DIR / "icon-512.png")
    # "maskable": tutto ciò che conta deve stare nel cerchio di raggio 40%.
    build(192, 0.46, OUT_DIR / "icon-maskable-192.png")
    build(512, 0.46, OUT_DIR / "icon-maskable-512.png")
    # iOS: opaca e full-bleed, il mascheramento lo fa il sistema.
    build(180, 0.56, OUT_DIR / "apple-touch-icon-180.png")
    build(32, 0.62, OUT_DIR / "favicon-32.png")
    build(16, 0.64, OUT_DIR / "favicon-16.png")


if __name__ == "__main__":
    main()
