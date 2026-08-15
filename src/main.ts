import './style.css';
import {
  CONFIG_DEFAULTS,
  LOOK_SLIDERS,
  loadConfig,
  normalizeConfig,
  saveConfig,
  type ForestConfig,
} from './config/Config';
import { ForestBackground } from './background/ForestBackground';
import { BloomEffect } from './effects/Bloom';
import { GrowthSystem } from './growth/GrowthSystem';
import { SceneManager } from './scene/SceneManager';

/**
 * Standalone bioluminescent forest installation.
 * Space colonization growth + full-screen photo background + restrained bloom.
 * No particles, blob, MediaPipe, or audio.
 */

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <canvas class="stage" aria-label="Bioluminescent forest"></canvas>
  <div class="hint" aria-live="polite">Drop a forest photo · I load · R reset · F fit · D orbit</div>
  <div class="drop-overlay" hidden>Drop image to load</div>
  <aside class="panel" aria-label="Look controls">
    <header class="panel-head">
      <h1>Forest</h1>
      <button type="button" class="panel-toggle" title="Toggle panel">·</button>
    </header>
    <div class="panel-body">
      ${LOOK_SLIDERS.map(
        (s) => `
      <label class="row">
        <span class="label">${s.label}</span>
        <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
        <span class="val" data-val="${s.key}"></span>
      </label>`,
      ).join('')}
      <div class="actions">
        <button type="button" data-action="load">Load image</button>
        <button type="button" data-action="reset">Reset growth</button>
      </div>
      <p class="keys">I image · R reset · F fit · D orbit debug</p>
    </div>
  </aside>
`;

const canvas = app.querySelector<HTMLCanvasElement>('.stage')!;
const hintEl = app.querySelector<HTMLDivElement>('.hint')!;
const dropOverlay = app.querySelector<HTMLDivElement>('.drop-overlay')!;
const panel = app.querySelector<HTMLElement>('.panel')!;
const panelBody = app.querySelector<HTMLElement>('.panel-body')!;

let cfg = loadConfig();
let sceneMgr: SceneManager | null = null;
let background: ForestBackground | null = null;
let bloom: BloomEffect | null = null;
let growth: GrowthSystem | null = null;
let raf = 0;
let running = false;

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'image/*';
fileInput.hidden = true;
app.appendChild(fileInput);

function setHint(msg: string): void {
  hintEl.textContent = msg;
}

function applyLook(): void {
  background?.setDim(cfg.backgroundDim);
  background?.setDesat(cfg.backgroundDesat);
  background?.setHazeStrength(cfg.hazeStrength);
  bloom?.setStrength(cfg.bloomStrength);
  syncSliders();
}

function syncSliders(): void {
  for (const s of LOOK_SLIDERS) {
    const input = app.querySelector<HTMLInputElement>(`input[data-key="${s.key}"]`);
    const val = app.querySelector<HTMLElement>(`[data-val="${s.key}"]`);
    if (!input || !val) continue;
    const v = cfg[s.key];
    input.value = String(v);
    val.textContent = s.step < 1 ? v.toFixed(2) : String(Math.round(v));
  }
}

function setConfig(partial: Partial<ForestConfig>, persist = true): void {
  cfg = normalizeConfig({ ...cfg, ...partial });
  if (persist) saveConfig(cfg);
  applyLook();
  growth?.setConfig(cfg);
}

function resize(): void {
  if (!sceneMgr || !bloom || !background) return;
  const w = app.clientWidth;
  const h = app.clientHeight;
  sceneMgr.resize(w, h);
  background.layout(sceneMgr.camera, w, h);
  bloom.setSize(w, h);
}

async function loadImageFile(file: File): Promise<void> {
  if (!background || !file.type.startsWith('image/')) return;
  await background.setImageFromFile(file);
  setHint(`Loaded ${file.name}`);
}

function resetGrowth(): void {
  growth?.reset();
  setHint('Growth reset');
}

function toggleOrbit(): void {
  if (!sceneMgr) return;
  const on = sceneMgr.toggleDebugOrbit();
  setHint(on ? 'Orbit debug ON' : 'Orbit debug OFF');
}

function toggleFit(): void {
  if (!background) return;
  const next = background.getFit() === 'cover' ? 'contain' : 'cover';
  background.setFit(next);
  setHint(`Fit: ${next}`);
}

const loop = (): void => {
  if (!running || !sceneMgr || !bloom || !growth || !background) return;
  raf = requestAnimationFrame(loop);
  const dt = sceneMgr.tick();
  growth.setConfig(cfg);
  growth.update(dt);
  background.update(sceneMgr.getElapsed());
  background.setContactGlow(growth.getContactGlow() * 0.85);
  sceneMgr.updateControls();
  bloom.setStrength(cfg.bloomStrength);
  bloom.render();
};

function start(): void {
  if (running) return;
  running = true;

  sceneMgr = new SceneManager({ canvas });
  background = new ForestBackground(sceneMgr.camera);
  growth = new GrowthSystem(cfg);
  sceneMgr.scene.add(growth.group);
  bloom = new BloomEffect(
    sceneMgr.renderer,
    sceneMgr.scene,
    sceneMgr.camera,
    cfg.bloomStrength,
  );

  applyLook();
  resize();
  loop();
  setHint('Drop a forest photo · I load · R reset · F fit · D orbit');
}

// —— UI wiring ——

for (const s of LOOK_SLIDERS) {
  const input = app.querySelector<HTMLInputElement>(`input[data-key="${s.key}"]`);
  input?.addEventListener('input', () => {
    const v = Number(input.value);
    setConfig({ [s.key]: v } as Partial<ForestConfig>);
  });
}

app.querySelector('.panel-toggle')?.addEventListener('click', () => {
  panel.classList.toggle('collapsed');
  panelBody.hidden = panel.classList.contains('collapsed');
});

app.querySelector('[data-action="load"]')?.addEventListener('click', () => fileInput.click());
app.querySelector('[data-action="reset"]')?.addEventListener('click', () => resetGrowth());

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadImageFile(f);
  fileInput.value = '';
});

window.addEventListener('resize', () => resize());

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const k = e.key.toLowerCase();
  if (k === 'i') {
    e.preventDefault();
    fileInput.click();
  } else if (k === 'r') {
    e.preventDefault();
    resetGrowth();
  } else if (k === 'f') {
    e.preventDefault();
    toggleFit();
  } else if (k === 'd') {
    e.preventDefault();
    toggleOrbit();
  } else if (k === 'escape') {
    panel.classList.toggle('collapsed');
    panelBody.hidden = panel.classList.contains('collapsed');
  }
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadImageFile(f);
});

// Double-click panel head resets look defaults
app.querySelector('.panel-head')?.addEventListener('dblclick', () => {
  setConfig({ ...CONFIG_DEFAULTS });
  setHint('Look defaults restored');
});

start();
