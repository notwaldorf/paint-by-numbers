// ─── State ──────────────────────────────────────────────────────────────────
let sourceImage = null;
let currentPalette = [];
let currentIndexMap = null; // Uint8Array: palette index per pixel (255 = transparent)
let currentWidth = 0;
let currentHeight = 0;
let highlightedIndex = -1;  // -1 = none, otherwise palette index to highlight in blank view

// ─── DOM refs ───────────────────────────────────────────────────────────────
const uploadZone    = document.getElementById('uploadZone');
const fileInput     = document.getElementById('fileInput');
const thumbPreview  = document.getElementById('thumbPreview');
const colourSlider  = document.getElementById('colourSlider');
const colourCountEl = document.getElementById('colourCountDisplay');
const smoothSlider  = document.getElementById('smoothSlider');
const smoothLabelEl = document.getElementById('smoothLabelDisplay');
const generateBtn   = document.getElementById('generateBtn');
const paletteSection= document.getElementById('paletteSection');
const paletteList   = document.getElementById('paletteList');
const emptyState    = document.getElementById('emptyState');
const progressWrap  = document.getElementById('progressWrap');
const progressLabel = document.getElementById('progressLabel');
const progressTrack = document.getElementById('progressTrack');
const progressFill  = document.getElementById('progressFill');
const toolbar       = document.getElementById('toolbar');
const outputWrapper = document.getElementById('outputWrapper');
const outputCanvas  = document.getElementById('outputCanvas');
const workCanvas    = document.getElementById('workCanvas');
const downloadBtn   = document.getElementById('downloadBtn');
const optOutlines   = document.getElementById('optOutlines');
const optNumbers    = document.getElementById('optNumbers');
const previewToggle = document.getElementById('previewToggle');

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
    sourceImage = img;
    thumbPreview.src = url;
    thumbPreview.style.display = 'block';
    generateBtn.disabled = false;
    // Clear previous output
    outputWrapper.style.display = 'none';
    toolbar.style.display = 'none';
    paletteSection.style.display = 'none';
    emptyState.style.display = 'flex';
    currentIndexMap = null;
    highlightedIndex = -1;
  };
  img.src = url;
}

// ─── Slider ──────────────────────────────────────────────────────────────────
colourSlider.addEventListener('input', () => {
  colourCountEl.textContent = colourSlider.value;
});

const smoothLabels = ['None', 'Light', 'Medium', 'Heavy'];
smoothSlider.addEventListener('input', () => {
  smoothLabelEl.textContent = smoothLabels[parseInt(smoothSlider.value)];
});

// ─── Generate ────────────────────────────────────────────────────────────────
generateBtn.addEventListener('click', () => {
  if (!sourceImage) return;
  runPaintByNumbers();
});

// ─── Option change listeners (redraw only, no re-cluster) ────────────────────
optOutlines.addEventListener('change', () => {
  if (currentIndexMap) redrawOutput();
});
optNumbers.addEventListener('change', () => {
  if (currentIndexMap) redrawOutput();
});
previewToggle.addEventListener('change', () => {
  // Manually flipping the painted/blank pill clears any colour highlight.
  if (highlightedIndex !== -1) {
    highlightedIndex = -1;
    updatePaletteSelectionUI();
  }
  if (currentIndexMap) redrawOutput();
});

