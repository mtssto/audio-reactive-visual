export type FrequencyBands = {
  low: number;
  mid: number;
  high: number;
};

/**
 * Live microphone → AnalyserNode → smoothed low/mid/high bands
 * (same band layout as the Codrops AudioManager).
 */
export class AudioReactive {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private frequencyArray = new Uint8Array(0);
  private enabled = false;

  frequencyData: FrequencyBands = { low: 0, mid: 0, high: 0 };
  /** Rising-edge transient for mesh remix triggers */
  transient = 0;
  private prevEnergy = 0;

  private lowFrequency = 10;
  private midFrequency = 150;
  private highFrequency = 9000;

  get isActive(): boolean {
    return this.enabled && !!this.analyser;
  }

  async start(): Promise<void> {
    if (this.enabled) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API unsupported');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.75;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    this.frequencyArray = new Uint8Array(this.analyser.frequencyBinCount);

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.enabled = true;
  }

  async stop(): Promise<void> {
    this.enabled = false;
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) {
      await this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.frequencyData = { low: 0, mid: 0, high: 0 };
    this.transient = 0;
  }

  update(): void {
    if (!this.enabled || !this.analyser || !this.ctx) {
      this.frequencyData = { low: 0, mid: 0, high: 0 };
      this.transient = 0;
      return;
    }

    this.analyser.getByteFrequencyData(this.frequencyArray);
    const bufferLength = this.frequencyArray.length;
    const sampleRate = this.ctx.sampleRate;

    const lowStart = Math.floor((this.lowFrequency * bufferLength) / sampleRate);
    const lowEnd = Math.floor((this.midFrequency * bufferLength) / sampleRate);
    const midStart = lowEnd;
    const midEnd = Math.floor((this.highFrequency * bufferLength) / sampleRate);
    const highStart = midEnd;
    const highEnd = bufferLength - 1;

    const low = this.normalize(this.average(lowStart, lowEnd));
    const mid = this.normalize(this.average(midStart, midEnd));
    const high = this.normalize(this.average(highStart, highEnd));

    this.frequencyData = { low, mid, high };

    const energy = low * 0.5 + mid * 0.35 + high * 0.15;
    this.transient = Math.max(0, energy - this.prevEnergy - 0.04);
    this.prevEnergy = this.prevEnergy * 0.85 + energy * 0.15;
  }

  private average(start: number, end: number): number {
    if (end < start) return 0;
    let sum = 0;
    for (let i = start; i <= end; i++) sum += this.frequencyArray[i] ?? 0;
    return sum / (end - start + 1);
  }

  private normalize(value: number): number {
    return value / 256;
  }
}
