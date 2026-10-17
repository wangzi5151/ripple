#!/usr/bin/env python3
"""Generate 192x192 and 512x512 PNG PWA icons from the local SVG mark."""
from pathlib import Path
import re
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "public/icons/icon.svg"
OUT = ROOT / "public/icons"


def chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)


def png(size: int, bg: tuple[int, int, int], fg: tuple[int, int, int]) -> bytes:
    # Small geometric Ripple mark, rasterized without external imaging libraries.
    rows = []
    cx = cy = size / 2
    radius = size * 0.22
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            xx, yy = (x + 0.5) / size, (y + 0.5) / size
            # R-like strokes in normalized coordinates, with a rounded app tile.
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            corner = size * 0.22
            qx, qy = abs(dx) - (cx - corner), abs(dy) - (cy - corner)
            outside = (max(qx, 0) ** 2 + max(qy, 0) ** 2) ** 0.5
            inside = min(max(qx, qy), 0)
            rounded = outside + inside <= corner
            color = bg if rounded else (255, 255, 255)
            # Monogram: stem, bowl and diagonal leg.
            stroke = size * 0.045
            stem = 0.28 < xx < 0.39 and 0.31 < yy < 0.73
            bowl_ring = 0.35 < xx < 0.69 and 0.30 < yy < 0.56 and (
                abs(((xx - 0.52) / 0.17) ** 2 + ((yy - 0.43) / 0.13) ** 2 - 1) < 0.24
            )
            leg_dist = abs((yy - 0.52) - 0.8 * (xx - 0.52)) / (1.64 ** 0.5)
            leg = 0.50 < xx < 0.73 and 0.50 < yy < 0.73 and leg_dist < stroke
            if rounded and (stem or bowl_ring or leg):
                color = fg
            # trailing ripple dot
            if rounded and ((xx - 0.76) ** 2 + (yy - 0.74) ** 2) < 0.003:
                color = (157, 216, 189)
            row.extend((*color, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        path = OUT / f"icon-{size}.png"
        path.write_bytes(png(size, (23, 108, 87), (255, 255, 255)))
        print(path)