// ─── Core algorithm ─────────────────────────────────────────────────────────
async function runPaintByNumbers() {
  generateBtn.disabled = true;
  emptyState.style.display = 'none';
  outputWrapper.style.display = 'none';
  toolbar.style.display = 'none';
  paletteSection.style.display = 'none';
  progressWrap.style.display = 'block';
  highlightedIndex = -1;

  const k = parseInt(colourSlider.value);

  // Step 1: Downscale for k-means sampling
  setProgress(null, 'Sampling colours…');
  await delay(30);

  const MAX_DIM = 200;
  const scale = Math.min(1, MAX_DIM / Math.max(sourceImage.width, sourceImage.height));
  const sw = Math.round(sourceImage.width * scale);
  const sh = Math.round(sourceImage.height * scale);

  workCanvas.width = sw;
  workCanvas.height = sh;
  const wctx = workCanvas.getContext('2d');
  wctx.drawImage(sourceImage, 0, 0, sw, sh);
  const smallData = wctx.getImageData(0, 0, sw, sh).data;

  // Collect sample pixels as LAB (perceptual space — k-means in LAB
  // produces palettes that match how the eye sees colour differences,
  // rather than RGB which over-weights green channel changes).
  const labPixels = [];
  for (let i = 0; i < smallData.length; i += 4) {
    if (smallData[i+3] < 128) continue;
    labPixels.push(rgbToLab(smallData[i], smallData[i+1], smallData[i+2]));
  }

  // Step 2: K-means in LAB, with extremes reserved
  setProgress(null, 'Running k-means…');
  await delay(30);
  const labPalette = await kMeansLab(labPixels, k);

  // Convert LAB palette → RGB for rendering, palette UI and downloads.
  const palette = labPalette.map(c => labToRgb(c[0], c[1], c[2]));

  // Step 3: Quantise full-res image (with optional pre-blur to reduce noise)
  setProgress(null, 'Quantising image…');
  await delay(30);

  const W = sourceImage.width;
  const H = sourceImage.height;
  workCanvas.width = W;
  workCanvas.height = H;
  wctx.drawImage(sourceImage, 0, 0, W, H);

  const smoothLevel = parseInt(smoothSlider.value); // 0 = none, 1 = light, 2 = medium, 3 = heavy

  // Pre-blur the source proportional to image size & smoothing level
  if (smoothLevel > 0) {
    const blurRadius = Math.max(1, Math.round(Math.min(W, H) / 400)) * smoothLevel;
    wctx.filter = `blur(${blurRadius}px)`;
    wctx.drawImage(sourceImage, 0, 0, W, H);
    wctx.filter = 'none';
  }
  const fullData = wctx.getImageData(0, 0, W, H).data;

  let indexMap = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (fullData[i*4 + 3] < 128) { indexMap[i] = 255; continue; }
    const lab = rgbToLab(fullData[i*4], fullData[i*4+1], fullData[i*4+2]);
    indexMap[i] = nearestPaletteLab(lab, labPalette);
  }

  // Step 4: Clean up noise — mode filter + small-region removal
  if (smoothLevel > 0) {
    setProgress(null, 'Simplifying regions…');
    await delay(30);

    // Apply mode filter (majority vote) — passes = smoothLevel
    for (let pass = 0; pass < smoothLevel; pass++) {
      indexMap = modeFilter(indexMap, W, H);
    }

    // Remove tiny regions — threshold scales with image size and smoothing
    const minRegionSize = Math.max(8, Math.round((W * H) / 2000)) * smoothLevel;
    indexMap = removeSmallRegions(indexMap, W, H, minRegionSize);
  }

  // Cache state for toggle
  currentPalette = palette;
  currentIndexMap = indexMap;
  currentWidth = W;
  currentHeight = H;

  setProgress(null, 'Drawing output…');
  await delay(30);

  // Initial render
  redrawOutput();

  // Palette UI
  renderPalette(palette);

  // Reveal
  progressWrap.style.display = 'none';
  outputWrapper.style.display = 'inline-block';
  toolbar.style.display = 'flex';
  paletteSection.style.display = 'block';
  generateBtn.disabled = false;
}

