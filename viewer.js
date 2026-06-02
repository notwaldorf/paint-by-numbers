// ─── State ──────────────────────────────────────────────────────────────────
let originalImageData = null;  // ImageData of the loaded image (full res)
let imgWidth = 0;
let imgHeight = 0;
let isolatedMask = null;       // Uint8Array (1 byte/pixel): 1 = in region, 0 = not
let isolatedColour = null;     // [r, g, b] of the clicked-on region, or null

// ─── DOM refs ───────────────────────────────────────────────────────────────
const uploadState     = document.getElementById('uploadState');
const uploadZone      = document.getElementById('uploadZone');
const fileInput       = document.getElementById('fileInput');
const viewerToolbar   = document.getElementById('viewerToolbar');
const viewerCanvas    = document.getElementById('viewerCanvas');
const newImageBtn     = document.getElementById('newImageBtn');
const toleranceSlider = document.getElementById('toleranceSlider');
const toleranceValue  = document.getElementById('toleranceValue');
const clearBtn        = document.getElementById('clearBtn');
const downloadBtn     = document.getElementById('downloadBtn');
const swatchReadout   = document.getElementById('swatchReadout');
const swatchColour    = document.getElementById('swatchColour');
const swatchHex       = document.getElementById('swatchHex');

// ─── Upload handling ─────────────────────────────────────────────────────────
uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

function loadFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    imgWidth = img.naturalWidth;
    imgHeight = img.naturalHeight;
    viewerCanvas.width = imgWidth;
    viewerCanvas.height = imgHeight;
    const ctx = viewerCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    originalImageData = ctx.getImageData(0, 0, imgWidth, imgHeight);
    isolatedMask = null;
    isolatedColour = null;

    // Swap to viewer mode.
    uploadState.style.display = 'none';
    viewerToolbar.style.display = 'flex';
    viewerCanvas.style.display = 'block';
    viewerCanvas.classList.remove('no-image');
    swatchReadout.style.display = 'none';
    clearBtn.style.display = 'none';
    downloadBtn.style.display = 'inline-block';

    URL.revokeObjectURL(url);
  };
  img.src = url;
}

newImageBtn.addEventListener('click', () => {
  // Reset back to upload state. Keep the file input value cleared so the
  // same file can be re-selected if the user wants to.
  fileInput.value = '';
  originalImageData = null;
  isolatedMask = null;
  isolatedColour = null;
  uploadState.style.display = 'block';
  viewerToolbar.style.display = 'none';
  viewerCanvas.style.display = 'none';
  viewerCanvas.classList.add('no-image');
});

// ─── Tolerance slider ───────────────────────────────────────────────────────
toleranceSlider.addEventListener('input', () => {
  toleranceValue.textContent = toleranceSlider.value;
  // Re-run the match with the new tolerance, against the same stored seed
  // colour. (With the old flood-fill we cleared the selection here because
  // we no longer had the original click position — the global match doesn't
  // need one, so we can live-update.)
  if (isolatedMask && isolatedColour) {
    const [sr, sg, sb] = isolatedColour;
    isolatedMask = matchColour(
      originalImageData.data, imgWidth, imgHeight,
      sr, sg, sb, parseInt(toleranceSlider.value)
    );
    renderIsolated();
  }
});

// ─── Canvas click → match all pixels of that colour ─────────────────────────
viewerCanvas.addEventListener('click', e => {
  if (!originalImageData) return;
  const rect = viewerCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  // Translate CSS-pixel click → canvas-pixel coords. The canvas is styled
  // max-width: 100%, so its rendered size is usually smaller than its
  // intrinsic resolution.
  const x = Math.floor((e.clientX - rect.left) * (imgWidth  / rect.width));
  const y = Math.floor((e.clientY - rect.top)  * (imgHeight / rect.height));
  if (x < 0 || y < 0 || x >= imgWidth || y >= imgHeight) return;

  // Read the seed pixel colour.
  const data = originalImageData.data;
  const seedIdx = (y * imgWidth + x) * 4;
  const sr = data[seedIdx], sg = data[seedIdx+1], sb = data[seedIdx+2], sa = data[seedIdx+3];
  // Clicking on a transparent pixel does nothing — there's no colour there.
  if (sa < 128) return;

  // If the user clicked inside the currently-isolated region, treat that
  // as "clear" (mirrors the palette-toggle UX in the main app).
  if (isolatedMask && isolatedMask[y * imgWidth + x]) {
    clearIsolation();
    return;
  }

  isolatedColour = [sr, sg, sb];
  isolatedMask = matchColour(data, imgWidth, imgHeight, sr, sg, sb, parseInt(toleranceSlider.value));
  renderIsolated();
  showSwatch(sr, sg, sb);
});

