interface SpeechGateOptions {
  chunkDurationMs: number;
  minSignalDbfs: number;
  onsetMs: number;
  releaseMs: number;
  prerollMs: number;
  noiseFloorMarginDb: number;
  peakOffsetDb: number;
}

interface ChunkMetrics {
  rmsDbfs: number;
  peakDbfs: number;
}

export interface SpeechGateResult {
  buffers: Buffer[];
  active: boolean;
  metrics: ChunkMetrics;
  thresholdDbfs: number;
  speechLike: boolean;
}

interface BufferedChunk {
  chunk: Buffer;
  durationMs: number;
}

const MIN_DBFS = -120;

export class SpeechGate {
  private readonly prerollBuffer: BufferedChunk[] = [];
  private prerollBufferedMs = 0;
  private active = false;
  private consecutiveSpeechMs = 0;
  private consecutiveSilenceMs = 0;
  private noiseFloorDbfs = MIN_DBFS;

  public constructor(private readonly options: SpeechGateOptions) {}

  public reset(): void {
    this.prerollBuffer.length = 0;
    this.prerollBufferedMs = 0;
    this.active = false;
    this.consecutiveSpeechMs = 0;
    this.consecutiveSilenceMs = 0;
    this.noiseFloorDbfs = MIN_DBFS;
  }

  public processChunk(chunk: Buffer): SpeechGateResult {
    const metrics = this.measureChunk(chunk);
    const thresholdDbfs = this.currentThresholdDbfs();
    const speechLike =
      metrics.rmsDbfs >= thresholdDbfs || metrics.peakDbfs >= thresholdDbfs + this.options.peakOffsetDb;

    if (!this.active) {
      this.updateNoiseFloor(metrics.rmsDbfs, speechLike);
      this.pushPreroll(chunk);

      if (speechLike) {
        this.consecutiveSpeechMs += this.options.chunkDurationMs;
      } else {
        this.consecutiveSpeechMs = 0;
      }

      if (this.consecutiveSpeechMs >= this.options.onsetMs) {
        this.active = true;
        this.consecutiveSilenceMs = 0;
        const buffers = this.flushPreroll();
        return { buffers, active: true, metrics, thresholdDbfs, speechLike };
      }

      return { buffers: [], active: false, metrics, thresholdDbfs, speechLike };
    }

    if (speechLike) {
      this.consecutiveSilenceMs = 0;
    } else {
      this.consecutiveSilenceMs += this.options.chunkDurationMs;
    }

    const buffers = [Buffer.from(chunk)];
    if (this.consecutiveSilenceMs >= this.options.releaseMs) {
      this.active = false;
      this.consecutiveSpeechMs = 0;
      this.consecutiveSilenceMs = 0;
      this.updateNoiseFloor(metrics.rmsDbfs, false);
      this.pushPreroll(chunk);
    }

    return { buffers, active: this.active, metrics, thresholdDbfs, speechLike };
  }

  private currentThresholdDbfs(): number {
    return Math.max(this.options.minSignalDbfs, this.noiseFloorDbfs + this.options.noiseFloorMarginDb);
  }

  private updateNoiseFloor(rmsDbfs: number, speechLike: boolean): void {
    if (speechLike || !Number.isFinite(rmsDbfs)) {
      return;
    }

    if (this.noiseFloorDbfs <= MIN_DBFS + 1) {
      this.noiseFloorDbfs = rmsDbfs;
      return;
    }

    const alpha = 0.08;
    this.noiseFloorDbfs = this.noiseFloorDbfs * (1 - alpha) + rmsDbfs * alpha;
  }

  private pushPreroll(chunk: Buffer): void {
    const durationMs = this.options.chunkDurationMs;
    this.prerollBuffer.push({ chunk: Buffer.from(chunk), durationMs });
    this.prerollBufferedMs += durationMs;

    while (this.prerollBufferedMs > this.options.prerollMs && this.prerollBuffer.length > 0) {
      const dropped = this.prerollBuffer.shift();
      this.prerollBufferedMs -= dropped?.durationMs ?? 0;
    }
  }

  private flushPreroll(): Buffer[] {
    const buffers = this.prerollBuffer.map((entry) => Buffer.from(entry.chunk));
    this.prerollBuffer.length = 0;
    this.prerollBufferedMs = 0;
    return buffers;
  }

  private measureChunk(chunk: Buffer): ChunkMetrics {
    if (chunk.length < 2) {
      return { rmsDbfs: MIN_DBFS, peakDbfs: MIN_DBFS };
    }

    let sumSquares = 0;
    let peak = 0;
    let sampleCount = 0;

    for (let index = 0; index + 1 < chunk.length; index += 2) {
      const sample = chunk.readInt16LE(index) / 32768;
      const abs = Math.abs(sample);
      sumSquares += sample * sample;
      if (abs > peak) {
        peak = abs;
      }
      sampleCount += 1;
    }

    if (sampleCount === 0) {
      return { rmsDbfs: MIN_DBFS, peakDbfs: MIN_DBFS };
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    return {
      rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : MIN_DBFS,
      peakDbfs: peak > 0 ? 20 * Math.log10(peak) : MIN_DBFS
    };
  }
}
