// UI state, the worker pool, and the glue between them.

import {
  canWriteFolders, pickFolder, assignOutputNames, writeToFolder, downloadZip, downloadFile,
} from './output.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const PRESETS = {
  web:  { maxDimension: 3000, quality: 82, label: 'Web' },
  high: { maxDimension: 3000, quality: 90, label: 'High quality' },
  max:  { maxDimension: 2000, quality: 70, label: 'Maximum compression' },
};

const settings = { ...PRESETS.web, format: 'image/webp' };

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  modeNotice: $('mode-notice'),
  chooseFolder: $('choose-folder'),
  chooseFiles: $('choose-files'),
  fileInput: $('file-input'),
  dirInput: $('dir-input'),
  presets: document.querySelectorAll('.preset'),
  readoutSettings: $('settings-readout'),
  maxDimension: $('max-dimension'),
  quality: $('quality'),
  qualityValue: $('quality-value'),
  formats: document.querySelectorAll('input[name="format"]'),
  readout: $('readout'),
  totalBefore: $('total-before'),
  totalAfter: $('total-after'),
  totalSaved: $('total-saved'),
  totalCount: $('total-count'),
  totalFill: $('total-fill'),
  actions: $('actions'),
  save: $('save'),
  clear: $('clear'),
  ledger: $('ledger'),
  ledgerList: $('ledger-list'),
  rowTemplate: $('row-template'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{file: File, name: string, node: HTMLElement, result: object|null, error: string|null}[]} */
let items = [];
let directoryHandle = null;   // set only when the user picked a folder we can write back to
let running = false;
let runToken = 0;             // bumped on every new run so stale results are ignored
const objectUrls = new Set();

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function trackUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

function releaseUrls() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function syncSettingsUI() {
  els.maxDimension.value = settings.maxDimension;
  els.quality.value = settings.quality;
  els.qualityValue.textContent = settings.quality;
  const formatName = settings.format === 'image/webp' ? 'WebP' : 'JPEG';
  els.readoutSettings.textContent =
    `${settings.maxDimension} px · ${formatName} · quality ${settings.quality}`;
}

function markActivePreset() {
  // A preset is "active" only while the values still match it -- nudging a slider
  // silently out of a named preset would be lying to the user.
  const match = Object.entries(PRESETS).find(([, preset]) =>
    preset.maxDimension === settings.maxDimension && preset.quality === settings.quality);

  els.presets.forEach((button) => {
    button.classList.toggle('is-active', Boolean(match) && button.dataset.preset === match[0]);
  });
}

function applySettingChange() {
  syncSettingsUI();
  markActivePreset();
  if (items.length) run();
}

els.presets.forEach((button) => {
  button.addEventListener('click', () => {
    Object.assign(settings, PRESETS[button.dataset.preset]);
    applySettingChange();
  });
});

els.maxDimension.addEventListener('change', () => {
  const value = Number(els.maxDimension.value);
  settings.maxDimension = Number.isFinite(value) ? Math.min(12000, Math.max(200, value)) : 3000;
  applySettingChange();
});

els.quality.addEventListener('input', () => {
  els.qualityValue.textContent = els.quality.value;
});

els.quality.addEventListener('change', () => {
  settings.quality = Number(els.quality.value);
  applySettingChange();
});

els.formats.forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    settings.format = radio.value;
    applySettingChange();
  });
});

// ---------------------------------------------------------------------------
// Worker pool
//
// Capped deliberately. Decoding a dozen 50 MP photos at once is the quickest way to
// exhaust the tab's memory, and the extra parallelism buys nothing once every core is busy.
// ---------------------------------------------------------------------------

const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const pool = [];

function getWorkers() {
  while (pool.length < POOL_SIZE) {
    pool.push(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
  }
  return pool;
}

function processOn(worker, file) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);

    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve(data);
    };

    // A worker-level error (rather than a rejected promise inside it) means the worker is
    // in an unknown state. Report the file as failed and let the pool carry on.
    const onError = (event) => {
      event.preventDefault();
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve({ id, ok: false, error: 'Something went wrong while processing this image.' });
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ id, file, settings: { ...settings } });
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function createRow(item) {
  const node = els.rowTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector('.row__name').textContent = item.name;
  node.querySelector('.row__stats').textContent = `${formatBytes(item.file.size)} · waiting`;
  node.classList.add('is-working');
  els.ledgerList.append(node);
  return node;
}

