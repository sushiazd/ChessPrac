"""Dessine assets/icon.ico : un pion couleur papier sur un carré encre arrondi (le style d'ESIRPRAC).
Usage : .venv\\Scripts\\python tools\\make_icon.py   (demande Pillow : pip install pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
INK, PAPER, PEN = (28, 27, 25, 255), (244, 242, 236, 255), (36, 70, 200, 255)


def draw(size: int = 1024) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / 100
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=22 * s, fill=INK)
    cx = 50 * s
    d.ellipse([cx - 11 * s, 17 * s, cx + 11 * s, 39 * s], fill=PAPER)                     # tête
    d.rounded_rectangle([cx - 14 * s, 38 * s, cx + 14 * s, 45 * s], radius=3 * s, fill=PAPER)  # col
    d.polygon([(cx - 9 * s, 44 * s), (cx + 9 * s, 44 * s), (cx + 19 * s, 72 * s), (cx - 19 * s, 72 * s)], fill=PAPER)
    d.rounded_rectangle([cx - 25 * s, 70 * s, cx + 25 * s, 82 * s], radius=4 * s, fill=PAPER)  # socle
    d.rounded_rectangle([cx - 25 * s, 86 * s, cx + 25 * s, 89 * s], radius=1.5 * s, fill=PEN)  # trait de stylo
    return img


if __name__ == "__main__":
    out = ROOT / "assets" / "icon.ico"
    out.parent.mkdir(exist_ok=True)
    big = draw()
    big.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.resize((256, 256), Image.LANCZOS).save(ROOT / "assets" / "icon.png")
    print("OK ->", out)
