import * as THREE from 'three';
import './style.css';
import { AudioReactive } from './audio/AudioReactive';
import {
  BLOB_CONFIG_DEFAULTS,
  BLOB_DETECTION_SLIDERS,
  BLOB_LENS_SLIDERS,
  BLOB_LOOK_SLIDERS,
  BLOB_LOOK_TOGGLES,
  BLOB_MATRIX_SLIDERS,
  type BlobConfig,
  type BlobConfigSlider,
} from './core/blobConfig';
import { HandTracker } from './core/HandTracker';
import { PersonSegmenter } from './core/PersonSegmenter';
import { PresenceSensor } from './core/PresenceSensor';
import { BlobCompositor } from './modes/BlobCompositor';
import { ReactiveParticleField } from './render/particles/ReactiveParticleField';
import {
  VISUAL_PRESETS,
  loadStoredPresetId,
  presetIdFromKey,
  storePresetId,
  type VisualPresetId,
} from './render/particles/visualPresets';

function sliderRows(sliders: BlobConfigSlider[], dataAttr: string): string {
  return sliders
    .map(
      (s) => `
      <label class="vj-row">
        <span class="vj-label">${s.label}</span>
        <input type="range" data-${dataAttr}-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
        <span class="vj-val" data-${dataAttr}-val="${s.key}"></span>
      </label>`,
    )
    .join('');
}

function toggleRows(): string {
  return BLOB_LOOK_TOGGLES.map(
    (t) => `
    <label class="vj-toggle">
      <input type="checkbox" data-blob-key="${t.key}" />
      <span>${t.label}</span>
    </label>`,
  ).join('');
}