function renderResult(item) {
  const { node, result, error } = item;
  node.classList.remove('is-working');

  const stats = node.querySelector('.row__stats');
  const delta = node.querySelector('.row__delta');

  if (error) {
    node.classList.add('is-error');
    stats.textContent = error;
    delta.textContent = 'Skipped';
    return;
  }

  const img = node.querySelector('.row__thumb img');
  if (result.thumbnail) img.src = trackUrl(result.thumbnail);

  const dimensions = result.width === result.sourceWidth && result.height === result.sourceHeight
    ? `${result.width}×${result.height}`
    : `${result.sourceWidth}×${result.sourceHeight} → ${result.width}×${result.height}`;

  const notes = [];
  if (result.extraPages > 0) {
    notes.push(`first of ${result.extraPages + 1} pages`);
  }

  if (result.keptOriginal) {
    // Re-encoding made it bigger, so the original bytes were kept. Say so plainly --
    // a silent no-op looks like a bug.
    node.classList.add('is-kept');
    stats.textContent = [`${formatBytes(result.originalSize)} · already small enough`, ...notes].join(' · ');
    delta.textContent = 'Kept as-is';
    node.querySelector('.row__fill').style.width = '100%';
    return;
  }

  // Cap at 99: a genuine 99.8% reduction rounds to 100%, which reads as "the file vanished".
  const percent = Math.min(99, Math.round((1 - result.newSize / result.originalSize) * 100));
  stats.textContent = [
    `${formatBytes(result.originalSize)} → ${formatBytes(result.newSize)}`,
    dimensions,
    ...notes,
  ].join(' · ');
  // A conversion can legitimately grow the file -- a small HEIC is denser than any WebP we
  // can produce -- but it still had to be converted to be usable on the site. Show that
  // honestly rather than dressing it up as a saving.
  node.classList.toggle('is-grown', percent <= 0);
  delta.textContent = percent > 0 ? `−${percent}%` : `+${Math.abs(percent)}%`;
  node.querySelector('.row__fill').style.width = `${(result.newSize / result.originalSize) * 100}%`;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function updateTotals() {
  const done = items.filter((item) => item.result);
  const failed = items.filter((item) => item.error);

  if (!done.length) {
    els.totalBefore.textContent = '—';
    els.totalAfter.textContent = '—';
    els.totalSaved.textContent = '';
    els.totalCount.textContent = failed.length ? `${failed.length} skipped` : '';
    els.totalFill.style.width = '0';
    return;
  }

  const before = done.reduce((sum, item) => sum + item.result.originalSize, 0);
  const after = done.reduce((sum, item) => sum + item.result.newSize, 0);
  const percent = before ? Math.min(99, Math.round((1 - after / before) * 100)) : 0;

  els.totalBefore.textContent = formatBytes(before);
  els.totalAfter.textContent = formatBytes(after);
  els.totalSaved.textContent = `${percent}% smaller`;
  els.totalCount.textContent = [
    `${done.length} image${done.length === 1 ? '' : 's'}`,
    failed.length ? `${failed.length} skipped` : '',
  ].filter(Boolean).join(' · ');
  els.totalFill.style.width = `${before ? (after / before) * 100 : 0}%`;
}

function updateSaveButton() {
  const ready = items.filter((item) => item.result).length;
  els.save.disabled = running || ready === 0;

  if (running) {
    els.save.textContent = 'Compressing…';
  } else if (directoryHandle) {
    els.save.textContent = `Save ${ready} image${ready === 1 ? '' : 's'} to compressed folder`;
  } else if (ready === 1) {
    els.save.textContent = 'Download image';
  } else {
    els.save.textContent = `Download ${ready} images as ZIP`;
  }
}

// ---------------------------------------------------------------------------
// Running a batch
// ---------------------------------------------------------------------------

async function run() {
  const token = ++runToken;
  running = true;
  releaseUrls();

  els.ledgerList.replaceChildren();
  els.readout.hidden = false;
  els.actions.hidden = false;
  els.ledger.hidden = false;

  for (const item of items) {
    item.result = null;
    item.error = null;
    item.node = createRow(item);
  }

  updateTotals();
  updateSaveButton();

  const queue = items.slice();

  await Promise.all(getWorkers().map(async (worker) => {
    while (queue.length) {
      if (token !== runToken) return;
      const item = queue.shift();
      const data = await processOn(worker, item.file);
      if (token !== runToken) return;

      if (data.ok) {
        item.result = data;
      } else {
        item.error = data.error;
      }

      renderResult(item);
      updateTotals();
    }
  }));

  if (token !== runToken) return;

  running = false;
  updateSaveButton();
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

const ACCEPTED = /\.(jpe?g|png|webp|gif|tiff?|heic|heif|avif)$/i;

function acceptFiles(files, handle = null) {
  const usable = Array.from(files).filter((file) => ACCEPTED.test(file.name) || file.type.startsWith('image/'));

  if (!usable.length) {
    els.modeNotice.textContent = 'No images found in that selection';
    return;
  }

  directoryHandle = handle;
  items = usable.map((file) => ({ file, name: file.name, node: null, result: null, error: null }));
  updateModeNotice();
  run();
}

function updateModeNotice() {
  if (directoryHandle) {
    els.modeNotice.textContent = 'Saving into a compressed folder';
  } else if (items.length) {
    els.modeNotice.textContent = 'Saving as a ZIP download';
  } else {
    els.modeNotice.textContent = canWriteFolders
      ? 'Choose a folder to save alongside your originals'
      : 'This browser saves results as a ZIP';
  }
}

els.chooseFolder.addEventListener('click', async () => {
  if (canWriteFolders) {
    try {
      const { dirHandle, files } = await pickFolder();
      if (!files.length) {
        els.modeNotice.textContent = 'That folder has no images in it';
        return;
      }
      acceptFiles(files, dirHandle);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        els.modeNotice.textContent = 'Could not open that folder';
      }
    }
  } else {
    // Safari and Firefox: read the folder, but results come back as a ZIP.
    els.dirInput.click();
  }
});

els.chooseFiles.addEventListener('click', () => els.fileInput.click());

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) acceptFiles(els.fileInput.files);
  els.fileInput.value = '';
});

