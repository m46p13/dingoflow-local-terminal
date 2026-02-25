interface SliceLatencySample {
  queueMs: number;
  audioMs: number;
  asrMs: number;
  injectMs: number;
  endToEndMs: number;
}

interface PercentileSummary {
  p50: number;
  p95: number;
  max: number;
  avg: number;
}

export interface LatencySummary {
  slices: number;
  queueMs: PercentileSummary;
  asrMs: PercentileSummary;
  injectMs: PercentileSummary;
  endToEndMs: PercentileSummary;
}

const asSummary = (values: number[]): PercentileSummary => {
  if (values.length === 0) {
    return { p50: 0, p95: 0, max: 0, avg: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const pick = (pct: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
    return sorted[index];
  };
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    p50: Math.round(pick(0.5)),
    p95: Math.round(pick(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
    avg: Math.round(total / sorted.length)
  };
};

export class LatencyTracker {
  private slices: SliceLatencySample[] = [];

  public reset(): void {
    this.slices = [];
  }

  public push(sample: SliceLatencySample): void {
    this.slices.push(sample);
  }

  public summarize(): LatencySummary {
    return {
      slices: this.slices.length,
      queueMs: asSummary(this.slices.map((sample) => sample.queueMs)),
      asrMs: asSummary(this.slices.map((sample) => sample.asrMs)),
      injectMs: asSummary(this.slices.map((sample) => sample.injectMs)),
      endToEndMs: asSummary(this.slices.map((sample) => sample.endToEndMs))
    };
  }
}