// ─── Redraw output based on current toggles ──────────────────────────────────
// Fast because k-means & quantisation are already done.
function redrawOutput() {
  if (!currentIndexMap) return;

  const W = currentWidth;
  const H = currentHeight;
  const palette = currentPalette;
  const indexMap = currentIndexMap;
  // Highlight mode overrides the painted/blank toggle: it's blank + one colour.
  const highlighting = highlightedIndex >= 0;
  const painted = highlighting ? false : previewToggle.checked;

  outputCanvas.width = W;
  outputCanvas.height = H;
  const ctx = outputCanvas.getContext('2d');

  // Base fill — either palette colours (painted) or white (blank template).
  // In highlight mode: white everywhere except the highlighted colour's regions.
  const imgData = ctx.createImageData(W, H);
  const d = imgData.data;

  for (let i = 0; i < W * H; i++) {
    const pi = indexMap[i];
    if (pi === 255) {
      // Transparent source pixel → transparent output
      d[i*4] = 255; d[i*4+1] = 255; d[i*4+2] = 255; d[i*4+3] = 0;
      continue;
    }
    if (highlighting) {
      if (pi === highlightedIndex) {
        const c = palette[pi];
        d[i*4] = c[0]; d[i*4+1] = c[1]; d[i*4+2] = c[2];
      } else {
        d[i*4] = 255; d[i*4+1] = 255; d[i*4+2] = 255;
      }
    } else if (painted) {
      const c = palette[pi];
      d[i*4] = c[0]; d[i*4+1] = c[1]; d[i*4+2] = c[2];
    } else {
      d[i*4] = 255; d[i*4+1] = 255; d[i*4+2] = 255;
    }
    d[i*4+3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);

  // Overlays — outlines shown in blank mode and in highlight mode
  // (so the user can see the regions to fill in).
  if (optOutlines.checked && !painted) drawOutlines(ctx, indexMap, W, H, painted);
  if (optNumbers.checked)              drawNumbers(ctx, indexMap, W, H, palette.length, painted);
}

// ─── K-means in LAB, with extremes reserved ─────────────────────────────────
// Operates entirely in LAB so distances are perceptual. The brightest and
// darkest pixels (by L*) get their own dedicated, FROZEN centroids — they
// are assigned during the E-step but never updated during the M-step. This
// guarantees the palette preserves true highlights and shadows instead of
// letting k-means drag them toward the colour mass.
function kMeansLab(pixels, k) {
  return new Promise(resolve => {
    // Decide how many centroids to reserve for extremes.
    // For very small palettes (k <= 3), reserve none — we can't spare them.
    // For k >= 4, reserve 1 bright + 1 dark = 2 frozen centroids.
    const reserveExtremes = k >= 4;
    const frozenCount = reserveExtremes ? 2 : 0;
    const movingCount = k - frozenCount;

    const frozen = [];
    if (reserveExtremes) {
      // Sample brightest ~0.5% and darkest ~0.5% by L*, then average each
      // group to a single centroid. Averaging (rather than picking one pixel)
      // gives a stable representative even if there's noise.
      const sorted = pixels.slice().sort((a, b) => a[0] - b[0]);
      const pct = Math.max(1, Math.floor(sorted.length * 0.005));
      frozen.push(averageLab(sorted.slice(0, pct)));            // darkest
      frozen.push(averageLab(sorted.slice(sorted.length - pct))); // brightest
    }

    // k-means++ init for the moving centroids, biased AWAY from the frozen
    // ones (so we don't waste a moving centroid right next to a frozen one).
    const moving = [];
    if (movingCount > 0) {
      moving.push(pixels[Math.floor(Math.random() * pixels.length)].slice());
      while (moving.length < movingCount) {
        const dists = pixels.map(p => {
          let minD = Infinity;
          for (const c of moving) {
            const d = labDistSq(p, c);
            if (d < minD) minD = d;
          }
          for (const c of frozen) {
            const d = labDistSq(p, c);
            if (d < minD) minD = d;
          }
          return minD;
        });
        const total = dists.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        for (let i = 0; i < dists.length; i++) {
          r -= dists[i];
          if (r <= 0) { moving.push(pixels[i].slice()); break; }
        }
      }
    }

    // All centroids in one array: frozen first, then moving.
    const centroids = [...frozen, ...moving];

    const maxIter = 30;
    const sample = pixels.length > 5000 ? sampleArray(pixels, 5000) : pixels;
    let changed = true;
    let iter = 0;

    function step() {
      if (!changed || iter >= maxIter) { resolve(centroids); return; }
      changed = false;
      iter++;

      const sums = Array.from({length: k}, () => [0, 0, 0, 0]);
      for (const p of sample) {
        const ni = nearestPaletteLab(p, centroids);
        sums[ni][0] += p[0];
        sums[ni][1] += p[1];
        sums[ni][2] += p[2];
        sums[ni][3]++;
      }

      // Update only the moving centroids; frozen ones stay put.
      for (let i = frozenCount; i < k; i++) {
        if (sums[i][3] === 0) continue;
        const nl = sums[i][0] / sums[i][3];
        const na = sums[i][1] / sums[i][3];
        const nb = sums[i][2] / sums[i][3];
        if (Math.abs(nl - centroids[i][0]) > 0.1 ||
            Math.abs(na - centroids[i][1]) > 0.1 ||
            Math.abs(nb - centroids[i][2]) > 0.1) changed = true;
        centroids[i] = [nl, na, nb];
      }

      setTimeout(step, 0);
    }
    setTimeout(step, 0);
  });
}

function averageLab(arr) {
  let l = 0, a = 0, b = 0;
  for (const p of arr) { l += p[0]; a += p[1]; b += p[2]; }
  return [l / arr.length, a / arr.length, b / arr.length];
}

function labDistSq(a, b) {
  return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
}

function nearestPaletteLab(lab, palette) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dl = lab[0] - palette[i][0];
    const da = lab[1] - palette[i][1];
    const db = lab[2] - palette[i][2];
    const d = dl*dl + da*da + db*db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ─── sRGB ↔ CIE L*a*b* conversion ───────────────────────────────────────────
// Goes via linear sRGB → XYZ (D65) → LAB. L* is roughly [0, 100],
// a* and b* roughly [-128, 127].
function rgbToLab(r, g, b) {
  // sRGB → linear
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  // linear → XYZ (D65)
  let X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  let Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  let Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  // Normalise by D65 reference white
  X /= 0.95047; Y /= 1.00000; Z /= 1.08883;
  // XYZ → LAB
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb(L, a, b) {
  // LAB → XYZ
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const finv = t => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  let X = finv(fx) * 0.95047;
  let Y = finv(fy) * 1.00000;
  let Z = finv(fz) * 1.08883;
  // XYZ → linear sRGB
  let R = X *  3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  let G = X * -0.9692660 + Y *  1.8760108 + Z *  0.0415560;
  let B = X *  0.0556434 + Y * -0.2040259 + Z *  1.0572252;
  // linear → sRGB
  const enc = c => c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
  R = enc(R); G = enc(G); B = enc(B);
  return [
    Math.max(0, Math.min(255, Math.round(R * 255))),
    Math.max(0, Math.min(255, Math.round(G * 255))),
    Math.max(0, Math.min(255, Math.round(B * 255))),
  ];
}

function sampleArray(arr, n) {
  const step = Math.floor(arr.length / n);
  const out = [];
  for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]);
  return out;
}

// ─── Smoothing: mode filter ──────────────────────────────────────────────────
// For each pixel, replace with the most common value in its 3x3 neighbourhood.
// This aggressively removes isolated speckles and single-pixel noise.
function modeFilter(indexMap, W, H) {
  const out = new Uint8Array(W * H);
  const counts = new Map();

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (indexMap[i] === 255) { out[i] = 255; continue; }

      counts.clear();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
          const v = indexMap[ny * W + nx];
          if (v === 255) continue;
          counts.set(v, (counts.get(v) || 0) + 1);
        }
      }

      let best = indexMap[i], bestC = -1;
      for (const [v, c] of counts) {
        if (c > bestC) { bestC = c; best = v; }
      }
      out[i] = best;
    }
  }
  return out;
}

// ─── Smoothing: remove small connected regions ───────────────────────────────
// Flood-fill labels every connected region; any region smaller than minSize
// is replaced by the colour of its largest neighbouring region.
function removeSmallRegions(indexMap, W, H, minSize) {
  const labels = new Int32Array(W * H).fill(-1);
  const regions = []; // { pixels: [], colour: 0 }
  const queue = new Int32Array(W * H);

  // BFS flood fill to label all regions
  let nextLabel = 0;
  for (let i = 0; i < W * H; i++) {
    if (labels[i] !== -1 || indexMap[i] === 255) continue;
    const colour = indexMap[i];
    const pixels = [];
    let qHead = 0, qTail = 0;
    queue[qTail++] = i;
    labels[i] = nextLabel;

    while (qHead < qTail) {
      const p = queue[qHead++];
      pixels.push(p);
      const x = p % W, y = (p - x) / W;
      // 4-connected neighbours
      if (x > 0) {
        const n = p - 1;
        if (labels[n] === -1 && indexMap[n] === colour) { labels[n] = nextLabel; queue[qTail++] = n; }
      }
      if (x < W - 1) {
        const n = p + 1;
        if (labels[n] === -1 && indexMap[n] === colour) { labels[n] = nextLabel; queue[qTail++] = n; }
      }
      if (y > 0) {
        const n = p - W;
        if (labels[n] === -1 && indexMap[n] === colour) { labels[n] = nextLabel; queue[qTail++] = n; }
      }
      if (y < H - 1) {
        const n = p + W;
        if (labels[n] === -1 && indexMap[n] === colour) { labels[n] = nextLabel; queue[qTail++] = n; }
      }
    }
    regions.push({ pixels, colour });
    nextLabel++;
  }

  // Iteratively absorb small regions into their largest neighbour
  // (repeat a few times so chains of small regions get cleaned up properly)
  const out = new Uint8Array(indexMap);
  for (let pass = 0; pass < 3; pass++) {
    let merged = false;
    for (const region of regions) {
      if (region.pixels.length === 0 || region.pixels.length >= minSize) continue;

      // Count neighbouring colours by adjacency area
      const neighbourCounts = new Map();
      for (const p of region.pixels) {
        const x = p % W, y = (p - x) / W;
        const candidates = [];
        if (x > 0) candidates.push(p - 1);
        if (x < W - 1) candidates.push(p + 1);
        if (y > 0) candidates.push(p - W);
        if (y < H - 1) candidates.push(p + W);
        for (const n of candidates) {
          const c = out[n];
          if (c === 255 || c === region.colour) continue;
          neighbourCounts.set(c, (neighbourCounts.get(c) || 0) + 1);
        }
      }

      if (neighbourCounts.size === 0) continue;
      let bestC = -1, bestCount = -1;
      for (const [c, ct] of neighbourCounts) {
        if (ct > bestCount) { bestCount = ct; bestC = c; }
      }

      // Repaint this region
      for (const p of region.pixels) out[p] = bestC;
      region.colour = bestC;
      region.pixels = []; // mark as absorbed
      merged = true;
    }
    if (!merged) break;
  }

  return out;
}

