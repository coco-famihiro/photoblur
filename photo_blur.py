"""
photo_blur.py  –  写真へのぼかし/モザイク適用（矩形・楕円対応）

Usage:
    python photo_blur.py <input_path> <regions_json> <output_path>

regions_json: JSON array of objects:
  { "type": "blur"|"mosaic"|"mosaic_face"|"mosaic_body",
    "shape": "rect"|"ellipse",
    "x": 0-100, "y": 0-100, "width": 0-100, "height": 0-100,
    "intensity": int }
"""
import sys
import json
import os

import cv2
import numpy as np


def apply_regions(img: np.ndarray, regions: list) -> np.ndarray:
    h, w = img.shape[:2]
    channels = img.shape[2] if img.ndim == 3 else 1

    for r in regions:
        x = int(r["x"] / 100 * w)
        y = int(r["y"] / 100 * h)
        rw = max(1, int(r["width"] / 100 * w))
        rh = max(1, int(r["height"] / 100 * h))
        intensity = max(1, int(r.get("intensity", 15)))
        shape = r.get("shape", "rect")

        # Clamp to image bounds
        x = max(0, min(w - 1, x))
        y = max(0, min(h - 1, y))
        rw = min(rw, w - x)
        rh = min(rh, h - y)
        if rw <= 0 or rh <= 0:
            continue

        roi = img[y:y + rh, x:x + rw].copy()

        # Scale effect by IMAGE size (not region size) so intensity is uniform
        # regardless of how large or small the selected region is.
        # intensity/1000 * min(image_w, image_h) → same visual strength for any region.
        image_short = min(w, h)

        # Compute the effect
        # "blur" → Gaussian blur
        # "mosaic", "mosaic_face", "mosaic_body" → pixelation mosaic
        if r["type"] == "blur":
            sigma = max(1.0, intensity * image_short / 1000.0)
            effect = cv2.GaussianBlur(roi, (0, 0), sigma)
        else:  # mosaic / mosaic_face / mosaic_body
            pixel_size = max(2, int(intensity * image_short / 1000))
            sw = max(1, rw // pixel_size)
            sh = max(1, rh // pixel_size)
            small = cv2.resize(roi, (sw, sh), interpolation=cv2.INTER_LINEAR)
            effect = cv2.resize(small, (rw, rh), interpolation=cv2.INTER_NEAREST)

        if shape == "ellipse":
            # Build ellipse mask and blend
            mask = np.zeros((rh, rw), dtype=np.uint8)
            cx, cy = rw // 2, rh // 2
            cv2.ellipse(mask, (cx, cy), (max(1, cx), max(1, cy)), 0, 0, 360, 255, -1)
            if channels > 1:
                mask3 = np.stack([mask] * channels, axis=-1)
                img[y:y + rh, x:x + rw] = np.where(mask3 > 0, effect, roi)
            else:
                img[y:y + rh, x:x + rw] = np.where(mask > 0, effect, roi)
        else:
            img[y:y + rh, x:x + rw] = effect

    return img


def main():
    if len(sys.argv) < 4:
        print("Usage: photo_blur.py <input> <regions_json> <output>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    regions_json = sys.argv[2]
    output_path = sys.argv[3]

    regions = json.loads(regions_json)

    # DEBUG: write received args to log file
    debug_log = os.path.join(os.path.expanduser("~"), "photoblur_debug.txt")
    with open(debug_log, "a", encoding="utf-8") as dbg:
        dbg.write(f"\n=== apply_photo_blur ===\n")
        dbg.write(f"input:  {input_path}\n")
        dbg.write(f"output: {output_path}\n")
        dbg.write(f"regions_count: {len(regions)}\n")
        dbg.write(f"regions_json: {regions_json}\n")

    # Use Python's open() for Unicode path support on Windows
    with open(input_path, "rb") as f:
        data = f.read()
    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        print(f"ERROR: cannot read {input_path}", file=sys.stderr)
        sys.exit(1)

    img = apply_regions(img, regions)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    ext = os.path.splitext(output_path)[1].lower()
    ok, encoded = cv2.imencode(ext if ext else ".png", img)
    if not ok:
        print(f"ERROR: cannot encode {output_path}", file=sys.stderr)
        sys.exit(1)

    # Use Python's open() for Unicode path support on Windows
    with open(output_path, "wb") as f:
        f.write(encoded.tobytes())

    print("OK")


if __name__ == "__main__":
    main()
