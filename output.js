// Where the compressed files go.
//
// Two paths, chosen by feature detection (never by sniffing the user agent):
//
//   Chrome / Edge  -- the File System Access API lets us write a `compressed/` subfolder
//                     straight into the folder the user picked. Originals untouched.
//   Safari / Firefox -- no such API, so we hand back a `compressed.zip` whose entries are
//                     prefixed `compressed/`, which unzips to the same shape.

import { zip } from './vendor/fflate.js';

export const canWriteFolders = typeof self.showDirectoryPicker === 'function';

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|tiff?|heic|heif|avif)$/i;

/**
 * Ask the user for a folder and return its image files plus the directory handle.
 * Only available when canWriteFolders is true.
 */
export async function pickFolder() {
  const dirHandle = await self.showDirectoryPicker({ mode: 'readwrite' });
  const files = [];

  for await (const entry of dirHandle.values()) {
    // Skip our own output folder. This is the bug that made the old Tkinter app
    // re-compress its own output on every subsequent run, degrading quality each time.
    if (entry.kind === 'directory') continue;
    if (!IMAGE_EXTENSIONS.test(entry.name)) continue;
    files.push(await entry.getFile());
  }

  return { dirHandle, files };
}

/**
 * Build output filenames, keeping the original base name (it matters for WordPress image
 * SEO) and resolving collisions. `a.jpg` and `a.png` both want to become `a.webp`, so the
 * second one gets `a-2.webp`.
 */
export function assignOutputNames(results) {
  const used = new Set();

  return results.map((result) => {
    const base = result.sourceName.replace(/\.[^.]+$/, '');
    const extension = result.keptOriginal
      ? (result.sourceName.match(/\.[^.]+$/)?.[0] ?? '').slice(1) || result.outputFormat
      : result.outputFormat;

    let name = `${base}.${extension}`;
    let counter = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}-${counter}.${extension}`;
      counter += 1;
    }
    used.add(name.toLowerCase());

    return { ...result, outputName: name };
  });
}

/**
 * Write results into a `compressed/` subfolder of the chosen directory.
 */
export async function writeToFolder(dirHandle, results, onProgress) {
  const outDir = await dirHandle.getDirectoryHandle('compressed', { create: true });
  let written = 0;

  for (const result of results) {
    const fileHandle = await outDir.getFileHandle(result.outputName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(result.blob);
    await writable.close();
    written += 1;
    onProgress?.(written, results.length);
  }

  return written;
}

/**
 * Build a ZIP and trigger a download. Used where the File System Access API is missing.
 */
export async function downloadZip(results, onProgress) {
  const entries = {};

  for (const result of results) {
    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    // Already-compressed image bytes don't deflate meaningfully, so store them raw --
    // it's dramatically faster and the ZIP comes out the same size either way.
    entries[`compressed/${result.outputName}`] = [buffer, { level: 0 }];
  }

  const zipped = await new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)));
  });

  onProgress?.(results.length, results.length);

  const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'compressed.zip';
  link.click();

  // Give the browser a moment to start the download before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  return results.length;
}
