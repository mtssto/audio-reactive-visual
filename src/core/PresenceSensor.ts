export type PresenceState = 'idle' | 'awakening' | 'present' | 'leaving';

/**
 * Lightweight frame-diff occupancy on a downscaled camera frame.
 * Drives installation presence: idle → awakening → present → leaving → idle.
 */
export class PresenceSensor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private prev: Float32Array | null = null;
  private occupancy = 0;
  private state: PresenceState = 'idle';
  private stateAge = 0;
  private presentHold = 0;
  private absentHold = 0;

  /** Smoothed 0–1 motion occupancy. */
  get level(): number {
    return this.occupancy;
  }

  get current(): PresenceState {
    return this.state;
  }

  /** 0 idle → 1 fully present (includes awakening / leaving ramps). */
  get energy(): number {
    switch (this.state) {
      case 'idle':
        return 0;
      case 'awakening':
        return Math.min(1, this.stateAge / 2.4);
      case 'present':
        return 1;
      case 'leaving':
        return Math.max(0, 1 - this.stateAge / 2.1);
      default:
        return 0;
    }
  }

  constructor(width = 64, height = 36) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d', {
      willReadFrequently: true,
    });
    if (!ctx) throw new Error('PresenceSensor: 2d context unavailable');
    this.ctx = ctx;
  }

  /**
   * @param video Camera feed
   * @param dt Seconds
   * @param forcedPresent Extra signal (e.g. MediaPipe hands) that counts as occupancy
   */
  update(
    video: HTMLVideoElement,
    dt: number,
    forcedPresent = false,
  ): PresenceState {
    this.stateAge += dt;

    let frameOcc = 0;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      frameOcc = this.sampleOccupancy(video);
    }

    const target = Math.max(frameOcc, forcedPresent ? 0.55 : 0);
    this.occupancy += (target - this.occupancy) * Math.min(1, dt * 4.5);

    const enter = this.occupancy > 0.12 || forcedPresent;
    const leave = this.occupancy < 0.06 && !forcedPresent;

    if (enter) {
      this.presentHold += dt;
      this.absentHold = 0;
    } else if (leave) {
      this.absentHold += dt;
      this.presentHold = 0;
    } else {
      this.presentHold *= 0.9;
      this.absentHold *= 0.9;
    }

    switch (this.state) {
      case 'idle':
        if (this.presentHold > 0.18) this.enter('awakening');
        break;
      case 'awakening':
        if (this.absentHold > 0.45) this.enter('leaving');
        else if (this.stateAge >= 2.4) this.enter('present');
        break;
      case 'present':
        if (this.absentHold > 0.55) this.enter('leaving');
        break;
      case 'leaving':
        if (this.presentHold > 0.2) this.enter('awakening');
        else if (this.stateAge >= 2.1) this.enter('idle');
        break;
    }

    return this.state;
  }

  reset(): void {
    this.prev = null;
    this.occupancy = 0;
    this.enter('idle');
  }

  private enter(next: PresenceState): void {
    this.state = next;
    this.stateAge = 0;
  }

  private sampleOccupancy(video: HTMLVideoElement): number {
    const { width, height } = this.canvas;
    this.ctx.drawImage(video, 0, 0, width, height);
    const { data } = this.ctx.getImageData(0, 0, width, height);
    const n = width * height;
    const luma = new Float32Array(n);

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      luma[i] =
        data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114;
    }

    if (!this.prev || this.prev.length !== n) {
      this.prev = luma;
      return 0;
    }

    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(luma[i]! - this.prev[i]!) > 18) changed++;
    }
    this.prev = luma;

    // Typical visitor motion lands ~0.08–0.4 of pixels
    return Math.min(1, changed / (n * 0.22));
  }
}
