# Image Compressor

A web page that shrinks photos before they go up to the WordPress site. Drag in a folder,
get web-ready images back.

It runs entirely in the browser — images are never uploaded anywhere, so it works with
client photos and embargoed material without anything leaving the machine.

## For anyone using it

1. Open the link.
2. Drag in a folder of photos, or click **Choose folder**.
3. Wait for the list to finish.
4. Click **Save** (or **Download ZIP**).

Compressed copies land in a **`compressed/` subfolder** next to the originals, keeping their
original filenames. Your originals are never modified.

Three presets:

| Preset | Longest side | Quality | Use it for |
|---|---|---|---|
| **Web** (default) | 3000px | 82 | Everything, unless you have a reason not to |
| High quality | 3000px | 90 | Hero images, anything shown large |
| Maximum compression | 2000px | 70 | Long galleries, thumbnails, sidebar images |

**Advanced** opens the max-dimension, quality, and format controls if you need them.

Accepts **JPEG, PNG, HEIC, TIFF, WebP, GIF and AVIF**. Output is WebP by default (WordPress
has supported it since 5.8); JPEG is available under Advanced.

### Things worth knowing

- **Images are never enlarged.** A 200px logo stays 200px. Only images bigger than the cap
  get scaled down.
- **Photo metadata is removed.** Re-encoding strips GPS and camera data — good for privacy
  and file size — but it also strips **embedded copyright and credit fields**. Check with the
  photography department before using this on images that carry credit metadata.
- **Rotation is handled.** Photos that display upright stay upright.
- **Broken files are skipped, not fatal.** A damaged image gets flagged in the list and
  everything else still processes.
- **A file that can't be made smaller is left alone**, and says so. HEIC and TIFF are always
  converted regardless, because browsers can't display them at all.
- **HEIC is slower** — roughly 1–3 seconds per iPhone photo, versus near-instant for JPEG.

### Browser differences

| | Chrome / Edge | Safari / Firefox |
|---|---|---|
| Output | Written into a `compressed/` subfolder | Downloaded as `compressed.zip` |

Both produce the same layout. The ZIP unzips to a `compressed/` folder. The page tells you
which mode you're in, top right.

## For whoever maintains it

Plain static files. No build step, no `npm install`, no bundler — the third-party libraries
are committed under `vendor/` (see [`vendor/README.md`](vendor/README.md) for what they are
and how to update them).

```
index.html     UI markup
styles.css     all styling
app.js         UI state, presets, worker pool, save flow
worker.js      decode -> resize -> encode, one image at a time
output.js      folder writer + ZIP fallback
vendor/        heic-to (HEIC), utif2 (TIFF), fflate (ZIP)
legacy/        the old Tkinter desktop app this replaced
```

### Running it locally

Module workers and the File System Access API both need a real origin, so `file://` will not
work — you need a server:

```bash
python3 -m http.server 8777
# then open http://localhost:8777
```

### Deploying

Push to GitHub and turn on Pages (Settings → Pages → deploy from branch, root folder). The
repo is served as-is.

⚠️ **GitHub Pages on a private repo needs a paid plan.** On a free account the repo has to be
public for Pages to serve it. Nothing here is sensitive, but make sure no client photos ever
get committed — `.gitignore` already excludes `test-images/` and loose `.heic` files.

### How it works

Each image goes through one pipeline, in a Web Worker:

1. **Sniff the format from magic bytes**, not the file extension. Extensions lie.
2. **Decode.** JPEG/PNG/WebP/GIF/AVIF go through `createImageBitmap` with
   `imageOrientation: 'from-image'`, which is what applies EXIF rotation. HEIC goes through
   `heic-to` (libheif in WASM, lazily loaded on first HEIC so JPEG batches never download
   it). TIFF goes through `utif2`.
3. **Scale** by `min(1, maxDimension / longestSide)` — the `min(1, …)` is what prevents
   upscaling. Resampling happens inside `createImageBitmap`, which avoids canvas size limits
   that a 100-megapixel TIFF would otherwise hit.
4. **Encode** to WebP or JPEG via `OffscreenCanvas.convertToBlob`. JPEG gets a white matte
   first, since it has no alpha channel.
5. **Keep the original if the output isn't smaller** — but only for formats the web can
   already display.

A pool of up to 4 workers runs these in parallel. The cap is deliberate: decoding a dozen
50-megapixel photos at once will exhaust the tab's memory.

### Testing

There is no automated test suite. Regenerate the fixtures, serve the repo, and drag
`test-images/` into the page:

```bash
./image_env/bin/python tools/make-test-images.py   # or any python3 with Pillow
python3 -m http.server 8777
```

`test-images/` is gitignored. The cases that matter:

| Fixture | Expected |
|---|---|
| 8000×6000 JPEG | → 3000×2250 |
| 6000×8000 JPEG | → 2250×3000 |
| Portrait JPEG with EXIF orientation 6 | Output is portrait, not sideways |
| 200×200 PNG | Untouched, reported "Kept as-is" |
| RGBA PNG | No crash, transparency handled |
| CMYK JPEG | Decodes |
| Deflate-compressed TIFF | Decodes (exercises the fflate/pako shim) |
| HEIC | Converts to WebP even if that makes it bigger |
| `.txt` renamed to `.jpg` | Flagged as not an image; batch continues |
| Same folder twice | Second run ignores `compressed/` |

## History

This replaces a Tkinter desktop app that only ran from a terminal, kept in `legacy/`. That
version re-compressed its own output on every rerun, ignored EXIF orientation, crashed on
RGBA PNGs, and didn't resize at all.