function presetHotkeyHint(p: (typeof VISUAL_PRESETS)[number], index: number): string {
  if (p.id === 'blob') return `${index + 1} / B`;
  return String(index + 1);
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <canvas class="stage"></canvas>
  <div class="blob-zoom">
    <canvas class="blob-crop" aria-hidden="true"></canvas>
    <canvas class="blob-bloom" aria-hidden="true"></canvas>
    <canvas class="blob-overlay" aria-hidden="true"></canvas>
  </div>
  <video class="cam" playsinline muted></video>
  <div class="gate">
    <button type="button" class="start">Enter</button>
    <p class="hint">Allows camera and microphone</p>
  </div>
  <div class="preset-flash" aria-live="polite" aria-atomic="true"></div>
  <div class="drop-hint" aria-hidden="true">Drop images</div>
  <nav class="preset-strip" aria-label="Visual presets">
    ${VISUAL_PRESETS.map(
      (p, i) =>
        `<button type="button" class="preset-dot" data-preset="${p.id}" title="${p.name} (${presetHotkeyHint(p, i)})" aria-label="${p.name}">
          <span class="preset-swatch" style="--swatch-a:#${p.startColor.toString(16).padStart(6, '0')};--swatch-b:#${p.endColor.toString(16).padStart(6, '0')}"></span>
          <span class="preset-label">${p.name}</span>
        </button>`,
    ).join('')}
    <button type="button" class="load-image" title="Add images (I)">Add images</button>
    <span class="image-playlist" aria-live="polite" hidden>0 / 0</span>
    <button type="button" class="load-video" title="Load video for Blob (V)">Load video</button>
    <button type="button" class="live-cam" title="Return to live camera (L)" hidden>Live cam</button>
    <button type="button" class="blob-config-btn" title="Look config (C)">Config</button>
    <span class="blob-source" aria-live="polite" hidden></span>
    <input type="file" class="image-file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
    <input type="file" class="video-file" accept="video/*" hidden />
  </nav>
  <aside class="blob-vj-panel" hidden aria-label="Blob VJ config">
    <header class="vj-head">
      <span class="vj-title">Blob config</span>
      <kbd class="vj-kbd">C</kbd>
      <button type="button" class="vj-close" aria-label="Close">×</button>
    </header>
    <section class="vj-section">
      <h3 class="vj-section-title">Detection</h3>
      ${sliderRows(BLOB_DETECTION_SLIDERS, 'blob')}
    </section>
    <section class="vj-section">
      <h3 class="vj-section-title">Look</h3>
      ${sliderRows(BLOB_LOOK_SLIDERS, 'blob')}
      <div class="vj-toggles">${toggleRows()}</div>
    </section>
    <section class="vj-section">
      <h3 class="vj-section-title">Matrix</h3>
      ${sliderRows(BLOB_MATRIX_SLIDERS, 'blob')}
    </section>
    <section class="vj-section">
      <h3 class="vj-section-title">Lens</h3>
      ${sliderRows(BLOB_LENS_SLIDERS, 'blob')}
    </section>
    <footer class="vj-foot">
      <button type="button" class="vj-reset">Reset defaults</button>
    </footer>
  </aside>
`;

const canvas = app.querySelector<HTMLCanvasElement>('.stage')!;
const video = app.querySelector<HTMLVideoElement>('.cam')!;
const gate = app.querySelector<HTMLDivElement>('.gate')!;
const startBtn = app.querySelector<HTMLButtonElement>('.start')!;
const presetStrip = app.querySelector<HTMLElement>('.preset-strip')!;
const presetFlash = app.querySelector<HTMLElement>('.preset-flash')!;
const dropHint = app.querySelector<HTMLElement>('.drop-hint')!;
const loadImageBtn = app.querySelector<HTMLButtonElement>('.load-image')!;
const loadVideoBtn = app.querySelector<HTMLButtonElement>('.load-video')!;
const liveCamBtn = app.querySelector<HTMLButtonElement>('.live-cam')!;
const blobConfigBtn = app.querySelector<HTMLButtonElement>('.blob-config-btn')!;
const blobSourceEl = app.querySelector<HTMLElement>('.blob-source')!;
const imageFileInput = app.querySelector<HTMLInputElement>('.image-file')!;
const videoFileInput = app.querySelector<HTMLInputElement>('.video-file')!;
const imagePlaylistEl = app.querySelector<HTMLElement>('.image-playlist')!;
const blobCrop = app.querySelector<HTMLCanvasElement>('.blob-crop')!;
const blobBloom = app.querySelector<HTMLCanvasElement>('.blob-bloom')!;
const blobOverlay = app.querySelector<HTMLCanvasElement>('.blob-overlay')!;
const blobZoom = app.querySelector<HTMLElement>('.blob-zoom')!;
const blobVjPanel = app.querySelector<HTMLElement>('.blob-vj-panel')!;

const blobFileVideo = document.createElement('video');
blobFileVideo.className = 'blob-file-video';
blobFileVideo.playsInline = true;
blobFileVideo.muted = true;
blobFileVideo.loop = true;
blobFileVideo.hidden = true;
blobZoom.appendChild(blobFileVideo);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setClearColor(0x000000, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const particles = new ReactiveParticleField();
particles.setAutoAdvanceSeconds(8);
scene.add(particles);

const audio = new AudioReactive();
const hands = new HandTracker();
const presence = new PresenceSensor();
const personSeg = new PersonSegmenter();
const blobComp = new BlobCompositor(blobCrop, blobBloom, blobOverlay);

let cameraStream: MediaStream | null = null;
let running = false;
let last = performance.now();
let prevPinch = 0;
let activeHandTouchIds = new Set<string>();
let flashTimer = 0;
let hintTimer = 0;
let dragDepth = 0;
/** Pending Image selection until a file is loaded (keeps prior look visible). */
let awaitingImage = false;
let lastPlaylistUiKey = '';
let blobModeActive = false;
let blobConfigOpen = false;
let blobFileObjectUrl: string | null = null;
let blobFileLabel = '';

function syncPresetUi(id: VisualPresetId): void {
  for (const btn of presetStrip.querySelectorAll<HTMLButtonElement>('.preset-dot')) {
    btn.classList.toggle('is-active', btn.dataset.preset === id);
  }
  const imageActive = id === 'image' || awaitingImage;
  loadImageBtn.classList.toggle('is-emphasis', imageActive);
  app.classList.toggle('is-image-mode', imageActive);
  syncPlaylistUi();
  syncBlobSourceUi();
  syncConfigBtnLabel();
}

function syncPlaylistUi(): void {
  const count = particles.imagePlaylistCount;
  const index = particles.imagePlaylistIndex;
  const key = `${index}/${count}`;
  if (key === lastPlaylistUiKey && count > 0 === !imagePlaylistEl.hidden) {
    return;
  }
  lastPlaylistUiKey = key;
  if (count <= 0) {
    imagePlaylistEl.hidden = true;
    imagePlaylistEl.textContent = '';
    return;
  }
  imagePlaylistEl.hidden = false;
  imagePlaylistEl.textContent = `${index} / ${count}`;
}

function flashPresetName(name: string): void {
  presetFlash.textContent = name;
  presetFlash.classList.remove('is-show');
  void presetFlash.offsetWidth;
  presetFlash.classList.add('is-show');
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    presetFlash.classList.remove('is-show');
  }, 1400);
}

function syncRendererClear(): void {
  const c = particles.clearColor;
  renderer.setClearColor(c, 1);
  document.documentElement.style.backgroundColor = `#${c
    .toString(16)
    .padStart(6, '0')}`;
}

function showDropHint(brief = true): void {
  dropHint.classList.add('is-show');
  dropHint.setAttribute('aria-hidden', 'false');
  window.clearTimeout(hintTimer);
  if (brief) {
    hintTimer = window.setTimeout(() => {
      if (dragDepth === 0) {
        dropHint.classList.remove('is-show');
        dropHint.setAttribute('aria-hidden', 'true');
      }
    }, 2200);
  }
}

function hideDropHint(): void {
  if (dragDepth > 0) return;
  dropHint.classList.remove('is-show');
  dropHint.setAttribute('aria-hidden', 'true');
}

function syncParticlesVisibility(): void {
  const on = !blobModeActive;
  particles.setEnabled(on);
  canvas.style.opacity = on ? '1' : '0';
  canvas.style.pointerEvents = on ? 'auto' : 'none';
}

function syncConfigBtnLabel(): void {
  blobConfigBtn.textContent = blobModeActive ? 'Blob' : 'Config';
}

function syncBlobSourceUi(): void {
  const usingFile = blobFileObjectUrl != null;
  liveCamBtn.hidden = !usingFile;
  loadVideoBtn.classList.toggle('is-emphasis', blobModeActive || usingFile);
  if (usingFile && blobModeActive) {
    blobSourceEl.hidden = false;
    blobSourceEl.textContent = blobFileLabel || 'Video file';
  } else {
    blobSourceEl.hidden = true;
    blobSourceEl.textContent = '';
  }
}

function syncBlobVideoVisibility(): void {
  blobCrop.classList.toggle('blob-crop-visible', blobModeActive);
}

function blobAnalysisVideo(): HTMLVideoElement {
  return blobFileObjectUrl ? blobFileVideo : video;
}

function leaveBlobMode(): void {
  if (!blobModeActive) return;
  blobComp.clear();
  blobComp.resetCrop();
  blobModeActive = false;
  app.classList.remove('is-blob-mode');
  setBlobConfigOpen(false, false);
  syncParticlesVisibility();
  syncBlobVideoVisibility();
  syncConfigBtnLabel();
}

function applyVisualPreset(id: VisualPresetId, announce = true): void {
  if (id === 'image' && !particles.hasLoadedImage) {
    leaveBlobMode();
    awaitingImage = true;
    storePresetId('image');
    syncPresetUi('image');
    if (announce) flashPresetName('Image');
    showDropHint(true);
    openImagePicker();
    return;
  }

  awaitingImage = false;
  const enteringBlob = id === 'blob';

  if (enteringBlob && !blobModeActive) {
    blobComp.tracker.setMirrorX(blobFileObjectUrl == null);
    blobComp.tracker.reset();
    blobComp.resetCrop();
  }
  if (!enteringBlob && blobModeActive) {
    leaveBlobMode();
  }

  blobModeActive = enteringBlob;
  app.classList.toggle('is-blob-mode', enteringBlob);

  if (enteringBlob) {
    syncParticlesVisibility();
    syncBlobVideoVisibility();
    storePresetId('blob');
    syncPresetUi('blob');
    if (announce) flashPresetName('Blob');
    hideDropHint();
    return;
  }

  const preset = particles.applyPreset(id);
  syncParticlesVisibility();
  syncRendererClear();
  storePresetId(preset.id);
  syncPresetUi(preset.id);
  if (announce) flashPresetName(preset.name);
  hideDropHint();
}

function revokeBlobFileUrl(): void {
  if (blobFileObjectUrl) {
    URL.revokeObjectURL(blobFileObjectUrl);
    blobFileObjectUrl = null;
  }
  blobFileLabel = '';
}

async function loadBlobVideoFile(file: File, announce = true): Promise<void> {
  if (!file.type.startsWith('video/')) return;
  revokeBlobFileUrl();
  blobFileObjectUrl = URL.createObjectURL(file);
  blobFileLabel = file.name;
  blobFileVideo.src = blobFileObjectUrl;
  await blobFileVideo.play().catch(() => undefined);
  blobComp.tracker.setMirrorX(false);
  blobComp.tracker.reset();
  if (!blobModeActive) applyVisualPreset('blob', false);
  syncBlobSourceUi();
  if (announce) flashPresetName('Blob video');
}

function returnToLiveCam(announce = true): void {
  revokeBlobFileUrl();
  blobFileVideo.removeAttribute('src');
  blobFileVideo.load();
  blobComp.tracker.setMirrorX(true);
  blobComp.tracker.reset();
  syncBlobSourceUi();
  if (announce) flashPresetName('Live cam');
}

function openVideoPicker(): void {
  videoFileInput.value = '';
  videoFileInput.click();
}

async function ingestImageFiles(files: File[], announce = true): Promise<void> {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (list.length === 0) {
    if (awaitingImage) showDropHint(true);
    return;
  }
  try {
    const added = await particles.loadImages(list, {
      activateFirst: !particles.hasLoadedImage || awaitingImage,
    });
    if (added === 0) {
      showDropHint(true);
      return;
    }
    awaitingImage = false;
    if (blobModeActive) leaveBlobMode();
    storePresetId('image');
    syncPresetUi('image');
    particles.applyPreset('image');
    syncParticlesVisibility();
    syncRendererClear();
    if (announce) {
      const n = particles.imagePlaylistCount;
      flashPresetName(n > 1 ? `Image ${particles.imagePlaylistIndex}/${n}` : 'Image');
    }
    hideDropHint();
  } catch {
    showDropHint(true);
  }
}

function stepPlaylist(dir: 1 | -1): void {
  if (!particles.hasLoadedImage || particles.imagePlaylistCount < 2) return;
  const count = particles.imagePlaylistCount;
  const current = particles.imagePlaylistIndex;
  const nextLabel =
    dir > 0 ? (current % count) + 1 : ((current - 2 + count) % count) + 1;
  const ok = dir > 0 ? particles.nextImage() : particles.prevImage();
  if (!ok) return;
  syncPlaylistUi();
  syncRendererClear();
  flashPresetName(`Image ${nextLabel}/${count}`);
}

function openImagePicker(): void {
  imageFileInput.value = '';
  imageFileInput.click();
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  particles.setSize(w, h);
  blobComp.resize(w, h);
}

function clientToNormalized(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height))),
  };
}

function bindPointer(): void {
  const touchSoft = () =>
    particles.fieldMode === 'image' || particles.fieldMode === 'person' ? 0.7 : 1;
  const onDown = (e: PointerEvent) => {
    if (!running || blobModeActive) return;
    canvas.setPointerCapture(e.pointerId);
    const n = clientToNormalized(e.clientX, e.clientY);
    const soft = touchSoft();
    particles.pulseNormalized(n.x, n.y, 1.2 * soft, `ptr-${e.pointerId}`, {
      mode: 'scatter',
      radius: 0.2,
    });
  };
  const onMove = (e: PointerEvent) => {
    if (!running || blobModeActive || e.buttons === 0) return;
    const n = clientToNormalized(e.clientX, e.clientY);
    const soft = touchSoft();
    particles.holdNormalized(n.x, n.y, 0.9 * soft, `ptr-${e.pointerId}`, {
      mode: 'scatter',
      radius: 0.18,
    });
  };
  const onUp = (e: PointerEvent) => {
    particles.releaseTouch(`ptr-${e.pointerId}`);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
}

function formatVjVal(key: keyof BlobConfig, val: number): string {
  if (Number.isInteger(val) || key === 'threshold' || key === 'minArea' || key === 'maxBlobs' || key === 'morphPasses' || key === 'matrixHue') {
    return String(Math.round(val));
  }
  return val.toFixed(2);
}

function syncBlobPanelInputs(): void {
  const cfg = blobComp.cfg;
  for (const input of blobVjPanel.querySelectorAll<HTMLInputElement>('[data-blob-key]')) {
    const key = input.dataset.blobKey as keyof BlobConfig;
    const val = cfg[key];
    if (typeof val === 'boolean') {
      input.checked = val;
    } else if (typeof val === 'number') {
      input.value = String(val);
      const label = blobVjPanel.querySelector<HTMLElement>(`[data-blob-val="${key}"]`);
      if (label) label.textContent = formatVjVal(key, val);
    }
  }
}

function setBlobConfigOpen(open: boolean, announce = true): void {
  blobConfigOpen = open;
  blobVjPanel.hidden = !open;
  if (open) {
    syncBlobPanelInputs();
    if (announce) flashPresetName('Blob config (C)');
  }
  blobConfigBtn.classList.toggle('is-active', open);
}

function bindConfigPanel(): void {
  blobVjPanel.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.blobKey as keyof BlobConfig | undefined;
    if (!key) return;
    const next = { ...blobComp.cfg } as BlobConfig;
    if (input.type === 'checkbox') {
      (next as Record<string, unknown>)[key] = input.checked;
    } else {
      const n = Number(input.value);
      if (!Number.isFinite(n)) return;
      (next as Record<string, unknown>)[key] = n;
    }
    blobComp.setConfig(next);
    syncBlobPanelInputs();
  });
  blobVjPanel.querySelector('.vj-close')?.addEventListener('click', () => setBlobConfigOpen(false));
  blobVjPanel.querySelector('.vj-reset')?.addEventListener('click', () => {
    blobComp.setConfig({ ...BLOB_CONFIG_DEFAULTS });
    syncBlobPanelInputs();
    flashPresetName('Blob defaults');
  });
}

function bindPresets(): void {
  presetStrip.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.load-image')) {
      openImagePicker();
      return;
    }
    if (t.closest('.load-video')) {
      openVideoPicker();
      return;
    }
    if (t.closest('.live-cam')) {
      returnToLiveCam();
      return;
    }
    if (t.closest('.blob-config-btn')) {
      if (blobModeActive) setBlobConfigOpen(!blobConfigOpen);
      else flashPresetName('Config · Blob mode (8)');
      return;
    }
    const btn = t.closest<HTMLButtonElement>('.preset-dot');
    if (!btn?.dataset.preset) return;
    applyVisualPreset(btn.dataset.preset as VisualPresetId);
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '[' || e.key === 'ArrowLeft') {
      if (particles.hasLoadedImage && particles.imagePlaylistCount > 1 && !blobModeActive) {
        e.preventDefault();
        stepPlaylist(-1);
      }
      return;
    }
    if (e.key === ']' || e.key === 'ArrowRight') {
      if (particles.hasLoadedImage && particles.imagePlaylistCount > 1 && !blobModeActive) {
        e.preventDefault();
        stepPlaylist(1);
      }
      return;
    }

    const k = e.key.toLowerCase();
    if (k === 'i' || k === 'o') {
      e.preventDefault();
      flashPresetName('Add images (I)');
      openImagePicker();
      return;
    }
    if (k === 'v') {
      e.preventDefault();
      flashPresetName('Load video (V)');
      openVideoPicker();
      return;
    }
    if (k === 'l') {
      e.preventDefault();
      returnToLiveCam();
      return;
    }
    if (k === 'c') {
      e.preventDefault();
      if (blobModeActive) setBlobConfigOpen(!blobConfigOpen);
      else flashPresetName('Config · Blob mode (8)');
      return;
    }

    const id = presetIdFromKey(e.key);
    if (!id) return;
    e.preventDefault();
    applyVisualPreset(id);
  });

  imageFileInput.addEventListener('change', () => {
    const files = imageFileInput.files;
    if (files && files.length > 0) void ingestImageFiles(Array.from(files));
  });
  videoFileInput.addEventListener('change', () => {
    const f = videoFileInput.files?.[0];
    if (f) void loadBlobVideoFile(f);
  });
}

function bindDragDrop(): void {
  const hasFiles = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    app.classList.add('is-dragover');
    showDropHint(false);
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e) && dragDepth === 0) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      app.classList.remove('is-dragover');
      if (!awaitingImage) hideDropHint();
    }
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    app.classList.remove('is-dragover');
    const files = Array.from(e.dataTransfer?.files ?? []);
    const images = files.filter((f) => f.type.startsWith('image/'));
    const videos = files.filter((f) => f.type.startsWith('video/'));
    if (images.length > 0) {
      void ingestImageFiles(images);
    } else if (videos.length > 0) {
      void loadBlobVideoFile(videos[0]!);
    } else if (awaitingImage) {
      showDropHint(true);
    } else {
      hideDropHint();
    }
  });
}

/** Map MediaPipe hands → scatter / wind / gather on up to 4 TouchField slots. */
function applyHandVerbs(frame: ReturnType<HandTracker['update']>): void {
  if (blobModeActive) return;
  const keep = new Set<string>();
  const imageSoft =
    particles.fieldMode === 'image' || particles.fieldMode === 'person' ? 0.62 : 1;

  for (const hand of frame.hands) {
    const pinching = hand.pinchStrength > 0.55;

    if (pinching) {
      const gx = (hand.thumb.x + hand.index.x) * 0.5;
      const gy = (hand.thumb.y + hand.index.y) * 0.5;
      const gatherId = `${hand.id}-gather`;
      keep.add(gatherId);
      particles.holdNormalized(
        gx,
        gy,
        (0.55 + hand.pinchStrength * 0.65) * imageSoft,
        gatherId,
        {
          mode: 'gather',
          radius: 0.26 + hand.pinchStrength * 0.08,
        },
      );
    } else {
      const indexId = hand.index.id;
      keep.add(indexId);
      const indexStr =
        (0.7 + hand.index.speed * 0.45 + hand.pinchStrength * 0.15) * imageSoft;
      particles.holdNormalized(hand.index.x, hand.index.y, indexStr, indexId, {
        mode: 'scatter',
        radius: 0.16,
      });

      const palmId = hand.palm.id;
      keep.add(palmId);
      const palmStr = (0.28 + hand.palm.speed * 0.25) * imageSoft;
      particles.holdNormalized(hand.palm.x, hand.palm.y, palmStr, palmId, {
        mode: 'wind',
        radius: 0.4 + Math.min(0.12, hand.palm.speed * 0.08),
      });
    }
  }

  for (const id of activeHandTouchIds) {
    if (!keep.has(id)) particles.releaseTouch(id);
  }
  activeHandTouchIds = keep;

  const pinchEdge = Math.max(0, frame.pinchStrength - prevPinch);
  if (pinchEdge > 0.12) {
    particles.maybeRemixFromSignal(pinchEdge * 0.85);
  }
  prevPinch = frame.pinchStrength;
}

function clearHandTouches(): void {
  for (const id of activeHandTouchIds) particles.releaseTouch(id);
  activeHandTouchIds = new Set();
  prevPinch = 0;
}

async function start(): Promise<void> {
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = cameraStream;
    await video.play();
  } catch {
    startBtn.textContent = 'Camera needed';
    startBtn.disabled = false;
    return;
  }

  try {
    await audio.start();
  } catch {
    /* mic optional — hands / touch still work */
  }

  await hands.init();
  void personSeg.init();

  gate.remove();
  document.body.classList.add('is-live');
  canvas.classList.add('is-live');
  running = true;
  last = performance.now();
  requestAnimationFrame(tick);
}

function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (blobModeActive) {
    const src = blobAnalysisVideo();
    const tracked = src.readyState >= 2 ? blobComp.tracker.update(src, now) : [];
    blobComp.render(src, tracked, dt, blobFileObjectUrl == null);
    return;
  }

  if (audio.isActive) audio.update();

  let handsPresent = false;
  if (hands.isReady && video.readyState >= 2) {
    const frame = hands.update(video, true);
    handsPresent = frame.present;
    if (frame.present) applyHandVerbs(frame);
    else clearHandTouches();
  }

  const presenceState = presence.update(video, dt, handsPresent);
  particles.setPresence(presenceState, presence.energy);

  if (particles.fieldMode === 'person' && video.readyState >= 2) {
    const live = personSeg.sample(video, now);
    if (live) particles.applyPersonSample(live.sample);
  }

  if (audio.isActive) {
    particles.maybeRemixFromSignal(audio.transient * 0.65);
  }

  particles.update(dt, audio.isActive ? audio.frequencyData : null, audio.isActive);

  if (particles.fieldMode === 'image' || particles.fieldMode === 'person') {
    syncPlaylistUi();
    syncRendererClear();
  }

  renderer.render(scene, particles.particleCamera);
}

const stored = loadStoredPresetId();
if (stored === 'image') {
  awaitingImage = true;
  storePresetId('image');
  syncPresetUi('image');
  particles.applyPreset('neon', true);
  renderer.setClearColor(0x000000, 1);
} else if (stored === 'blob') {
  applyVisualPreset('blob', false);
} else {
  applyVisualPreset(stored, false);
}
window.addEventListener('resize', resize);
resize();
bindPointer();
bindPresets();
bindConfigPanel();
bindDragDrop();
startBtn.addEventListener('click', () => void start());
