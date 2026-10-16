"""Draws the app icons (a white price tag on Pantry Standard terracotta) with no image libraries.

Run: uv run python scripts/make_icons.py   -> writes site/icons/*.png and favicon.svg
"""

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "site" / "icons"

# Tag outline in unit coordinates (pointing left), rotated -45 degrees about the centre.
TAG = [(0.22, 0.50), (0.40, 0.30), (0.80, 0.30), (0.80, 0.70), (0.40, 0.70)]
HOLE = (0.42, 0.50, 0.055)
ANGLE = math.radians(-45)
BG = (0xC2, 0x5E, 0x3E)   # terracotta, as in docs/design


def rotate(x: float, y: float) -> tuple[float, float]:
    cx, cy = 0.5, 0.5
    dx, dy = x - cx, y - cy
    return (cx + dx * math.cos(ANGLE) - dy * math.sin(ANGLE), cy + dx * math.sin(ANGLE) + dy * math.cos(ANGLE))


def shape(scale: float):
    """Tag polygon and hole, scaled about the centre (scale < 1 leaves room for maskable icons)."""
    rotated = [rotate(*p) for p in TAG]
    # Centre the tag's bounding box in the icon.
    ox = 0.5 - (min(x for x, _ in rotated) + max(x for x, _ in rotated)) / 2
    oy = 0.5 - (min(y for _, y in rotated) + max(y for _, y in rotated)) / 2

    def s(p):
        return (0.5 + (p[0] + ox - 0.5) * scale, 0.5 + (p[1] + oy - 0.5) * scale)
    poly = [s(p) for p in rotated]
    hx, hy = s(rotate(HOLE[0], HOLE[1]))
    return poly, (hx, hy, HOLE[2] * scale)


def inside(poly, x, y) -> bool:
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def render(size: int, scale: float, rounded: bool) -> bytes:
    poly, (hx, hy, hr) = shape(scale)
    ss = 3  # 3x3 supersampling for smooth edges
    radius = 0.18 if rounded else 0.0
    rows = []
    for py in range(size):
        row = bytearray([0])  # filter byte
        for px in range(size):
            white = bg = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    if rounded and not in_rounded_square(x, y, radius):
                        continue
                    bg += 1
                    if inside(poly, x, y) and (x - hx) ** 2 + (y - hy) ** 2 > hr ** 2:
                        white += 1
            n = ss * ss
            alpha = round(255 * bg / n)
            t = white / bg if bg else 0          # share of the visible pixel that is the white tag
            row += bytes([round(c + (255 - c) * t) for c in BG] + [alpha])
        rows.append(bytes(row))
    return png(size, size, b"".join(rows))


def in_rounded_square(x, y, r) -> bool:
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def png(w: int, h: int, raw: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def svg() -> str:
    poly, (hx, hy, hr) = shape(1.0)
    pts = " ".join(f"{x * 100:.1f},{y * 100:.1f}" for x, y in poly)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            f'<rect width="100" height="100" rx="18" fill="#C25E3E"/>'
            f'<polygon points="{pts}" fill="#fff"/>'
            f'<circle cx="{hx * 100:.1f}" cy="{hy * 100:.1f}" r="{hr * 100:.1f}" fill="#C25E3E"/></svg>\n')


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon-192.png").write_bytes(render(192, 1.0, rounded=False))
    (OUT / "icon-512.png").write_bytes(render(512, 1.0, rounded=False))
    (OUT / "icon-maskable-512.png").write_bytes(render(512, 0.72, rounded=False))  # inside the safe zone
    (OUT / "apple-touch-icon.png").write_bytes(render(180, 1.0, rounded=False))  # iOS rounds the corners itself
    (OUT / "favicon.svg").write_text(svg(), encoding="utf-8")
    print("icons written to", OUT)
