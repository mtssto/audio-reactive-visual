import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

export type HandTip = {
  id: string;
  kind: 'index' | 'thumb' | 'middle' | 'palm' | 'wrist';
  /** Normalized image coords 0–1 */
  x: number;
  y: number;
  confidence: number;
  speed: number;
};

/** One tracked hand with gesture strengths for installation verbs. */
export type TrackedHand = {
  id: string;
  index: HandTip;
  thumb: HandTip;
  palm: HandTip;
  /** 0 open → 1 pinched */
  pinchStrength: number;
};

export type HandFrame = {
  tips: HandTip[];
  hands: TrackedHand[];
  pinchStrength: number;
  present: boolean;
};

const WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** MediaPipe HandLandmarker over a video element. */
export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private ready = false;
  private failed = false;
  private prevTips = new Map<string, { x: number; y: number }>();
  private loadPromise: Promise<boolean> | null = null;

  get isReady(): boolean {
    return this.ready;
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  async init(): Promise<boolean> {
    if (this.ready) return true;
    if (this.failed) return false;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
        this.landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        this.ready = true;
        return true;
      } catch {
        this.failed = true;
        this.ready = false;
        this.landmarker = null;
        return false;
      }
    })();

    return this.loadPromise;
  }

  update(video: HTMLVideoElement, mirrorX = true): HandFrame {
    if (
      !this.ready ||
      !this.landmarker ||
      video.readyState < 2 ||
      video.videoWidth === 0
    ) {
      return { tips: [], hands: [], pinchStrength: 0, present: false };
    }

    let result;
    try {
      result = this.landmarker.detectForVideo(video, performance.now());
    } catch {
      return { tips: [], hands: [], pinchStrength: 0, present: false };
    }

    const tips: HandTip[] = [];
    const tracked: TrackedHand[] = [];
    let pinchStrength = 0;

    const hands = result.landmarks ?? [];
    for (let h = 0; h < hands.length; h++) {
      const lm = hands[h];
      if (!lm) continue;

      const thumb = this.mapTip(lm, 4, `h${h}-thumb`, 'thumb', mirrorX);
      const index = this.mapTip(lm, 8, `h${h}-index`, 'index', mirrorX);
      const middle = this.mapTip(lm, 12, `h${h}-middle`, 'middle', mirrorX);
      const palm = this.palmCenter(lm, `h${h}-palm`, mirrorX);
      const wrist = this.mapTip(lm, 0, `h${h}-wrist`, 'wrist', mirrorX);

      tips.push(wrist, thumb, index, middle, palm);

      const pinchDist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
      const handPinch = 1 - Math.min(1, pinchDist / 0.12);
      pinchStrength = Math.max(pinchStrength, handPinch);

      tracked.push({
        id: `h${h}`,
        index,
        thumb,
        palm,
        pinchStrength: handPinch,
      });
    }

    return {
      tips,
      hands: tracked,
      pinchStrength,
      present: tracked.length > 0,
    };
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.ready = false;
  }

  private mapTip(
    lm: NormalizedLandmark[],
    index: number,
    id: string,
    kind: HandTip['kind'],
    mirrorX: boolean,
  ): HandTip {
    const p = lm[index];
    let x = p?.x ?? 0.5;
    const y = p?.y ?? 0.5;
    if (mirrorX) x = 1 - x;

    const prev = this.prevTips.get(id);
    const speed = prev ? Math.hypot(x - prev.x, y - prev.y) * 40 : 0;
    this.prevTips.set(id, { x, y });

    return { id, kind, x, y, confidence: 0.85, speed };
  }

  private palmCenter(
    lm: NormalizedLandmark[],
    id: string,
    mirrorX: boolean,
  ): HandTip {
    const idxs = [0, 5, 9, 13];
    let x = 0;
    let y = 0;
    for (const i of idxs) {
      x += lm[i]?.x ?? 0.5;
      y += lm[i]?.y ?? 0.5;
    }
    x /= idxs.length;
    y /= idxs.length;
    if (mirrorX) x = 1 - x;

    const prev = this.prevTips.get(id);
    const speed = prev ? Math.hypot(x - prev.x, y - prev.y) * 40 : 0;
    this.prevTips.set(id, { x, y });

    return { id, kind: 'palm', x, y, confidence: 0.8, speed };
  }
}