// Esc clears the isolation.
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && isolatedMask) clearIsolation();
});

clearBtn.addEventListener('click', clearIsolation);

function clearIsolation() {
  isolatedMask = null;
  isolatedColour = null;
  // Restore the original image.
  const ctx = viewerCanvas.getContext('2d');
  ctx.putImageData(originalImageData, 0, 0);
  swatchReadout.style.display = 'none';
  clearBtn.style.display = 'none';
}

function showSwatch(r, g, b) {
  const hex = rgbToHex(r, g, b);
  swatchColour.style.background = hex;
  swatchHex.textContent = hex;
  swatchReadout.style.display = 'inline-flex';
  clearBtn.style.display = 'inline-block';
}

// ─── Colour match ───────────────────────────────────────────────────────────
// Single pass over the image: mark every non-transparent pixel whose colour
// is within `tolerance` of the seed RGB. This is the "magic wand: contiguous
// OFF" behaviour — disconnected patches of the same paint-by-numbers colour
// are all selected, which is the intent for a flat-colour PBN image.
//
// Tolerance is compared as squared RGB distance (summed over 3 channels)
// against `tolerance*tolerance*3`. Squared distance is fine for flat-colour
// regions; the tolerance only needs to absorb anti-aliased edges and JPEG
// ringing.
function matchColour(data, W, H, sr, sg, sb, tolerance) {
  const N = W * H;
  const mask = new Uint8Array(N);
  const tolSq = tolerance * tolerance * 3;
  for (let i = 0; i < N; i++) {
    const di = i * 4;
    if (data[di+3] < 128) continue; // transparent
    const dr = data[di]   - sr;
    const dg = data[di+1] - sg;
    const db = data[di+2] - sb;
    if (dr*dr + dg*dg + db*db <= tolSq) mask[i] = 1;
  }
  return mask;
}

// ─── Render the isolated view ───────────────────────────────────────────────
// Region pixels keep their original colour at full strength. Everything else
// is faded toward white so you can still see where the matched regions sit
// in context. FADE = how much of the original colour to keep (0 = pure white,
// 1 = unchanged). Transparent pixels stay transparent.
const FADE = 0.20;
function renderIsolated() {
  const ctx = viewerCanvas.getContext('2d');
  const out = ctx.createImageData(imgWidth, imgHeight);
  const src = originalImageData.data;
  const dst = out.data;
  const invFade255 = (1 - FADE) * 255;
  for (let i = 0; i < imgWidth * imgHeight; i++) {
    const di = i * 4;
    if (src[di+3] < 128) {
      // preserve transparency
      dst[di+3] = 0;
      continue;
    }
    if (isolatedMask[i]) {
      dst[di]   = src[di];
      dst[di+1] = src[di+1];
      dst[di+2] = src[di+2];
    } else {
      // Blend toward white: out = src*FADE + 255*(1-FADE)
      dst[di]   = src[di]   * FADE + invFade255;
      dst[di+1] = src[di+1] * FADE + invFade255;
      dst[di+2] = src[di+2] * FADE + invFade255;
    }
    dst[di+3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

// ─── Download ────────────────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  const suffix = isolatedColour
    ? `isolated-${rgbToHex(...isolatedColour).slice(1)}`
    : 'full';
  a.download = `region-${suffix}.png`;
  a.href = viewerCanvas.toDataURL('image/png');
  a.click();
});

// ─── Utility ─────────────────────────────────────────────────────────────────
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}