els.dirInput.addEventListener('change', () => {
  if (els.dirInput.files.length) {
    // Ignore anything already inside a compressed/ folder, so a second pass over the same
    // folder doesn't re-compress previous output.
    const fresh = Array.from(els.dirInput.files)
      .filter((file) => !/(^|\/)compressed\//i.test(file.webkitRelativePath || ''));
    acceptFiles(fresh);
  }
  els.dirInput.value = '';
});

// --- Drag and drop ---------------------------------------------------------

let dragDepth = 0;

document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  document.body.classList.add('is-dragging');
});

document.addEventListener('dragover', (event) => event.preventDefault());

document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('is-dragging');
});

document.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');

  const dropped = Array.from(event.dataTransfer.items ?? []);

  // Read the drag data store up front. It is emptied the moment this handler yields, so
  // anything still needed after an await -- the loose files, the handle request -- has to
  // be taken while we are still synchronous.
  const droppedFiles = Array.from(event.dataTransfer.files ?? []);

  // In Chrome, dropping a folder can hand us a real directory handle -- which means we can
  // write the compressed/ subfolder right back into it, exactly as if it had been picked.
  // A single dropped image arrives here too, and is indistinguishable until the handle
  // resolves, so ask for it and check the kind afterwards.
  const handlePromise = canWriteFolders && dropped.length === 1 && dropped[0].kind === 'file'
      && typeof dropped[0].getAsFileSystemHandle === 'function'
    ? dropped[0].getAsFileSystemHandle()
    : null;

  if (handlePromise) {
    try {
      const handle = await handlePromise;
      if (handle?.kind === 'directory') {
        const permission = await handle.requestPermission({ mode: 'readwrite' });
        const files = [];
        for await (const entry of handle.values()) {
          if (entry.kind !== 'file' || !ACCEPTED.test(entry.name)) continue;
          files.push(await entry.getFile());
        }
        if (files.length) {
          acceptFiles(files, permission === 'granted' ? handle : null);
          return;
        }
        els.modeNotice.textContent = 'That folder has no images in it';
        return;
      }
    } catch {
      // Fall through to the plain file list below.
    }
  }

  // One image, a handful of images, or a folder we could not get a handle for.
  if (droppedFiles.length) {
    acceptFiles(droppedFiles);
    return;
  }

  els.modeNotice.textContent = 'Nothing to compress in that drop';
});

// Keep the panel highlight in sync with the veil.
els.dropzone.addEventListener('dragenter', () => els.dropzone.classList.add('is-hot'));
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('is-hot'));
document.addEventListener('drop', () => els.dropzone.classList.remove('is-hot'));

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

els.save.addEventListener('click', async () => {
  const ready = assignOutputNames(
    items
      .filter((item) => item.result)
      .map((item) => ({ ...item.result, sourceName: item.name })),
  );

  if (!ready.length) return;

  els.save.disabled = true;
  const original = els.save.textContent;

  try {
    if (directoryHandle) {
      await writeToFolder(directoryHandle, ready, (written, total) => {
        els.save.textContent = `Saving ${written} of ${total}…`;
      });
      els.save.textContent = `Saved ${ready.length} to compressed folder`;
    } else if (ready.length === 1) {
      await downloadFile(ready[0]);
      els.save.textContent = 'Downloaded';
    } else {
      await downloadZip(ready);
      els.save.textContent = 'Downloaded';
    }
  } catch (error) {
    els.save.textContent = error?.name === 'AbortError' ? original : 'Could not save — try again';
    els.save.disabled = false;
    return;
  }

  setTimeout(() => { updateSaveButton(); }, 4000);
});

els.clear.addEventListener('click', () => {
  runToken += 1;
  running = false;
  items = [];
  directoryHandle = null;
  releaseUrls();
  els.ledgerList.replaceChildren();
  els.readout.hidden = true;
  els.actions.hidden = true;
  els.ledger.hidden = true;
  updateModeNotice();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

syncSettingsUI();
markActivePreset();
updateModeNotice();

if (!canWriteFolders) {
  els.chooseFolder.textContent = 'Choose folder';
}
