import * as THREE from 'three';
import './style.css';
import { AudioReactive } from './audio/AudioReactive';
import { HandTracker } from './core/HandTracker';
import { ReactiveParticleField } from './render/particles/ReactiveParticleField';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <canvas class="stage"></canvas>
  <video class="cam" playsinline muted></video>
  <div class="gate">
    <button type="button" class="start">Click to start</button>
    <p class="hint">Camera + mic · touch the particles · move your hands</p>
  </div>
  <p class="status"></p>
`;

const canvas = app.querySelector<HTMLCanvasElement>('.stage')!;
const video = app.querySelector<HTMLVideoElement>('.cam')!;
const gate = app.querySelector<HTMLDivElement>('.gate')!;
const startBtn = app.querySelector<HTMLButtonElement>('.start')!;
const statusEl = app.querySelector<HTMLParagraphElement>('.status')!;

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
scene.add(particles);

const audio = new AudioReactive();
const hands = new HandTracker();

let cameraStream: MediaStream | null = null;
let running = false;
let last = performance.now();

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  particles.setSize(w, h);
}

function clientToNormalized(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height))),
  };
}

function bindPointer(): void {
  const onDown = (e: PointerEvent) => {
    if (!running) return;
    canvas.setPointerCapture(e.pointerId);
    const n = clientToNormalized(e.clientX, e.clientY);
    particles.pulseNormalized(n.x, n.y, 1.2, `ptr-${e.pointerId}`);
  };
  const onMove = (e: PointerEvent) => {
    if (!running || e.buttons === 0) return;
    const n = clientToNormalized(e.clientX, e.clientY);
    particles.holdNormalized(n.x, n.y, 0.9, `ptr-${e.pointerId}`);
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

async function start(): Promise<void> {
  startBtn.disabled = true;
  setStatus('Requesting camera + mic…');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = cameraStream;
    await video.play();
  } catch {
    setStatus('Camera permission denied');
    startBtn.disabled = false;
    return;
  }

  try {
    await audio.start();
  } catch {
    setStatus('Mic denied · particles still run with hands / touch');
  }

  const handsOk = await hands.init();
  if (!handsOk) {
    setStatus('Hands unavailable · use touch + mic');
  } else {
    setStatus('Live · touch · hands · mic');
  }

  gate.remove();
  running = true;
  last = performance.now();
  requestAnimationFrame(tick);
}

function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (audio.isActive) audio.update();

  if (hands.isReady && video.readyState >= 2) {
    const frame = hands.update(video, true);
    if (frame.present) {
      for (const tip of frame.tips) {
        if (tip.kind !== 'index' && tip.kind !== 'thumb') continue;
        const strength = 0.55 + tip.speed * 0.35 + frame.pinchStrength * 0.4;
        particles.holdNormalized(tip.x, tip.y, strength, tip.id);
      }
      particles.maybeRemixFromSignal(frame.pinchStrength * 0.2);
    }
  }

  if (audio.isActive) {
    particles.maybeRemixFromSignal(audio.transient);
  }

  particles.update(
    dt,
    audio.isActive ? audio.frequencyData : null,
    audio.isActive,
  );

  renderer.render(scene, particles.particleCamera);
}

window.addEventListener('resize', resize);
resize();
bindPointer();
startBtn.addEventListener('click', () => void start());

setStatus('Click to enable camera + microphone');
