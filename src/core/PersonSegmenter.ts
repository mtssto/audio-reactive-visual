import {
  FilesetResolver,
  ImageSegmenter,
} from '@mediapipe/tasks-vision';
import {
  sampleImageToParticles,
  type ImageParticleSample,
  type PersonMask,
} from '../render/particles/sampleImageParticles';

const WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm';
/** Landscape selfie model — efficient for typical webcam aspect. */
const SELFIE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite';

/** Target interval between live person samples (ms). */
const SAMPLE_INTERVAL_MS = 140;

export type PersonSampleMeta = {
  sample: ImageParticleSample;
  /** True when MediaPipe selfie mask was applied. */
  segmented: boolean;
};

/**
 * Live webcam → particle cloud for Person preset.
 * Prefers MediaPipe selfie segmentation; falls back to throttled mirrored
 * frame sampling (dark-pixel skip) so the silhouette still reads.
 */
export class PersonSegmenter {
  private segmenter: ImageSegmenter | null = null;
  private ready = false;
  private failed = false;
  private loadPromise: Promise<boolean> | null = null;
  private lastSampleAt = 0;
  private lastTimestamp = -1;
  private segmented = false;

  get isReady(): boolean {
    return this.ready;
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  /** Whether the last successful sample used a person mask. */
  get usesSegmentation(): boolean {
    return this.segmented && this.ready && !this.failed;
  }

  async init(): Promise<boolean> {
    if (this.ready) return true;
    if (this.failed) return false;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
        this.segmenter = await ImageSegmenter.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: SELFIE_MODEL_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
        this.ready = true;
        this.failed = false;
        return true;
      } catch {
        this.failed = true;
        this.ready = false;
        this.segmenter = null;
        return false;
      }
    })();

    return this.loadPromise;
  }

  /**
   * Throttled sample of the live camera. Returns null when skipped / empty.
   */
  sample(video: HTMLVideoElement, now = performance.now()): PersonSampleMeta | null {
    if (video.readyState < 2 || video.videoWidth === 0) return null;
    if (now - this.lastSampleAt < SAMPLE_INTERVAL_MS) return null;
    this.lastSampleAt = now;

    let mask: PersonMask | null = null;
    if (this.ready && this.segmenter) {
      mask = this.readConfidenceMask(video, now);
    }

    const segmented = mask != null;
    this.segmented = segmented;

    const sample = sampleImageToParticles(video, {
      maxSide: 260,
      maxParticles: 32000,
      planeHalfWidth: 5.0,
      planeMaxHalfHeight: 3.7,
      skipWhiteAbove: 1,
      exposure: 1.38,
      mirrorX: true,
      personMask: mask,
      // Fallback: drop near-black so room walls don't fill the cloud
      minLuminance: segmented ? 0.02 : 0.07,
    });

    if (sample.count < 24) return null;
    return { sample, segmented };
  }

  dispose(): void {
    this.segmenter?.close();
    this.segmenter = null;
    this.ready = false;
  }

  private readConfidenceMask(
    video: HTMLVideoElement,
    now: number,
  ): PersonMask | null {
    if (!this.segmenter) return null;

    // MediaPipe requires strictly increasing timestamps
    const ts = now <= this.lastTimestamp ? this.lastTimestamp + 1 : now;
    this.lastTimestamp = ts;

    try {
      const result = this.segmenter.segmentForVideo(video, ts);
      const masks = result.confidenceMasks;
      // Selfie models: 0 = background, 1 = person (prefer person mask)
      const conf =
        masks && masks.length > 1 ? masks[1]! : masks?.[0] ?? null;
      if (!conf) {
        result.close();
        return null;
      }
      const data = conf.getAsFloat32Array().slice();
      const width = conf.width;
      const height = conf.height;
      // Close all masks / result to free GPU resources
      for (const m of masks ?? []) m.close();
      result.categoryMask?.close();
      result.close();
      if (!width || !height || data.length < width * height) return null;
      return { data, width, height, threshold: 0.45 };
    } catch {
      return null;
    }
  }
}
