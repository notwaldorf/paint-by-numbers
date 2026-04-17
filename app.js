// ─── State ──────────────────────────────────────────────────────────────────
let sourceImage = null;
let currentPalette = [];
let currentIndexMap = null; // Uint8Array: palette index per pixel (255 = transparent)
let currentWidth = 0;
let currentHeight = 0;

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

  const pixels = [];
  for (let i = 0; i < smallData.length; i += 4) {
    if (smallData[i+3] < 128) continue;
    pixels.push([smallData[i], smallData[i+1], smallData[i+2]]);
  }

  // Step 2: K-means
  setProgress(null, 'Running k-means…');
  await delay(30);
  const palette = await kMeans(pixels, k);

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
    indexMap[i] = nearestPalette(fullData[i*4], fullData[i*4+1], fullData[i*4+2], palette);
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
  const painted = previewToggle.checked;

  outputCanvas.width = W;
  outputCanvas.height = H;
  const ctx = outputCanvas.getContext('2d');

  // Base fill — either palette colours (painted) or white (blank template)
  const imgData = ctx.createImageData(W, H);
  const d = imgData.data;

  for (let i = 0; i < W * H; i++) {
    const pi = indexMap[i];
    if (pi === 255) {
      // Transparent source pixel → transparent output
      d[i*4] = 255; d[i*4+1] = 255; d[i*4+2] = 255; d[i*4+3] = 0;
      continue;
    }
    if (painted) {
      const c = palette[pi];
      d[i*4] = c[0]; d[i*4+1] = c[1]; d[i*4+2] = c[2];
    } else {
      d[i*4] = 255; d[i*4+1] = 255; d[i*4+2] = 255;
    }
    d[i*4+3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);

  // Overlays — outlines only shown in blank mode (painted preview stays clean)
  if (optOutlines.checked && !painted) drawOutlines(ctx, indexMap, W, H, painted);
  if (optNumbers.checked)              drawNumbers(ctx, indexMap, W, H, palette.length, painted);
}

// ─── K-means (k-means++ init, chunked iteration) ─────────────────────────────
function kMeans(pixels, k) {
  return new Promise(resolve => {
    // k-means++ initialisation
    const centroids = [pixels[Math.floor(Math.random() * pixels.length)].slice()];
    while (centroids.length < k) {
      const dists = pixels.map(p => {
        let minD = Infinity;
        for (const c of centroids) {
          const d = colorDistSq(p, c);
          if (d < minD) minD = d;
        }
        return minD;
      });
      const total = dists.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < dists.length; i++) {
        r -= dists[i];
        if (r <= 0) { centroids.push(pixels[i].slice()); break; }
      }
    }

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
        const ni = nearestPalette(p[0], p[1], p[2], centroids);
        sums[ni][0] += p[0];
        sums[ni][1] += p[1];
        sums[ni][2] += p[2];
        sums[ni][3]++;
      }

      for (let i = 0; i < k; i++) {
        if (sums[i][3] === 0) continue;
        const nr = Math.round(sums[i][0] / sums[i][3]);
        const ng = Math.round(sums[i][1] / sums[i][3]);
        const nb = Math.round(sums[i][2] / sums[i][3]);
        if (nr !== centroids[i][0] || ng !== centroids[i][1] || nb !== centroids[i][2]) changed = true;
        centroids[i] = [nr, ng, nb];
      }

      setTimeout(step, 0);
    }
    setTimeout(step, 0);
  });
}

function colorDistSq(a, b) {
  return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
}

function nearestPalette(r, g, b, palette) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = (r-palette[i][0])**2 + (g-palette[i][1])**2 + (b-palette[i][2])**2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
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
    entry.style.animationDelay = `${i * 40}ms`;
    entry.innerHTML = `
      <div class="swatch" style="background:${hex}"></div>
      <span class="palette-num">${i + 1}</span>
      <span>${hex}</span>
      <span class="palette-hex">rgb(${c[0]},${c[1]},${c[2]})</span>
    `;
    paletteList.appendChild(entry);
  });
  paletteSection.style.display = 'block';
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
  const mode = previewToggle.checked ? 'painted' : 'blank';
  a.download = `paint-by-numbers-${mode}.png`;
  a.href = outputCanvas.toDataURL('image/png');
  a.click();
});

// ─── Utility ─────────────────────────────────────────────────────────────────
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }