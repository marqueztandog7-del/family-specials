"""Draws the app icons (a white shopping basket on Pantry Standard terracotta) with no image libraries.

Run: uv run python scripts/make_icons.py   -> writes site/icons/*.png and favicon.svg
"""

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "site" / "icons"
BG = (0xC2, 0x5E, 0x3E)   # terracotta, as in docs/design

# The basket in unit coordinates (0..1): a handle arc, a rim, a tapered body with three slots.
HANDLE_C, HANDLE_R_OUT, HANDLE_R_IN = (0.5, 0.47), 0.24, 0.185
RIM = (0.17, 0.43, 0.83, 0.52, 0.03)                 # x0, y0, x1, y1, corner radius
BODY_TOP, BODY_BOTTOM, BODY_TOP_X, BODY_TAPER = 0.52, 0.80, (0.21, 0.79), 0.08
SLOTS, SLOT_HALF_W, SLOT_Y = (0.38, 0.50, 0.62), 0.022, (0.58, 0.74)
LIFT = 0.015              # the basket's visual centre sits slightly low; nudge it up


def in_rounded_rect(x, y, x0, y0, x1, y1, r) -> bool:
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def basket(x: float, y: float) -> bool:
    hx, hy = HANDLE_C
    if y <= hy and HANDLE_R_IN <= math.hypot(x - hx, y - hy) <= HANDLE_R_OUT:
        return True
    if in_rounded_rect(x, y, *RIM):
        return True
    if BODY_TOP <= y <= BODY_BOTTOM:
        t = (y - BODY_TOP) / (BODY_BOTTOM - BODY_TOP)
        if BODY_TOP_X[0] + BODY_TAPER * t <= x <= BODY_TOP_X[1] - BODY_TAPER * t:
            in_slot = SLOT_Y[0] <= y <= SLOT_Y[1] and any(abs(x - c) <= SLOT_HALF_W for c in SLOTS)
            return not in_slot
    return False


def render(size: int, scale: float) -> bytes:
    """Full-bleed square (iOS and Android round the corners themselves). scale < 1 shrinks the basket
    about the centre, to keep it inside the safe zone of maskable icons."""
    ss = 3  # 3x3 supersampling for smooth edges
    rows = []
    for py in range(size):
        row = bytearray([0])  # filter byte
        for px in range(size):
            white = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    if basket(0.5 + (x - 0.5) / scale, 0.5 + (y - 0.5) / scale + LIFT):
                        white += 1
            t = white / (ss * ss)
            row += bytes([round(c + (255 - c) * t) for c in BG] + [255])
        rows.append(bytes(row))
    return png(size, size, b"".join(rows))


def png(w: int, h: int, raw: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def svg() -> str:
    """The same basket for the browser tab (favicon)."""
    k = 100
    hx, hy = HANDLE_C[0] * k, (HANDLE_C[1] - LIFT) * k
    r = (HANDLE_R_OUT + HANDLE_R_IN) / 2 * k
    w = (HANDLE_R_OUT - HANDLE_R_IN) * k
    x0, y0, x1, y1, rr = RIM
    top, bot = (BODY_TOP - LIFT) * k, (BODY_BOTTOM - LIFT) * k
    tl, tr, tp = BODY_TOP_X[0] * k, BODY_TOP_X[1] * k, BODY_TAPER * k
    slots = "".join(f'<rect x="{(c - SLOT_HALF_W) * k:.1f}" y="{(SLOT_Y[0] - LIFT) * k:.1f}" '
                    f'width="{SLOT_HALF_W * 2 * k:.1f}" height="{(SLOT_Y[1] - SLOT_Y[0]) * k:.1f}" fill="#C25E3E"/>'
                    for c in SLOTS)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            f'<rect width="100" height="100" rx="18" fill="#C25E3E"/>'
            f'<path d="M{hx - r:.1f} {hy:.1f}A{r:.1f} {r:.1f} 0 0 1 {hx + r:.1f} {hy:.1f}" fill="none" stroke="#fff" stroke-width="{w:.1f}"/>'
            f'<rect x="{x0 * k:.1f}" y="{(y0 - LIFT) * k:.1f}" width="{(x1 - x0) * k:.1f}" height="{(y1 - y0) * k:.1f}" rx="{rr * k:.1f}" fill="#fff"/>'
            f'<polygon points="{tl:.1f},{top:.1f} {tr:.1f},{top:.1f} {tr - tp:.1f},{bot:.1f} {tl + tp:.1f},{bot:.1f}" fill="#fff"/>'
            f'{slots}</svg>\n')


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon-192.png").write_bytes(render(192, 1.0))
    (OUT / "icon-512.png").write_bytes(render(512, 1.0))
    (OUT / "icon-maskable-512.png").write_bytes(render(512, 0.72))  # inside the safe zone
    (OUT / "apple-touch-icon.png").write_bytes(render(180, 1.0))    # iOS rounds the corners itself
    (OUT / "favicon.svg").write_text(svg(), encoding="utf-8")
    print("icons written to", OUT)
