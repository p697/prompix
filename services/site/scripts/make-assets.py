#!/usr/bin/env python3
"""Derive website icons and the default share image from the app icon. Run after the app icon changes."""
import pathlib
from PIL import Image, ImageDraw, ImageFilter

root = pathlib.Path(__file__).resolve().parents[1]
repo = root.parents[1]
out = root / 'public' / 'assets'
icon = Image.open(repo / 'ios/Prompix/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png').convert('RGB')


def rounded(image, radius_ratio=0.2237):
    size = image.size[0]
    scale = 4
    mask = Image.new('L', (size * scale, size * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * scale - 1, size * scale - 1), radius=int(size * scale * radius_ratio), fill=255)
    tile = image.convert('RGBA')
    tile.putalpha(mask.resize((size, size), Image.LANCZOS))
    return tile


icon.resize((180, 180), Image.LANCZOS).save(out / 'apple-touch-icon.png', optimize=True)
for size in (32, 64, 192, 512):
    rounded(icon.resize((size, size), Image.LANCZOS)).save(out / f'icon-{size}.png', optimize=True)

# Share image: the app icon on a quiet paper field with a soft spectral glow. No text, no third-party fonts.
width, height = 1200, 630
canvas = Image.new('RGB', (width, height), (249, 249, 252))
draw = ImageDraw.Draw(canvas)
for (cx, cy, r, color) in [(500, 330, 250, (196, 202, 250)), (640, 300, 250, (215, 207, 246)), (740, 350, 220, (240, 214, 244))]:
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
canvas = canvas.filter(ImageFilter.GaussianBlur(110))
tile_size = 340
tile = rounded(icon.resize((tile_size, tile_size), Image.LANCZOS))
shadow = Image.new('RGBA', (width, height), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle(((width - tile_size) // 2, (height - tile_size) // 2 + 24, (width + tile_size) // 2, (height + tile_size) // 2 + 24), radius=76, fill=(39, 36, 51, 46))
shadow = shadow.filter(ImageFilter.GaussianBlur(36))
canvas.paste(shadow, (0, 0), shadow)
canvas.paste(tile, ((width - tile_size) // 2, (height - tile_size) // 2), tile)
canvas.save(out / 'og.png', optimize=True)
print('Wrote icons and share image to', out)
