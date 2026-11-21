#!/usr/bin/env python3
"""Generates the PWA icons into public/app/icons (needs Pillow)."""
import os, sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'public', 'app', 'icons')
os.makedirs(out, exist_ok=True)
def icon(size, maskable, name):
    im = Image.new('RGB', (size, size), (10, 12, 15)); d = ImageDraw.Draw(im)
    pad = 0 if maskable else int(size * 0.08)
    if not maskable: d.rounded_rectangle((pad, pad, size - pad, size - pad), radius=int(size * 0.22), fill=(18, 21, 26))
    r = int(size * (0.26 if maskable else 0.3)); c = size // 2
    d.ellipse((c - r, c - r, c + r, c + r), outline=(30, 215, 96), width=max(4, size // 28))
    try: f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(size * 0.3))
    except Exception: f = ImageFont.load_default()
    d.text((c, c), 'π', font=f, fill=(242, 244, 247), anchor='mm')
    im.save(os.path.join(out, name))
icon(192, False, 'icon-192.png'); icon(512, False, 'icon-512.png'); icon(512, True, 'maskable-512.png'); icon(180, True, 'apple-touch-icon.png')
