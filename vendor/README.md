# vendor/

Third-party libraries, committed directly so GitHub Pages can serve this repo with no build
step and no runtime CDN dependency. Do not edit these files by hand.

| File | Package | Version | License | Used for |
|---|---|---|---|---|
| `heic-to.js` | [heic-to](https://www.npmjs.com/package/heic-to) (`dist/next` build) | 1.5.2 | LGPL-3.0 | Decoding HEIC/HEIF (iPhone photos). Bundles libheif compiled to WASM. |
| `utif2.js` | [utif2](https://www.npmjs.com/package/utif2) | 4.1.0 | MIT | Decoding TIFF. |
| `fflate.js` | [fflate](https://www.npmjs.com/package/fflate) (`esm/browser`) | 0.8.3 | MIT | Building the ZIP fallback, and supplying `inflateRaw` to utif2 for Deflate-compressed TIFFs. |

Notes:

- The `dist/next` build of heic-to is the one that works **inside a Web Worker** — it uses
  `OffscreenCanvas` and never touches `document`. Do not swap it for `dist/heic-to.js`.
- utif2 is a UMD bundle that assigns `self.UTIF`. It expects a global `pako` for
  Deflate-compressed TIFFs; `worker.js` shims that with fflate's `inflateRaw` instead of
  pulling in a fourth dependency.
- heic-to and the libheif WASM inside it are **LGPL-3.0**. They are used unmodified and loaded
  as a separate module, which keeps the obligation satisfied. If you ever modify or inline the
  WASM, re-check the license terms.

## Updating

Re-download from the same sources; there is no lockfile or `npm install` step:

```bash
curl -L https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js -o fflate.js
curl -L https://cdn.jsdelivr.net/npm/utif2@4.1.0/UTIF.js        -o utif2.js
# heic-to: download the npm tarball and copy dist/next/heic-to.js
```