// ─── Outline drawing ─────────────────────────────────────────────────────────
function drawOutlines(ctx, indexMap, W, H, painted) {
  // Paint outlines directly into a new imageData layer, then composite
  const outlineImg = ctx.getImageData(0, 0, W, H);
  const d = outlineImg.data;

  // In painted mode: darker outlines (semi-opaque black)
  // In blank mode: solid black outlines
  const alpha = painted ? 170 : 230;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const cur = indexMap[i];
      if (cur === 255) continue;
      const isEdge =
        (x+1 < W && indexMap[i+1] !== cur && indexMap[i+1] !== 255) ||
        (y+1 < H && indexMap[i+W] !== cur && indexMap[i+W] !== 255) ||
        (x-1 >= 0 && indexMap[i-1] !== cur && indexMap[i-1] !== 255) ||
        (y-1 >= 0 && indexMap[i-W] !== cur && indexMap[i-W] !== 255);
      if (isEdge) {
        // Blend black over existing pixel
        const a = alpha / 255;
        d[i*4]   = Math.round(d[i*4]   * (1-a));
        d[i*4+1] = Math.round(d[i*4+1] * (1-a));
        d[i*4+2] = Math.round(d[i*4+2] * (1-a));
        d[i*4+3] = 255;
      }
    }
  }
  ctx.putImageData(outlineImg, 0, 0);
}

