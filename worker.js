// Decode -> resize -> encode. One image at a time; app.js runs a small pool of these.
//
// Everything here is deliberately defensive: a batch of a few hundred photos from a
// photography department will contain at least one file that is mislabelled, truncated,
// in a colour space nobody expected, or 100 megapixels. A single bad file must never take
// down the batch, so every failure is reported per-file and the worker stays alive.

// fflate's `inflateSync` is raw DEFLATE -- the same thing pako calls `inflateRaw`.
// (fflate keeps the zlib-wrapped variant separate, as `unzlibSync`.)
import { inflateSync } from './vendor/fflate.js';

// ---------------------------------------------------------------------------
// Lazily-loaded decoders
//
// heic-to is ~3 MB (it carries libheif compiled to WASM) and utif2 is ~95 KB. Neither is
// touched unless a matching file actually shows up, so the common all-JPEG batch pays for
// neither. Each promise is cached so the module is only fetched once per worker.
// ---------------------------------------------------------------------------

let heicModulePromise = null;
function loadHeic() {
  heicModulePromise ??= import('./vendor/heic-to.js');
  return heicModulePromise;
}

let tiffModulePromise = null;
function loadTiff() {
  // utif2 is a UMD bundle: it assigns self.UTIF rather than exporting anything, and it
  // reaches for a global `pako` to handle Deflate-compressed TIFFs (Photoshop writes these).
  // fflate already gives us a compatible raw inflate, so shim it instead of adding a
  // fourth dependency. This must be set before the module body runs.
  tiffModulePromise ??= (async () => {
    self.pako = { inflateRaw: inflateSync };
    await import('./vendor/utif2.js');
    return self.UTIF;
  })();
  return tiffModulePromise;
}

// ---------------------------------------------------------------------------
// Format detection
//
// Extensions lie. Photographers rename things, Windows round-trips mangle them, and a
// surprising number of "JPEGs" are actually PNGs. Sniff the real container from magic bytes
// so we hand each file to a decoder that can actually read it.
// ---------------------------------------------------------------------------

function sniffFormat(bytes) {
  const u8 = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 32));

  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg';
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'gif';

  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2a && u8[3] === 0x00) ||
      (u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0x00 && u8[3] === 0x2a)) return 'tiff';

  const ascii = (start, end) => String.fromCharCode(...u8.slice(start, end));

  // RIFF....WEBP
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';

  // ISO base media container: bytes 4-8 are "ftyp", the brand follows. HEIC, AVIF and MP4
  // all live in this container, so the brand is what actually distinguishes them.
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).replace('\0', ' ').trim();
    if (['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'heic';
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }

  return 'unknown';
}

// Formats we let the browser decode natively. createImageBitmap handles these directly and
// applies EXIF orientation for us, which is what fixes the sideways-photo problem.
const NATIVE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif']);

// Formats that can be uploaded to the site as-is. HEIC and TIFF are deliberately absent:
// neither can be displayed by browsers, so converting them is the entire point and we must
// never hand one back untouched, however small it is.
const WEB_SAFE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

async function decodeToBitmap(blob, format) {
  if (NATIVE_FORMATS.has(format)) {
    // 'from-image' is the whole point: without it, a portrait photo whose EXIF says
    // "rotate 90" is decoded in its stored landscape orientation and saved sideways.
    return createImageBitmap(blob, { imageOrientation: 'from-image' });
  }

  if (format === 'heic') {
    const { heicTo } = await loadHeic();
    // type:'bitmap' hands back an ImageBitmap directly. Going via an intermediate JPEG
    // would add a generation of lossy re-encoding before we even start.
    return heicTo({ blob, type: 'bitmap' });
  }

  if (format === 'tiff') {
    const UTIF = await loadTiff();
    const buffer = await blob.arrayBuffer();
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) throw new Error('TIFF contains no images');

    // Multi-page TIFFs (scans, layered exports) are common. Take the first page and let the
    // caller mention it, rather than silently dropping pages or failing outright.
    const page = ifds[0];
    UTIF.decodeImage(buffer, page, ifds);
    const rgba = UTIF.toRGBA8(page);
    if (!rgba || !rgba.length) throw new Error('TIFF page could not be decoded');

    const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer), page.width, page.height);
    const bitmap = await createImageBitmap(imageData);
    return { bitmap, extraPages: ifds.length - 1 };
  }

  throw new Error(`Unsupported format: ${format}`);
}

// ---------------------------------------------------------------------------
// Resize + encode
// ---------------------------------------------------------------------------

function targetSize(width, height, maxDimension) {
  // min(1, ...) is what guarantees we never upscale. A 200px logo stays 200px; only images
  // that actually exceed the cap get touched.
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: scale < 1,
  };
}

const THUMB_SIZE = 88; // 44px display box at 2x

async function makeThumbnail(source) {
  const scale = Math.min(1, THUMB_SIZE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
}

async function resizeAndEncode(bitmap, { maxDimension, quality, format }) {
  const target = targetSize(bitmap.width, bitmap.height, maxDimension);

  let source = bitmap;
  if (target.scaled) {
    // Resampling through createImageBitmap rather than drawing the full-size image onto a
    // canvas keeps us clear of per-browser canvas dimension limits, which a 100 MP TIFF
    // would otherwise blow straight past.
    source = await createImageBitmap(bitmap, {
      resizeWidth: target.width,
      resizeHeight: target.height,
      resizeQuality: 'high',
    });
    bitmap.close();
  }

  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d', { alpha: format === 'image/webp' });

  // JPEG has no alpha. Without this, transparent PNG regions encode as black instead of
  // white -- the usual "why is my logo on a black square" bug.
  if (format === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
  }

  ctx.drawImage(source, 0, 0);

  const blob = await canvas.convertToBlob({ type: format, quality: quality / 100 });
  const thumbnail = await makeThumbnail(source);
  source.close();

  // Release the backing store; some browsers hold onto it otherwise, which matters when
  // you're pushing hundreds of images through.
  canvas.width = 1;
  canvas.height = 1;

  return { blob, thumbnail, width: target.width, height: target.height, scaled: target.scaled };
}

// ---------------------------------------------------------------------------
// Per-file entry point
// ---------------------------------------------------------------------------

async function processFile(file, settings) {
  const header = await file.slice(0, 32).arrayBuffer();
  const format = sniffFormat(header);

  if (format === 'unknown') {
    throw new Error("This doesn't look like an image file.");
  }

  const decoded = await decodeToBitmap(file, format);
  const bitmap = decoded.bitmap ?? decoded;
  const extraPages = decoded.extraPages ?? 0;

  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;

  const result = await resizeAndEncode(bitmap, settings);

  // If compression made the file bigger, keep the original bytes. This is a real case:
  // small, already-optimised images routinely grow when re-encoded, and shipping a
  // "compressed" file that is larger than its source would be worse than doing nothing.
  //
  // Three conditions have to hold:
  //  - the output really is no smaller;
  //  - we didn't resize (a capped image is a genuinely different, smaller picture, so it
  //    stays even in the rare case its byte count went up);
  //  - the source is a format the site can actually display. A 3 KB HEIC is smaller than
  //    any WebP we could produce, but handing back the HEIC would defeat the whole job.
  const grew = result.blob.size >= file.size;
  if (grew && !result.scaled && WEB_SAFE_FORMATS.has(format)) {
    return {
      blob: file,
      thumbnail: result.thumbnail,
      keptOriginal: true,
      outputFormat: format,
      width: sourceWidth,
      height: sourceHeight,
      sourceWidth,
      sourceHeight,
      originalSize: file.size,
      newSize: file.size,
      extraPages,
    };
  }

  return {
    blob: result.blob,
    thumbnail: result.thumbnail,
    keptOriginal: false,
    outputFormat: settings.format === 'image/webp' ? 'webp' : 'jpeg',
    width: result.width,
    height: result.height,
    sourceWidth,
    sourceHeight,
    originalSize: file.size,
    newSize: result.blob.size,
    extraPages,
  };
}

// ---------------------------------------------------------------------------
// Message plumbing
// ---------------------------------------------------------------------------

self.onmessage = async ({ data }) => {
  const { id, file, settings } = data;
  try {
    const result = await processFile(file, settings);
    self.postMessage({ id, ok: true, ...result });
  } catch (error) {
    // Surface something a designer can act on, not a stack trace.
    self.postMessage({ id, ok: false, error: friendlyError(error) });
  }
};

function friendlyError(error) {
  const message = String(error?.message ?? error);

  if (/Unsupported format|doesn't look like an image/i.test(message)) {
    return message.includes('Unsupported')
      ? "This image format isn't supported."
      : message;
  }
  if (/decode|corrupt|invalid|malformed/i.test(message)) {
    return 'This file appears to be damaged and could not be opened.';
  }
  if (/memory|allocat/i.test(message)) {
    return 'This image is too large to process in the browser.';
  }
  return 'Something went wrong while processing this image.';
}
