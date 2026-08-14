#!/usr/bin/env python3
"""Generate the test fixtures used to check the compressor.

Each file targets a specific failure the old Tkinter app had, or a format the browser
pipeline has to handle. Run it, serve the repo, and drag test-images/ into the page.

    python3 tools/make-test-images.py

Needs Pillow (the legacy venv has it: ./image_env/bin/python tools/make-test-images.py).
The HEIC fixture is made with macOS `sips` and is skipped on other platforms.
"""

import os
import shutil
import subprocess
import sys

from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test-images")


def gradient(width, height):
    """A cheap gradient. Flat colour would compress unrealistically well."""
    img = Image.new("RGB", (width, height))
    px = img.load()
    for y in range(0, height, 8):
        for x in range(0, width, 8):
            colour = ((x * 255) // width, (y * 255) // height, 140)
            for dy in range(min(8, height - y)):
                for dx in range(min(8, width - x)):
                    px[x + dx, y + dy] = colour
    return img


def main():
    os.makedirs(OUT, exist_ok=True)

    # Oversized, both orientations. The cap applies to the longest side, so these should
    # come out 3000x2250 and 2250x3000 respectively.
    big = gradient(8000, 6000)
    big.save(f"{OUT}/big-landscape.jpg", quality=95)
    big.rotate(90, expand=True).save(f"{OUT}/big-portrait.jpg", quality=95)
    del big

    # Under the cap: must not be upscaled, and is small enough that re-encoding would make
    # it bigger, so it should be reported as "Kept as-is".
    Image.new("RGB", (200, 200), (200, 60, 40)).save(f"{OUT}/small-logo.png")

    # RGBA. The old app raised OSError converting this to JPEG and killed the whole run.
    rgba = Image.new("RGBA", (1200, 900), (0, 0, 0, 0))
    for y in range(0, 900, 2):
        for x in range(0, 1200, 3):
            rgba.putpixel((x, y), (255, 120, 0, 255))
    rgba.save(f"{OUT}/transparent.png")

    # CMYK, as it arrives from print workflows.
    Image.new("CMYK", (2400, 1600), (20, 180, 200, 10)).save(f"{OUT}/cmyk-press.jpg", quality=92)

    # TIFF, uncompressed and Deflate-compressed. The Deflate one exercises the fflate
    # shim that stands in for pako in worker.js.
    scan = gradient(3500, 2400)
    scan.save(f"{OUT}/scan-plain.tif")
    scan.save(f"{OUT}/scan-deflate.tif", compression="tiff_deflate")

    # EXIF orientation 6 means "rotate 90 clockwise to display". Stored 1600x1200 landscape
    # with a red stripe along the stored top edge, so a correct decoder produces a 1200x1600
    # portrait with the stripe down the RIGHT side. The old app saved this sideways.
    rotated = Image.new("RGB", (1600, 1200), (245, 245, 245))
    for x in range(1600):
        for y in range(150):
            rotated.putpixel((x, y), (220, 20, 20))
    exif = rotated.getexif()
    exif[274] = 6
    rotated.save(f"{OUT}/rotated-portrait.jpg", exif=exif, quality=92)

    # Not an image at all, despite the extension. Must be caught by magic-byte sniffing
    # and reported without stopping the batch.
    with open(f"{OUT}/not-really.jpg", "w") as handle:
        handle.write("this is definitely not an image\n" * 50)

    # HEIC, via macOS sips. Real iPhone photos are far larger; this one is small enough that
    # WebP can't beat it, which is exactly the case that must still be converted.
    if shutil.which("sips"):
        subprocess.run(
            ["sips", "-s", "format", "heic", f"{OUT}/rotated-portrait.jpg",
             "--out", f"{OUT}/iphone-photo.heic"],
            check=True, capture_output=True,
        )
    else:
        print("sips not found -- skipping the HEIC fixture", file=sys.stderr)

    for name in sorted(os.listdir(OUT)):
        print(f"{name:24} {os.path.getsize(os.path.join(OUT, name)):>10,} bytes")


if __name__ == "__main__":
    main()