// ─── Number labels ──────────────────────────────────────────────────────────
function drawNumbers(ctx, indexMap, W, H, k, painted) {
  const regionPoints = findRegionCentroids(indexMap, W, H, k);
  const fontSize = Math.max(11, Math.min(28, Math.floor(Math.min(W, H) / 28)));

  ctx.save();
  ctx.font = `bold ${fontSize}px 'DM Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const [pi, pts] of regionPoints.entries()) {
    if (!pts || pts.length === 0) continue;
    for (const {x, y} of pts) {
      const label = String(pi + 1);
      if (painted) {
        // Painted mode: subtle light halo + dark text
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(x - fontSize*0.42, y - fontSize*0.55, fontSize*0.85, fontSize*1.05);
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
      } else {
        // Blank mode: just crisp black numbers
        ctx.fillStyle = '#000';
      }
      ctx.fillText(label, x, y + 1);
    }
  }
  ctx.restore();
}

function findRegionCentroids(indexMap, W, H, k) {
  const GRID = Math.max(20, Math.floor(Math.min(W, H) / 15));
  const results = new Map();

  for (let cy = GRID; cy < H - GRID; cy += GRID * 2) {
    for (let cx = GRID; cx < W - GRID; cx += GRID * 2) {
      const counts = new Array(k).fill(0);
      let total = 0;
      for (let dy = -GRID; dy <= GRID; dy++) {
        for (let dx = -GRID; dx <= GRID; dx++) {
          const y = cy + dy, x = cx + dx;
          if (y < 0 || y >= H || x < 0 || x >= W) continue;
          const pi = indexMap[y * W + x];
          if (pi < k) { counts[pi]++; total++; }
        }
      }
      if (total === 0) continue;
      let best = 0, bestC = 0;
      for (let i = 0; i < k; i++) if (counts[i] > bestC) { bestC = counts[i]; best = i; }
      if (bestC / total < 0.6) continue;
      if (!results.has(best)) results.set(best, []);
      results.get(best).push({x: cx, y: cy});
    }
  }
  return results;
}

// ─── Palette UI ──────────────────────────────────────────────────────────────
function renderPalette(palette) {
  paletteList.innerHTML = '';
  palette.forEach((c, i) => {
    const hex = rgbToHex(c[0], c[1], c[2]);
    const entry = document.createElement('div');
    entry.className = 'palette-entry';
    entry.dataset.index = i;
    entry.style.animationDelay = `${i * 40}ms`;
    entry.innerHTML = `
      <div class="swatch" style="background:${hex}"></div>
      <span class="palette-num">${i + 1}</span>
      <span>${hex}</span>
      <span class="palette-hex">rgb(${c[0]},${c[1]},${c[2]})</span>
    `;
    entry.addEventListener('click', () => togglePaletteHighlight(i));
    paletteList.appendChild(entry);
  });
  paletteSection.style.display = 'block';
  updatePaletteSelectionUI();
}

// Toggle highlight: clicking the active colour clears it, clicking another switches.
function togglePaletteHighlight(i) {
  highlightedIndex = (highlightedIndex === i) ? -1 : i;
  updatePaletteSelectionUI();
  redrawOutput();
}

// Apply 'selected' / 'dimmed' classes to palette entries based on highlightedIndex.
function updatePaletteSelectionUI() {
  const entries = paletteList.querySelectorAll('.palette-entry');
  entries.forEach(el => {
    const idx = parseInt(el.dataset.index);
    el.classList.toggle('selected', idx === highlightedIndex);
    el.classList.toggle('dimmed', highlightedIndex >= 0 && idx !== highlightedIndex);
  });
}

// ─── Progress helper ─────────────────────────────────────────────────────────
function setProgress(pct, label) {
  progressLabel.textContent = label || 'Processing…';
  if (pct === null) {
    progressTrack.classList.add('progress-indeterminate');
    progressFill.style.width = '40%';
  } else {
    progressTrack.classList.remove('progress-indeterminate');
    progressFill.style.width = pct + '%';
  }
}

// ─── Download ────────────────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  let mode;
  if (highlightedIndex >= 0) mode = `colour-${highlightedIndex + 1}`;
  else mode = previewToggle.checked ? 'painted' : 'blank';
  a.download = `paint-by-numbers-${mode}.png`;
  a.href = outputCanvas.toDataURL('image/png');
  a.click();
});

// ─── Utility ─────────────────────────────────────────────────────────────────
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }